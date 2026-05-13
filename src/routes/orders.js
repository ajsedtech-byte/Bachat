const express = require("express");
const mongoose = require("mongoose");
const Quote = require("../models/Quote");
const Request = require("../models/Request");
const Order = require("../models/Order");
const Seller = require("../models/Seller");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatOrder, formatDeliveryPrivate } = require("../lib/format");
const { buyerDisplayPrice, buyerMaxListedPrice } = require("../lib/buyerPrice");
const { notifyOrderStatusToBuyer } = require("../services/orderEmails");
const { claimTimeoutMs, normalizeAddressPart } = require("../lib/delivery");
const { recordEvent } = require("../lib/analytics");
const { requireSellerTradeUnblocked } = require("../lib/sellerKycGate");
const { inIndiaBounds, normalizePreciseLocation, reverseGeocodeCoords, areaMatches } = require("../lib/location");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
}

function requireValidPlace(res, label, place) {
  if (!place || place.lat == null || place.lng == null) {
    badRequest(res, `${label}.lat and ${label}.lng are required`);
    return false;
  }
  if (!inIndiaBounds(place.lat, place.lng)) {
    badRequest(res, `${label} must be inside supported India bounds`);
    return false;
  }
  if (!String(place.addressText || place.address || "").trim()) {
    badRequest(res, `${label}.address_text is required`);
    return false;
  }
  return true;
}

function platformFeeForPrice() {
  const raw = process.env.PLATFORM_FEE_FLAT;
  if (raw != null && raw !== "") {
    return Math.max(0, Number(raw));
  }
  return 0;
}

