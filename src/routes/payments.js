const crypto = require("crypto");
const express = require("express");
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatOrder } = require("../lib/format");
const { notifyOrderPaid } = require("../services/orderEmails");

const router = express.Router();

function razorpayClient() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;
  return new Razorpay({ key_id, key_secret });
}

function webhookSecret() {
  return process.env.RAZORPAY_WEBHOOK_SECRET || "";
}

function webhookSignature(rawBody) {
  return crypto.createHmac("sha256", webhookSecret()).update(rawBody).digest("hex");
}

async function markOrderPaid(orderId, paymentId, payload) {
  const order = await Order.findById(orderId);
  if (!order) return null;
  if (order.paymentStatus !== "paid") {
    order.paymentStatus = "paid";
    await order.save();
    await notifyOrderPaid(order);
  }
  await Payment.findOneAndUpdate(
    { order: order._id, provider: "razorpay" },
    {
      $set: {
        status: "captured",
        providerPaymentId: String(paymentId || ""),
        rawPayload: payload || null,
      },
      $setOnInsert: {
        amount: order.totalAmount,
      },
    },
    { upsert: true, new: true }
  );
  return order;
}

router.post("/create-order", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const { order_id } = req.body || {};
    if (!order_id || !mongoose.isValidObjectId(order_id)) {
      return res.status(400).json({ error: "order_id is required" });
    }

    const order = await Order.findById(order_id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (String(order.user) !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (order.paymentStatus === "paid") {
      return res.status(409).json({ error: "Order is already paid" });
    }

    const amountPaise = Math.round(Number(order.totalAmount) * 100);
    const rp = razorpayClient();
    let providerOrderId = "";

    if (rp) {
      const rzOrder = await rp.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: String(order._id),
        notes: { order_id: String(order._id) },
      });
      providerOrderId = rzOrder.id;
    }

    await Payment.findOneAndUpdate(
      { order: order._id, provider: "razorpay" },
      {
        $set: {
          amount: order.totalAmount,
          status: "created",
          providerOrderId,
        },
      },
      { upsert: true }
    );

    return res.json({
      key_id: process.env.RAZORPAY_KEY_ID || null,
      amount: amountPaise,
      currency: "INR",
      order_id: String(order._id),
      razorpay_order_id: providerOrderId || null,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/mine", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.user.id }).select("_id").lean();
    const ids = orders.map((o) => o._id);
    if (!ids.length) {
      return res.json({ items: [] });
    }
    const rows = await Payment.find({ order: { $in: ids } })
      .populate({
        path: "order",
        select:
          "finalPrice totalAmount paymentStatus orderStatus lineItems orderType request quote createdAt user",
      })
      .sort({ createdAt: -1 })
      .lean();

    const items = rows
      .filter((p) => p.order && String(p.order.user) === String(req.user.id))
      .map((p) => {
        const fo = formatOrder(p.order);
        return {
          payment_id: String(p._id),
          order_id: fo.order_id,
          amount: p.amount,
          status: p.status,
          provider_order_id: p.providerOrderId || "",
          provider_payment_id: p.providerPaymentId || "",
          created_at: p.createdAt,
          order_summary: fo.summary,
          order_payment_status: fo.payment_status,
          order_status: fo.order_status,
        };
      });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.post("/verify", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!order_id || !mongoose.isValidObjectId(order_id)) {
      return res.status(400).json({ error: "order_id is required" });
    }
    const order = await Order.findById(order_id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (String(order.user) !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET || "";
    if (secret && razorpay_order_id && razorpay_payment_id && razorpay_signature) {
      const h = crypto
        .createHmac("sha256", secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      if (h !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid payment signature" });
      }
    }

    const paidOrder = await markOrderPaid(order._id, razorpay_payment_id, req.body || null);
    return res.json({ order: formatOrder(paidOrder) });
  } catch (err) {
    return next(err);
  }
});

async function handleRazorpayWebhook(req, res) {
  try {
    const sig = req.headers["x-razorpay-signature"] || "";
    const rawBody = req.body;
    const expected = webhookSignature(rawBody);
    if (webhookSecret() && sig !== expected) {
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    if (event?.event === "payment.captured") {
      const entity = event?.payload?.payment?.entity || {};
      const orderId = entity?.notes?.order_id;
      if (orderId && mongoose.isValidObjectId(orderId)) {
        await markOrderPaid(orderId, entity.id, event);
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Webhook handling failed" });
  }
}

module.exports = { router, handleRazorpayWebhook };
