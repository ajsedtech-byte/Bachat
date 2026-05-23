const crypto = require("crypto");
const express = require("express");
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatOrder } = require("../lib/format");
const { notifyOrderPaid } = require("../services/orderEmails");
const { recordEvent } = require("../lib/analytics");
const { requestDeliveryForOrder } = require("../services/deliveryRequests");

const router = express.Router();
const apiRouter = express.Router();
const MIN_RAZORPAY_AMOUNT_PAISE = 100;

function razorpayClient() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;
  return new Razorpay({ key_id, key_secret });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

function requireRazorpayClient() {
  const client = razorpayClient();
  if (!client) {
    throw httpError(401, "Razorpay credentials are not configured.");
  }
  return client;
}

function razorpayApiError(err, fallbackMessage) {
  const status = Number(err?.statusCode || err?.status);
  const out = new Error(err?.message || fallbackMessage);
  out.status = status === 401 ? 401 : 500;
  out.publicMessage = out.status === 401 ? "Razorpay authentication failed." : fallbackMessage;
  return out;
}

function normalizedAmountPaise(value) {
  const amount = Math.round(Number(value));
  return Number.isFinite(amount) ? amount : 0;
}

function validateAmountPaise(amountPaise) {
  if (!Number.isFinite(amountPaise) || amountPaise < MIN_RAZORPAY_AMOUNT_PAISE) {
    throw httpError(400, "Minimum Razorpay amount is 100 paise.");
  }
}

function paymentSignature(orderId, paymentId) {
  const secret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!secret) {
    throw httpError(401, "Razorpay credentials are not configured.");
  }
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function signaturesMatch(expected, received) {
  const a = Buffer.from(String(expected || ""), "hex");
  const b = Buffer.from(String(received || ""), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw httpError(400, "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.");
  }
  const expected = paymentSignature(razorpay_order_id, razorpay_payment_id);
  if (!signaturesMatch(expected, razorpay_signature)) {
    throw httpError(400, "Invalid payment signature.");
  }
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
  const becamePaid = order.paymentStatus !== "paid";
  const wasFailed = order.paymentStatus === "failed";
  if (order.paymentStatus !== "paid") {
    order.paymentStatus = "paid";
    if (wasFailed && order.orderStatus === "cancelled") {
      order.orderStatus = "processing";
      if (order.delivery?.status === "cancelled") {
        order.delivery.status = "none";
      }
    }
    await order.save();
  }
  let paidOrder = order;
  const deliveryStatus = order.delivery?.status || "none";
  const shouldAutoRequestDelivery =
    becamePaid || ["none", "expired_unclaimed", "pending_details"].includes(deliveryStatus);

  if (shouldAutoRequestDelivery) {
    try {
      const deliveryResult = await requestDeliveryForOrder(order, {
        allowPendingDetails: true,
        validateArea: false,
      });
      paidOrder = deliveryResult.order || order;
      if (deliveryResult.status === "delivery_requested") {
        recordEvent("delivery_requested_auto", {
          userId: order.user,
          orderId: order._id,
          meta: { provider: "razorpay" },
        });
      } else if (deliveryResult.status === "pending_details") {
        recordEvent("delivery_pending_details", {
          userId: order.user,
          orderId: order._id,
          meta: { reason: deliveryResult.reason || "missing_delivery_details" },
        });
      }
    } catch (err) {
      console.error("Automatic delivery request failed after payment", {
        orderId: String(order._id),
        error: err?.message || err,
      });
    }
  }

  if (becamePaid) {
    await notifyOrderPaid(paidOrder);
    recordEvent("order_paid", { userId: order.user, orderId: order._id, meta: { provider: "razorpay" } });
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
  return paidOrder;
}

async function markOrderPaymentFailed(orderId, payload) {
  const order = await Order.findById(orderId);
  if (!order) return null;
  if (order.paymentStatus === "paid") {
    return order;
  }

  const becameFailed = order.paymentStatus !== "failed" || order.orderStatus !== "cancelled";
  order.paymentStatus = "failed";
  order.orderStatus = "cancelled";
  if (order.delivery) {
    order.delivery.status = "cancelled";
  }
  await order.save();

  await Payment.findOneAndUpdate(
    { order: order._id, provider: "razorpay" },
    {
      $set: {
        amount: order.totalAmount,
        status: "failed",
        providerOrderId: String(payload?.razorpay_order_id || payload?.order_id || payload?.provider_order_id || ""),
        providerPaymentId: String(payload?.razorpay_payment_id || payload?.payment_id || payload?.provider_payment_id || ""),
        rawPayload: payload || null,
      },
    },
    { upsert: true, new: true }
  );

  if (becameFailed) {
    recordEvent("order_payment_failed", {
      userId: order.user,
      orderId: order._id,
      meta: { provider: "razorpay" },
    });
  }
  return order;
}

async function createBachatPaymentOrder(req, res, next) {
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
    if (order.paymentStatus === "failed") {
      return res.status(409).json({ error: "Payment failed for this order. Please place a new order." });
    }

    const amountPaise = Math.round(Number(order.totalAmount) * 100);
    validateAmountPaise(amountPaise);
    const rp = requireRazorpayClient();
    let rzOrder;
    try {
      rzOrder = await rp.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: String(order._id),
        notes: { order_id: String(order._id) },
      });
    } catch (err) {
      return next(razorpayApiError(err, "Could not create Razorpay order."));
    }
    const providerOrderId = rzOrder.id;

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
      amount: rzOrder.amount || amountPaise,
      currency: rzOrder.currency || "INR",
      order_id: String(order._id),
      razorpay_order_id: providerOrderId,
    });
  } catch (err) {
    return next(err);
  }
}

