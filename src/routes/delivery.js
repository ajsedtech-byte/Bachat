const express = require("express");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requireDeliveryKycVerified } = require("../middleware/deliveryKyc");
const { formatOrder, formatDeliveryPublic, formatDeliveryPrivate } = require("../lib/format");
const Seller = require("../models/Seller");
const { sendMail } = require("../services/email");
const { generateSixDigitCode, hashOtp, verifyOtp } = require("../utils/otp");
const {
  expireStaleDeliveryRequests,
  canTransition,
  ACTIVE_POOL,
} = require("../lib/delivery");
const { inIndiaBounds, haversineKm, etaMinutes } = require("../lib/location");

const router = express.Router();
const driverGpsRateWindow = new Map();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactCiRegex(value) {
  return new RegExp(`^${escapeRegExp(String(value || "").trim())}$`, "i");
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
}

function placeIssue(label, place) {
  if (!place || place.lat == null || place.lng == null) {
    return `${label} GPS is missing`;
  }
  if (!inIndiaBounds(place.lat, place.lng)) {
    return `${label} GPS is outside the supported area`;
  }
  if (!String(place.addressText || place.address || "").trim()) {
    return `${label} address is missing`;
  }
  return "";
}

function pendingDeliveryReason(order) {
  const d = order?.delivery || {};
  const pickupIssue = placeIssue("Shop pickup", d.pickup);
  const dropoffIssue = placeIssue("Customer drop-off", d.dropoff);
  if (pickupIssue && dropoffIssue) return `${pickupIssue}; ${dropoffIssue}`;
  return pickupIssue || dropoffIssue || "Waiting for delivery request";
}

function stageAlias(s) {
  const m = {
    delivery_assigned: "assigned",
    driver_en_route_pickup: "heading_to_pickup",
    picked_up: "picked_up",
    en_route_dropoff: "heading_to_drop",
    delivered: "delivered",
  };
  return m[s] || s || "assigned";
}

