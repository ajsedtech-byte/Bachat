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
const { formatOrder } = require("../lib/format");
const { buyerDisplayPrice } = require("../lib/buyerPrice");
const { notifyOrderStatusToBuyer } = require("../services/orderEmails");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
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
          if (!seller || seller.city !== city || seller.region !== region) {
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
      return res.json(rows.map((o) => formatOrder(o)));
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
      return res.json(rows.map((o) => formatOrder(o)));
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