async function createStandaloneRazorpayOrder(req, res, next) {
  try {
    const amountPaise = normalizedAmountPaise(req.body?.amount);
    validateAmountPaise(amountPaise);
    const currency = String(req.body?.currency || "INR").trim().toUpperCase();
    const cleanReceipt = String(req.body?.receipt || "").trim();
    const receipt = (cleanReceipt || `receipt_${Date.now()}`).slice(0, 40);
    const rp = requireRazorpayClient();
    let rzOrder;
    try {
      rzOrder = await rp.orders.create({
        amount: amountPaise,
        currency,
        receipt,
      });
    } catch (err) {
      return next(razorpayApiError(err, "Could not create Razorpay order."));
    }
    return res.json({
      key_id: process.env.RAZORPAY_KEY_ID || null,
      order_id: rzOrder.id,
      amount: rzOrder.amount,
      currency: rzOrder.currency,
    });
  } catch (err) {
    return next(err);
  }
}

router.post("/create-order", requireAuth, requireRole("buyer"), createBachatPaymentOrder);
apiRouter.post("/create-order", requireAuth, requireRole("buyer"), createStandaloneRazorpayOrder);

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

async function verifyBachatPayment(req, res, next) {
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
    const payment = await Payment.findOne({ order: order._id, provider: "razorpay" }).lean();
    if (payment?.providerOrderId && String(payment.providerOrderId) !== String(razorpay_order_id || "")) {
      return res.status(400).json({ error: "Invalid Razorpay order for this payment." });
    }
    verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });

    const paidOrder = await markOrderPaid(order._id, razorpay_payment_id, req.body || null);
    return res.json({ order: formatOrder(paidOrder) });
  } catch (err) {
    return next(err);
  }
}

async function failBachatPayment(req, res, next) {
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
    const failedOrder = await markOrderPaymentFailed(order._id, req.body || null);
    return res.json({ order: formatOrder(failedOrder) });
  } catch (err) {
    return next(err);
  }
}

function verifyStandalonePayment(req, res, next) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

router.post("/verify", requireAuth, requireRole("buyer"), verifyBachatPayment);
router.post("/fail", requireAuth, requireRole("buyer"), failBachatPayment);
apiRouter.post("/verify-payment", requireAuth, requireRole("buyer"), verifyStandalonePayment);

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
    } else if (event?.event === "payment.failed") {
      const entity = event?.payload?.payment?.entity || {};
      const orderId = entity?.notes?.order_id;
      if (orderId && mongoose.isValidObjectId(orderId)) {
        await markOrderPaymentFailed(orderId, event);
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Webhook handling failed" });
  }
}

module.exports = { router, apiRouter, handleRazorpayWebhook };