function gpsRateLimitExceeded(driverId, orderId) {
  const windowMs = Math.max(1000, Number(process.env.DELIVERY_GPS_RATE_WINDOW_MS || 10000));
  const maxHits = Math.max(1, Number(process.env.DELIVERY_GPS_RATE_MAX_HITS || 4));
  const now = Date.now();
  const key = `${String(driverId)}:${String(orderId)}`;
  const arr = (driverGpsRateWindow.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  driverGpsRateWindow.set(key, arr);
  return arr.length > maxHits;
}

function otpExpiryMinutes() {
  const raw = Number(process.env.DELIVERY_OTP_EXPIRY_MINUTES || 30);
  return Math.max(5, Math.min(120, Number.isFinite(raw) ? raw : 30));
}

async function sendDeliveryOtp(order) {
  if (!order || !order.user) return false;
  const buyer = await User.findById(order.user).select("name email").lean();
  if (!buyer || !buyer.email) return false;
  const code = generateSixDigitCode();
  const minutes = otpExpiryMinutes();
  order.delivery.deliveryOtpHash = await hashOtp(code);
  order.delivery.deliveryOtpSentAt = new Date();
  order.delivery.deliveryOtpExpiresAt = new Date(Date.now() + minutes * 60 * 1000);
  order.delivery.deliveryOtpVerifiedAt = null;
  order.delivery.deliveryOtpAttempts = 0;
  await sendMail({
    to: buyer.email,
    subject: "Your Bachat delivery OTP",
    text:
      `Hi ${buyer.name || "there"},\n\n` +
      `Your Bachat delivery OTP is ${code}. Share this code only with the delivery partner after they reach you with your order. It expires in ${minutes} minutes.\n\n` +
      "If you did not expect a delivery, contact Bachat support.",
    html:
      `<p>Hi ${buyer.name || "there"},</p>` +
      "<p>Your Bachat delivery partner is on the way to your address.</p>" +
      `<p style="font-size:28px;font-weight:800;letter-spacing:0.18em">${code}</p>` +
      `<p>Share this OTP only after the delivery partner reaches you with your order. It expires in ${minutes} minutes.</p>` +
      "<p>If you did not expect a delivery, contact Bachat support.</p>",
  });
  return true;
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
    const pickup = order.delivery?.pickup || {};
    const dropoff = order.delivery?.dropoff || {};
    const dLat = order.delivery?.driverLastLat;
    const dLng = order.delivery?.driverLastLng;
    let eta_to_pickup_min = null;
    let eta_to_dropoff_min = null;
    if (Number.isFinite(dLat) && Number.isFinite(dLng)) {
      if (Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng)) {
        eta_to_pickup_min = etaMinutes(haversineKm(dLat, dLng, pickup.lat, pickup.lng), 24);
      }
      if (Number.isFinite(dropoff.lat) && Number.isFinite(dropoff.lng)) {
        eta_to_dropoff_min = etaMinutes(haversineKm(dLat, dLng, dropoff.lat, dropoff.lng), 24);
      }
    }

    return res.json({
      order_id: String(order._id),
      payment_status: order.paymentStatus,
      order_status: order.orderStatus,
      delivery: deliveryView,
      delivery_stage: stageAlias(order.delivery?.status),
      driver_last_lat: order.delivery?.driverLastLat ?? null,
      driver_last_lng: order.delivery?.driverLastLng ?? null,
      driver_location_at: order.delivery?.driverLocationAt || null,
      eta_to_pickup_min,
      eta_to_dropoff_min,
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

router.patch("/availability", requireAuth, requireRole("delivery"), async (req, res, next) => {
  try {
    const isOnline = req.body?.is_online != null ? Boolean(req.body.is_online) : Boolean(req.body?.isOnline);
    const maxActiveJobs = Math.max(1, Math.min(20, Number(req.body?.max_active_jobs || req.body?.maxActiveJobs || 3) || 3));
    const user = await User.findOneAndUpdate(
      { _id: req.user.id, role: "delivery" },
      {
        $set: {
          "deliveryAvailability.isOnline": isOnline,
          "deliveryAvailability.lastSeenAt": new Date(),
          "deliveryAvailability.maxActiveJobs": maxActiveJobs,
        },
      },
      { new: true }
    ).lean();
    return res.json({
      is_online: Boolean(user?.deliveryAvailability?.isOnline),
      max_active_jobs: user?.deliveryAvailability?.maxActiveJobs || maxActiveJobs,
      last_seen_at: user?.deliveryAvailability?.lastSeenAt || null,
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

router.get("/pending-paid", async (req, res, next) => {
  try {
    await expireStaleDeliveryRequests(Order);
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.status(404).json({ error: "User not found" });

    const region = String(me.region || "").trim();
    const city = String(me.city || "").trim();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filter = {
      paymentStatus: "paid",
      createdAt: { $gte: since },
      $or: [
        { "delivery.status": { $in: ["none", "pending_details", "expired_unclaimed"] } },
        { "delivery.status": { $exists: false } },
        { delivery: null },
      ],
    };
    if (req.query.all !== "1" && region) {
      filter.$and = [
        {
          $or: [
            { "delivery.dropoffRegion": exactCiRegex(region) },
            { "delivery.dropoffRegion": "" },
            { "delivery.dropoffRegion": { $exists: false } },
          ],
        },
      ];
    }

    const rows = await Order.find(filter).sort({ createdAt: -1 }).limit(40).lean();
    const out = rows
      .filter((o) => {
        if (!city && !region) return true;
        const dr = o.delivery?.dropoffRegion;
        const dc = o.delivery?.dropoffCity;
        if (req.query.strict === "1" && region && dr && normText(dr) !== normText(region)) return false;
        if (req.query.strict === "1" && city && dc && normText(dc) !== normText(city)) return false;
        return true;
      })
      .map((o) => ({
        order: formatOrder(o),
        delivery: formatDeliveryPublic(o.delivery),
        reason: pendingDeliveryReason(o),
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
        { "delivery.dropoffRegion": exactCiRegex(region) },
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
        if (req.query.strict === "1" && region && dr && normText(dr) !== normText(region)) return false;
        if (req.query.strict === "1" && city && dc && normText(dc) !== normText(city)) return false;
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
        "delivery.pickup.lat": { $ne: null },
        "delivery.pickup.lng": { $ne: null },
        "delivery.dropoff.lat": { $ne: null },
        "delivery.dropoff.lng": { $ne: null },
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
    const { status: nextStatus, delivery_otp, otp } = req.body || {};
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

    const now = new Date();
    if (nextStatus === "delivered") {
      const code = String(delivery_otp || otp || "").trim();
      if (!order.delivery.deliveryOtpHash) {
        return badRequest(res, "Delivery OTP has not been sent yet. Mark en route to customer first.");
      }
      if (!code) {
        return badRequest(res, "Customer delivery OTP is required");
      }
      if (order.delivery.deliveryOtpExpiresAt && new Date(order.delivery.deliveryOtpExpiresAt) < now) {
        return badRequest(res, "Delivery OTP expired. Send a new OTP by returning to en route status.");
      }
      if (Number(order.delivery.deliveryOtpAttempts || 0) >= 6) {
        return badRequest(res, "Too many OTP attempts. Contact support.");
      }
      const ok = await verifyOtp(code, order.delivery.deliveryOtpHash);
      if (!ok) {
        order.delivery.deliveryOtpAttempts = Number(order.delivery.deliveryOtpAttempts || 0) + 1;
        await order.save();
        return badRequest(res, "Invalid delivery OTP");
      }
      order.delivery.deliveryOtpVerifiedAt = now;
    }

    order.delivery.status = nextStatus;
    if (nextStatus === "picked_up") order.delivery.pickedUpAt = now;
    if (nextStatus === "en_route_dropoff") {
      try {
        await sendDeliveryOtp(order);
      } catch (err) {
        console.error("[delivery-otp-mail]", err.message || err);
        return res.status(502).json({ error: "Could not send delivery OTP email. Try again." });
      }
    }
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

router.post("/jobs/:orderId/reject", async (req, res, next) => {
  try {
    const oid = req.params.orderId;
    if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");
    const now = new Date();
    const order = await Order.findById(oid);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.delivery?.driver || String(order.delivery.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: "Not assigned to this order" });
    }
    if (!["delivery_assigned", "driver_en_route_pickup"].includes(order.delivery.status)) {
      return badRequest(res, "Only jobs that are not picked up can be rejected");
    }
    order.delivery.status = ACTIVE_POOL;
    order.delivery.driver = null;
    order.delivery.assignedAt = null;
    order.delivery.claimExpiresAt = new Date(Date.now() + Math.max(5 * 60 * 1000, Number(process.env.DELIVERY_REJECT_REOFFER_MINUTES || 15) * 60 * 1000));
    order.delivery.reassignmentCount = Number(order.delivery.reassignmentCount || 0) + 1;
    order.delivery.cancelledReason = String(req.body?.reason || "Rejected by delivery partner").slice(0, 800);
    order.delivery.driverLastLat = null;
    order.delivery.driverLastLng = null;
    order.delivery.driverLocationAt = null;
    order.delivery.routePoints = [];
    order.delivery.deliveryOtpHash = "";
    order.delivery.deliveryOtpSentAt = null;
    order.delivery.deliveryOtpExpiresAt = null;
    order.delivery.deliveryOtpVerifiedAt = null;
    order.delivery.deliveryOtpAttempts = 0;
    order.delivery.requestedAt = now;
    await order.save();
    return res.json({ order: formatOrder(order), delivery: formatDeliveryPublic(order.delivery) });
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
    const accuracyM = req.body?.accuracy_m != null ? Number(req.body.accuracy_m) : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return badRequest(res, "lat and lng must be numbers");
    }
    if (!inIndiaBounds(lat, lng)) {
      return badRequest(res, "Location must be inside supported India bounds");
    }
    if (accuracyM != null && (!Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > 50000)) {
      return badRequest(res, "accuracy_m must be between 0 and 50000");
    }

    const order = await Order.findById(oid);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.delivery?.driver || String(order.delivery.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: "Not assigned to this order" });
    }
    if (gpsRateLimitExceeded(req.user.id, oid)) {
      return res.status(429).json({ error: "Too many location updates; please slow down." });
    }

    const allowed = ["delivery_assigned", "driver_en_route_pickup", "picked_up", "en_route_dropoff"];
    if (!allowed.includes(order.delivery.status)) {
      return badRequest(res, "Location updates not accepted in current delivery status");
    }

    const now = new Date();
    const minGapMs = Number(process.env.DELIVERY_GPS_MIN_GAP_MS || 5000);
    if (
      order.delivery.driverLocationAt &&
      now.getTime() - new Date(order.delivery.driverLocationAt).getTime() < Math.max(1000, minGapMs)
    ) {
      return res.status(429).json({ error: "Too many GPS updates; wait a few seconds" });
    }

    const retentionDays = Number(process.env.DELIVERY_ROUTE_RETENTION_DAYS || 7);
    const maxPoints = Number(process.env.DELIVERY_ROUTE_MAX_POINTS || 1200);
    const cutoff = new Date(now.getTime() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000);
    const pts = Array.isArray(order.delivery.routePoints) ? order.delivery.routePoints : [];
    const kept = pts.filter((p) => p && p.at && new Date(p.at) >= cutoff);
    kept.push({
      lat,
      lng,
      at: now,
      accuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
      status: order.delivery.status || "",
    });
    if (kept.length > Math.max(100, maxPoints)) kept.splice(0, kept.length - Math.max(100, maxPoints));

    order.delivery.driverLastLat = lat;
    order.delivery.driverLastLng = lng;
    order.delivery.driverLocationAt = now;
    order.delivery.routePoints = kept;
    await order.save();

    return res.json({
      ok: true,
      driver_location_at: order.delivery.driverLocationAt,
      points_kept: Array.isArray(order.delivery.routePoints) ? order.delivery.routePoints.length : 0,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
