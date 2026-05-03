const express = require("express");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requireDeliveryKycVerified } = require("../middleware/deliveryKyc");
const { formatOrder, formatDeliveryPublic, formatDeliveryPrivate } = require("../lib/format");
const Seller = require("../models/Seller");
const {
  expireStaleDeliveryRequests,
  canTransition,
  ACTIVE_POOL,
} = require("../lib/delivery");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/** Buyer, seller, assigned driver, or admin — no delivery KYC required. */
router.get("/track/:orderId", requireAuth, async (req, res, next) => {
  try {
    await expireStaleDeliveryRequests(Order);
    const oid = req.params.orderId;
    if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");

    const order = await Order.findById(oid).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    const role = req.user.role;
    const uid = req.user.id;

    const isBuyer = String(order.user) === String(uid);
    const isDriver =
      role === "delivery" && order.delivery?.driver && String(order.delivery.driver) === String(uid);
    const isAdmin = role === "admin";

    let isSeller = false;
    if (role === "seller") {
      const seller = await Seller.findOne({ user: uid }).lean();
      isSeller = Boolean(seller && String(seller._id) === String(order.seller));
    }

    if (!isBuyer && !isSeller && !isDriver && !isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const deliveryView = formatDeliveryPrivate(order.delivery);

    return res.json({
      order_id: String(order._id),
      payment_status: order.paymentStatus,
      order_status: order.orderStatus,
      delivery: deliveryView,
      driver_last_lat: order.delivery?.driverLastLat ?? null,
      driver_last_lng: order.delivery?.driverLastLng ?? null,
      driver_location_at: order.delivery?.driverLocationAt || null,
    });
  } catch (err) {
    return next(err);
  }
});

/** Delivery partner: KYC / onboarding status (works before verification is complete). */
router.get("/onboarding-status", requireAuth, requireRole("delivery"), async (req, res, next) => {
  try {
    const u = await User.findById(req.user.id).lean();
    if (!u) return res.status(404).json({ error: "User not found" });
    return res.json({
      email_verified: Boolean(u.emailVerifiedAt),
      kyc_status: u.deliveryKyc?.status || "not_started",
      rejected_reason: u.deliveryKyc?.rejectedReason || "",
    });
  } catch (err) {
    return next(err);
  }
});

router.use(requireAuth, requireRole("delivery"), requireDeliveryKycVerified);

/** Orders currently assigned to this driver (in-progress delivery). */
router.get("/assignments", async (req, res, next) => {
  try {
    await expireStaleDeliveryRequests(Order);
    const me = req.user.id;
    const activeStatuses = [
      "delivery_assigned",
      "driver_en_route_pickup",
      "picked_up",
      "en_route_dropoff",
    ];
    const rows = await Order.find({
      paymentStatus: "paid",
      "delivery.driver": me,
      "delivery.status": { $in: activeStatuses },
    })
      .sort({ "delivery.assignedAt": -1 })
      .limit(25)
      .lean();

    const out = rows.map((o) => ({
      order: formatOrder(o),
      delivery: formatDeliveryPrivate(o.delivery),
    }));

    return res.json({ items: out });
  } catch (err) {
    return next(err);
  }
});

router.get("/jobs", async (req, res, next) => {
  try {
    await expireStaleDeliveryRequests(Order);
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.status(404).json({ error: "User not found" });
    const region = String(me.region || "").trim();
    const city = String(me.city || "").trim();

    const filter = {
      paymentStatus: "paid",
      "delivery.status": ACTIVE_POOL,
      "delivery.claimExpiresAt": { $gt: new Date() },
    };
    if (req.query.all !== "1" && region) {
      filter.$or = [
        { "delivery.dropoffRegion": region },
        { "delivery.dropoffRegion": "" },
        { "delivery.dropoffRegion": { $exists: false } },
      ];
    }

    const rows = await Order.find(filter).sort({ "delivery.requestedAt": 1 }).limit(80).lean();

    const out = rows
      .filter((o) => {
        if (!city && !region) return true;
        const dr = o.delivery?.dropoffRegion;
        const dc = o.delivery?.dropoffCity;
        if (req.query.strict === "1" && region && dr && dr !== region) return false;
        if (req.query.strict === "1" && city && dc && dc !== city) return false;
        return true;
      })
      .map((o) => ({
        order: formatOrder(o),
        delivery: formatDeliveryPublic(o.delivery),
      }));

    return res.json({ items: out });
  } catch (err) {
    return next(err);
  }
});

router.post("/jobs/:orderId/claim", async (req, res, next) => {
  try {
    await expireStaleDeliveryRequests(Order);
    const oid = req.params.orderId;
    if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");

    const now = new Date();
    const updated = await Order.findOneAndUpdate(
      {
        _id: oid,
        paymentStatus: "paid",
        "delivery.status": ACTIVE_POOL,
        "delivery.claimExpiresAt": { $gt: now },
        "delivery.driver": null,
      },
      {
        $set: {
          "delivery.status": "delivery_assigned",
          "delivery.driver": req.user.id,
          "delivery.assignedAt": now,
        },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({ error: "Job unavailable or already claimed" });
    }
    return res.json({ order: formatOrder(updated), delivery: formatDeliveryPrivate(updated.delivery) });
  } catch (err) {
    return next(err);
  }
});

router.patch("/jobs/:orderId/status", async (req, res, next) => {
  try {
    const oid = req.params.orderId;
    if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");
    const { status: nextStatus } = req.body || {};
    if (!nextStatus) return badRequest(res, "status is required");

    const order = await Order.findById(oid);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.delivery?.driver || String(order.delivery.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: "Not assigned to this order" });
    }

    const cur = order.delivery.status;
    if (!canTransition(cur, nextStatus)) {
      return badRequest(res, `Cannot go from ${cur} to ${nextStatus}`);
    }

    if (nextStatus === "picked_up" && !order.delivery.readyForPickupAt) {
      return badRequest(res, "Shopkeeper must mark ready for pickup before pickup");
    }

    order.delivery.status = nextStatus;
    const now = new Date();
    if (nextStatus === "picked_up") order.delivery.pickedUpAt = now;
    if (nextStatus === "delivered") {
      order.delivery.deliveredAt = now;
      if (order.orderStatus !== "delivered") order.orderStatus = "delivered";
    }
    await order.save();

    return res.json({ order: formatOrder(order), delivery: formatDeliveryPrivate(order.delivery) });
  } catch (err) {
    return next(err);
  }
});

router.post("/jobs/:orderId/location", async (req, res, next) => {
  try {
    const oid = req.params.orderId;
    if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return badRequest(res, "lat and lng must be numbers");
    }

    const order = await Order.findById(oid);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.delivery?.driver || String(order.delivery.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: "Not assigned to this order" });
    }

    const allowed = ["delivery_assigned", "driver_en_route_pickup", "picked_up", "en_route_dropoff"];
    if (!allowed.includes(order.delivery.status)) {
      return badRequest(res, "Location updates not accepted in current delivery status");
    }

    order.delivery.driverLastLat = lat;
    order.delivery.driverLastLng = lng;
    order.delivery.driverLocationAt = new Date();
    await order.save();

    return res.json({ ok: true, driver_location_at: order.delivery.driverLocationAt });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