router.post(
  "/",
  requireAuth,
  requireRole("buyer"),
  async (req, res, next) => {
    try {
      const { quote_id } = req.body || {};
      const qid = quote_id;
      if (!qid || !mongoose.isValidObjectId(qid)) {
        return badRequest(res, "quote_id is required");
      }

      const session = await mongoose.startSession();
      let createdOrder;
      try {
        await session.withTransaction(async () => {
          const q = await Quote.findById(qid).session(session);
          if (!q) {
            throw Object.assign(new Error("Quote not found"), { status: 404 });
          }
          const r = await Request.findById(q.request).session(session);
          if (!r) {
            throw Object.assign(new Error("Quote not found"), { status: 404 });
          }
          if (String(r.user) !== String(req.user.id)) {
            throw Object.assign(new Error("Forbidden"), { status: 403 });
          }
          if (!["open", "quoted"].includes(r.status)) {
            throw Object.assign(new Error("Request is already closed"), { status: 400 });
          }

          const exists = await Order.findOne({ request: r._id }).session(session);
          if (exists) {
            throw Object.assign(new Error("An order already exists for this request"), {
              status: 409,
            });
          }

          const finalPrice = q.price;
          const platformFee = platformFeeForPrice(finalPrice);
          const totalAmount = finalPrice + platformFee;

          const [ord] = await Order.create(
            [
              {
                orderType: "quote",
                request: r._id,
                quote: q._id,
                user: req.user.id,
                seller: q.seller,
                finalPrice,
                platformFee,
                totalAmount,
                paymentStatus: "pending",
                orderStatus: "processing",
              },
            ],
            { session }
          );
          createdOrder = ord;

          r.status = "closed";
          await r.save({ session });
        });
      } catch (e) {
        if (e.status) {
          return res.status(e.status).json({ error: e.message });
        }
        throw e;
      } finally {
        session.endSession();
      }

      recordEvent("order_created", {
        userId: req.user.id,
        orderId: createdOrder._id,
        meta: { order_type: "quote" },
      });
      return res.status(201).json(formatOrder(createdOrder));
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/from-cart",
  requireAuth,
  requireRole("buyer"),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id).lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const city = String(user.city || "").trim();
      const region = String(user.region || "").trim();
      if (!city || !region) {
        return badRequest(res, "Set your city and region on your profile before checkout.");
      }

      const session = await mongoose.startSession();
      let createdOrder;
      try {
        await session.withTransaction(async () => {
          const cart = await Cart.findOne({ user: req.user.id }).session(session);
          if (!cart || !cart.items.length) {
            throw Object.assign(new Error("Your cart is empty"), { status: 400 });
          }

          const pids = cart.items.map((i) => i.product);
          const products = await Product.find({ _id: { $in: pids }, isActive: true }).session(session);
          if (products.length !== cart.items.length) {
            throw Object.assign(new Error("Some items are no longer available. Refresh your cart."), {
              status: 400,
            });
          }

          const sellerIds = [...new Set(products.map((p) => String(p.seller)))];
          if (sellerIds.length !== 1) {
            throw Object.assign(new Error("Cart can only contain items from one shop at a time."), {
              status: 400,
            });
          }

          const seller = await Seller.findById(sellerIds[0]).session(session);
          if (!seller || normText(seller.city) !== normText(city) || normText(seller.region) !== normText(region)) {
            throw Object.assign(new Error("Those items are not available in your delivery area."), {
              status: 400,
            });
          }

          const pmap = Object.fromEntries(products.map((p) => [String(p._id), p]));
          const lineItems = [];
          let finalPrice = 0;

          for (const row of cart.items) {
            const p = pmap[String(row.product)];
            if (!p) {
              throw Object.assign(new Error("Some items are no longer available."), { status: 400 });
            }
            const unitPrice = buyerDisplayPrice(p.sellerPrice, p._id);
            const qty = row.quantity;
            const lineTotal = unitPrice * qty;
            finalPrice += lineTotal;
            lineItems.push({
              product: p._id,
              title: p.title,
              quantity: qty,
              unitPrice,
            });
          }

          finalPrice = Math.round(finalPrice * 100) / 100;
          const platformFee = platformFeeForPrice();
          const totalAmount = finalPrice + platformFee;

          const [ord] = await Order.create(
            [
              {
                orderType: "catalog",
                lineItems,
                user: req.user.id,
                seller: seller._id,
                finalPrice,
                platformFee,
                totalAmount,
                paymentStatus: "pending",
                orderStatus: "processing",
              },
            ],
            { session }
          );
          createdOrder = ord;

          cart.items = [];
          await cart.save({ session });
        });
      } catch (e) {
        if (e.status) {
          return res.status(e.status).json({ error: e.message });
        }
        throw e;
      } finally {
        session.endSession();
      }

      recordEvent("order_created", {
        userId: req.user.id,
        orderId: createdOrder._id,
        meta: { order_type: "catalog" },
      });
      return res.status(201).json(formatOrder(createdOrder));
    } catch (err) {
      return next(err);
    }
  }
);

router.patch(
  "/seller/:orderId/order-status",
  requireAuth,
  requireRole("seller"),
  requireSellerTradeUnblocked,
  async (req, res, next) => {
    try {
      const { order_status } = req.body || {};
      const allowed = ["processing", "shipped", "delivered", "cancelled"];
      if (!order_status || !allowed.includes(order_status)) {
        return badRequest(res, "order_status must be one of: " + allowed.join(", "));
      }

      const oid = req.params.orderId;
      if (!mongoose.isValidObjectId(oid)) {
        return badRequest(res, "Invalid order id");
      }

      const seller = await Seller.findOne({ user: req.user.id });
      if (!seller) {
        return res.status(404).json({ error: "Seller profile not found" });
      }

      const order = await Order.findOne({ _id: oid, seller: seller._id });
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (order.paymentStatus !== "paid") {
        return badRequest(res, "Order is not paid yet");
      }

      const prev = order.orderStatus;
      order.orderStatus = order_status;
      await order.save();

      await notifyOrderStatusToBuyer(order, prev);

      return res.json(formatOrder(order));
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/mine",
  requireAuth,
  requireRole("buyer"),
  async (req, res, next) => {
    try {
      const rows = await Order.find({ user: req.user.id })
        .sort({ createdAt: -1 })
        .lean();
      return res.json(
        rows.map((o) => {
          const fo = formatOrder(o);
          fo.delivery = formatDeliveryPrivate(o.delivery);
          return fo;
        })
      );
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * Paid orders only. Catalog: sum over lines of (max-markup list price − paid unit price) × qty.
 * Quote: per order max(highest quote on request − paid, budget − paid) when applicable.
 */
router.get(
  "/mine/savings-summary",
  requireAuth,
  requireRole("buyer"),
  async (req, res, next) => {
    try {
      const paidOrders = await Order.find({ user: req.user.id, paymentStatus: "paid" }).lean();

      const catOrders = paidOrders.filter((o) => o.orderType === "catalog" && (o.lineItems || []).length);
      const pids = [...new Set(catOrders.flatMap((o) => o.lineItems.map((li) => li.product)))];
      const products = pids.length ? await Product.find({ _id: { $in: pids } }).lean() : [];
      const pmap = Object.fromEntries(products.map((p) => [String(p._id), p]));

      let catalog_savings = 0;
      for (const o of catOrders) {
        for (const li of o.lineItems) {
          const p = pmap[String(li.product)];
          if (!p) continue;
          const maxP = buyerMaxListedPrice(p.sellerPrice);
          const unit = Number(li.unitPrice);
          const qty = Number(li.quantity) || 1;
          catalog_savings += Math.max(0, maxP - unit) * qty;
        }
      }
      catalog_savings = Math.round(catalog_savings * 100) / 100;

      const qOrders = paidOrders.filter((o) => o.orderType === "quote" && o.request);
      let quote_savings = 0;
      const reqIds = [...new Set(qOrders.map((o) => String(o.request)))];
      if (reqIds.length) {
        const [reqDocs, quoteDocs] = await Promise.all([
          Request.find({ _id: { $in: reqIds } }).lean(),
          Quote.find({ request: { $in: reqIds } }).lean(),
        ]);
        const reqMap = Object.fromEntries(reqDocs.map((r) => [String(r._id), r]));
        const quotesByReq = {};
        for (const q of quoteDocs) {
          const k = String(q.request);
          if (!quotesByReq[k]) quotesByReq[k] = [];
          quotesByReq[k].push(Number(q.price));
        }
        for (const o of qOrders) {
          const rid = String(o.request);
          const prices = quotesByReq[rid] || [];
          const maxQ = prices.length ? Math.max(...prices) : o.finalPrice;
          const neg = Math.max(0, maxQ - o.finalPrice);
          const req = reqMap[rid];
          const budgetS =
            req && req.budget != null && Number(req.budget) > o.finalPrice
              ? Number(req.budget) - o.finalPrice
              : 0;
          quote_savings += Math.max(neg, budgetS);
        }
      }
      quote_savings = Math.round(quote_savings * 100) / 100;

      const money_saved = Math.round((catalog_savings + quote_savings) * 100) / 100;
      return res.json({
        money_saved,
        catalog_vs_max_markup: catalog_savings,
        quote_negotiation_or_budget: quote_savings,
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/seller",
  requireAuth,
  requireRole("seller"),
  async (req, res, next) => {
    try {
      const seller = await Seller.findOne({ user: req.user.id }).lean();
      if (!seller) {
        return res.json([]);
      }
      const rows = await Order.find({ seller: seller._id })
        .sort({ createdAt: -1 })
        .lean();
      return res.json(
        rows.map((o) => {
          const fo = formatOrder(o);
          fo.delivery = formatDeliveryPrivate(o.delivery);
          return fo;
        })
      );
    } catch (err) {
      return next(err);
    }
  }
);

/** Buyer: after payment, request delivery with structured pickup/dropoff (goes to driver pool). */
router.post(
  "/:orderId/delivery-request",
  requireAuth,
  requireRole("buyer"),
  async (req, res, next) => {
    try {
      const oid = req.params.orderId;
      if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");

      const order = await Order.findById(oid);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (String(order.user) !== String(req.user.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (order.paymentStatus !== "paid") {
        return badRequest(res, "Order must be paid before requesting delivery");
      }

      if (!order.delivery) order.delivery = {};

      const allowed = ["none", "expired_unclaimed", "pending_details"];
      if (!allowed.includes(order.delivery?.status || "none")) {
        return badRequest(res, "Delivery already requested or in progress");
      }

      const { dropoff, pickup: pickupOverride, fee } = req.body || {};

      const buyer = await User.findById(req.user.id).lean();
      const sellerDoc = await Seller.findById(order.seller).lean();
      if (!sellerDoc) return res.status(404).json({ error: "Seller not found" });
      const buyerLoc = normalizePreciseLocation(dropoff || buyer?.location || {});
      const sellerLoc = normalizePreciseLocation(pickupOverride || sellerDoc?.location || {});
      if (!buyerLoc.capturedAt) buyerLoc.capturedAt = new Date();
      if (!sellerLoc.capturedAt) sellerLoc.capturedAt = new Date();
      if (!requireValidPlace(res, "dropoff", buyerLoc)) return;
      if (!requireValidPlace(res, "pickup", sellerLoc)) return;
      let revBuyer;
      let revSeller;
      try {
        [revBuyer, revSeller] = await Promise.all([
          reverseGeocodeCoords(buyerLoc.lat, buyerLoc.lng),
          reverseGeocodeCoords(sellerLoc.lat, sellerLoc.lng),
        ]);
      } catch (e) {
        return res.status(502).json({ error: "Could not validate GPS area. Please try again." });
      }
      if (!areaMatches(buyer?.city, buyer?.region, revBuyer)) {
        return badRequest(
          res,
          "Dropoff GPS does not match your profile city/region. Update profile area or move pin."
        );
      }
      if (!areaMatches(sellerDoc?.city, sellerDoc?.region, revSeller)) {
        return badRequest(
          res,
          "Pickup GPS does not match seller service area. Ask shopkeeper to update location."
        );
      }
      if (!buyerLoc.pincode && revBuyer && revBuyer.pincode) buyerLoc.pincode = revBuyer.pincode;
      if (!sellerLoc.pincode && revSeller && revSeller.pincode) sellerLoc.pincode = revSeller.pincode;

      const dropPhone = normalizeAddressPart(dropoff?.contactPhone) || normalizeAddressPart(buyer?.phone) || "";
      const pickPhone = normalizeAddressPart(pickupOverride?.contactPhone) || "";

      order.delivery = order.delivery || {};
      order.delivery.status = "delivery_requested";
      order.delivery.fee = fee != null && Number.isFinite(Number(fee)) ? Math.max(0, Number(fee)) : order.delivery.fee || 0;
      order.delivery.driver = null;
      order.delivery.requestedAt = new Date();
      order.delivery.claimExpiresAt = new Date(Date.now() + claimTimeoutMs());
      order.delivery.assignedAt = null;
      order.delivery.readyForPickupAt = null;
      order.delivery.pickedUpAt = null;
      order.delivery.deliveredAt = null;
      order.delivery.driverLastLat = null;
      order.delivery.driverLastLng = null;
      order.delivery.driverLocationAt = null;
      order.delivery.routePoints = [];
      order.delivery.dropoffCity = normalizeAddressPart(buyer?.city) || "";
      order.delivery.dropoffRegion = normalizeAddressPart(buyer?.region) || "";
      order.delivery.dropoff = {
        address: buyerLoc.addressText,
        addressText: buyerLoc.addressText,
        landmark: buyerLoc.landmark,
        pincode: buyerLoc.pincode,
        lat: buyerLoc.lat,
        lng: buyerLoc.lng,
        accuracyM: buyerLoc.accuracyM,
        capturedAt: buyerLoc.capturedAt,
        contactPhone: dropPhone,
      };
      order.delivery.pickup = {
        address: sellerLoc.addressText,
        addressText: sellerLoc.addressText,
        landmark: sellerLoc.landmark,
        pincode: sellerLoc.pincode,
        lat: sellerLoc.lat,
        lng: sellerLoc.lng,
        accuracyM: sellerLoc.accuracyM,
        capturedAt: sellerLoc.capturedAt,
        contactPhone: pickPhone,
      };

      await order.save();
      return res.status(201).json({ order: formatOrder(order) });
    } catch (err) {
      return next(err);
    }
  }
);

/** Shopkeeper: confirm order is ready for driver pickup (required before driver marks picked_up). */
router.post(
  "/seller/:orderId/delivery-ready",
  requireAuth,
  requireRole("seller"),
  requireSellerTradeUnblocked,
  async (req, res, next) => {
    try {
      const oid = req.params.orderId;
      if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");

      const seller = await Seller.findOne({ user: req.user.id });
      if (!seller) return res.status(404).json({ error: "Seller profile not found" });

      const order = await Order.findOne({ _id: oid, seller: seller._id });
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.paymentStatus !== "paid") {
        return badRequest(res, "Order is not paid yet");
      }
      if (!order.delivery?.status || order.delivery.status === "none") {
        return badRequest(res, "Buyer must request delivery before marking ready for pickup");
      }

      order.delivery = order.delivery || {};
      order.delivery.pickup = order.delivery.pickup || {};

      const { pickup } = req.body || {};
      if (pickup) {
        const nextPickup = normalizePreciseLocation(pickup);
        if (nextPickup.addressText) {
          order.delivery.pickup.address = nextPickup.addressText;
          order.delivery.pickup.addressText = nextPickup.addressText;
        }
        if (nextPickup.landmark != null) order.delivery.pickup.landmark = nextPickup.landmark;
        if (nextPickup.pincode != null) order.delivery.pickup.pincode = nextPickup.pincode;
        if (nextPickup.lat != null && Number.isFinite(Number(nextPickup.lat))) order.delivery.pickup.lat = Number(nextPickup.lat);
        if (nextPickup.lng != null && Number.isFinite(Number(nextPickup.lng))) order.delivery.pickup.lng = Number(nextPickup.lng);
        if (nextPickup.accuracyM != null) order.delivery.pickup.accuracyM = nextPickup.accuracyM;
        if (nextPickup.capturedAt) order.delivery.pickup.capturedAt = nextPickup.capturedAt;
        if (pickup.contactPhone != null) {
          order.delivery.pickup.contactPhone = normalizeAddressPart(pickup.contactPhone);
        }
      }
      if (!requireValidPlace(res, "pickup", order.delivery.pickup)) return;
      order.delivery.readyForPickupAt = new Date();
      await order.save();
      return res.json({ order: formatOrder(order) });
    } catch (err) {
      return next(err);
    }
  }
);

/** Shopkeeper: after claim timeout, put job back in the pool for drivers. */
router.post(
  "/seller/:orderId/delivery-reoffer",
  requireAuth,
  requireRole("seller"),
  requireSellerTradeUnblocked,
  async (req, res, next) => {
    try {
      const oid = req.params.orderId;
      if (!mongoose.isValidObjectId(oid)) return badRequest(res, "Invalid order id");

      const seller = await Seller.findOne({ user: req.user.id });
      if (!seller) return res.status(404).json({ error: "Seller profile not found" });

      const order = await Order.findOne({ _id: oid, seller: seller._id });
      if (!order) return res.status(404).json({ error: "Order not found" });

      const now = new Date();
      const claimExpired =
        order.delivery?.claimExpiresAt && order.delivery.claimExpiresAt < now && !order.delivery?.driver;
      const canReoffer =
        order.delivery?.status === "expired_unclaimed" ||
        (order.delivery?.status === "delivery_requested" && claimExpired);
      if (!canReoffer) {
        return badRequest(res, "Only expired delivery jobs (no driver) can be re-offered");
      }

      order.delivery.status = "delivery_requested";
      order.delivery.driver = null;
      order.delivery.requestedAt = new Date();
      order.delivery.claimExpiresAt = new Date(Date.now() + claimTimeoutMs());
      order.delivery.assignedAt = null;
      await order.save();
      return res.json({ order: formatOrder(order) });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
