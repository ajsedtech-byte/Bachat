const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Seller = require("../models/Seller");
const Request = require("../models/Request");
const Quote = require("../models/Quote");
const Order = require("../models/Order");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

/** KPIs + recent requests for the ops dashboard */
router.get("/overview", async (_req, res, next) => {
  try {
    const [
      usersTotal,
      sellersTotal,
      buyersTotal,
      reqOpen,
      reqQuoted,
      reqClosed,
      reqExpired,
      ordersTotal,
      revenueAgg,
    ] = await Promise.all([
      User.countDocuments(),
      Seller.countDocuments(),
      User.countDocuments({ role: "buyer" }),
      Request.countDocuments({ status: "open" }),
      Request.countDocuments({ status: "quoted" }),
      Request.countDocuments({ status: "closed" }),
      Request.countDocuments({ status: "expired" }),
      Order.countDocuments(),
      Order.aggregate([
        { $match: { paymentStatus: "paid" } },
        { $group: { _id: null, sum: { $sum: "$totalAmount" } } },
      ]),
    ]);

    const revenuePaid = revenueAgg[0]?.sum || 0;

    const recent = await Request.find()
      .sort({ createdAt: -1 })
      .limit(25)
      .populate("user", "name email")
      .lean();

    const requestIds = recent.map((r) => r._id);
    const quoteCounts = await Quote.aggregate([
      { $match: { request: { $in: requestIds } } },
      { $group: { _id: "$request", n: { $sum: 1 } } },
    ]);
    const countMap = new Map(quoteCounts.map((x) => [String(x._id), x.n]));

    const recent_requests = recent.map((r) => ({
      request_id: String(r._id),
      product_name: r.productName,
      category: r.category,
      city: r.city,
      region: r.region,
      status: r.status,
      created_at: r.createdAt,
      buyer_name: (r.user && r.user.name) || "—",
      buyer_email: (r.user && r.user.email) || "—",
      quote_count: countMap.get(String(r._id)) || 0,
    }));

    const quotesTotal = await Quote.countDocuments();

    return res.json({
      users_total: usersTotal,
      sellers_total: sellersTotal,
      buyers_total: buyersTotal,
      requests_open: reqOpen,
      requests_quoted: reqQuoted,
      requests_closed: reqClosed,
      requests_total: reqOpen + reqQuoted + reqClosed + reqExpired,
      orders_total: ordersTotal,
      quotes_total: quotesTotal,
      revenue_paid_inr: revenuePaid,
      recent_requests,
    });
  } catch (err) {
    return next(err);
  }
});

router.patch("/sellers/:sellerId/verify", async (req, res, next) => {
  try {
    const sid = req.params.sellerId;
    if (!mongoose.isValidObjectId(sid)) {
      return res.status(400).json({ error: "Invalid seller id" });
    }
    const { is_verified } = req.body || {};
    if (typeof is_verified !== "boolean") {
      return res.status(400).json({ error: "is_verified (boolean) is required" });
    }
    const seller = await Seller.findByIdAndUpdate(sid, { $set: { isVerified: is_verified } }, { new: true }).lean();
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }
    return res.json({
      seller_id: String(seller._id),
      is_verified: seller.isVerified,
    });
  } catch (err) {
    return next(err);
  }
});

/** Delivery partners waiting for manual Aadhaar/KYC review */
router.get("/delivery-kyc/pending", async (_req, res, next) => {
  try {
    const rows = await User.find({ role: "delivery", "deliveryKyc.status": "submitted" })
      .select("email name city region phone createdAt deliveryKyc")
      .sort({ "deliveryKyc.submittedAt": 1 })
      .lean();
    const items = rows.map((u) => ({
      user_id: String(u._id),
      email: u.email,
      name: u.name,
      city: u.city,
      region: u.region,
      phone: u.phone,
      submitted_at: u.deliveryKyc?.submittedAt || null,
      /** Last 4 only — for ops review alongside profile. */
      aadhar_last4: u.deliveryKyc?.aadharLast4 || "",
      pan_last4: u.deliveryKyc?.panLast4 || "",
      consent_accepted_at: u.deliveryKyc?.consentAcceptedAt || null,
    }));
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.patch("/delivery-kyc/:userId", async (req, res, next) => {
  try {
    const uid = req.params.userId;
    if (!mongoose.isValidObjectId(uid)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const { status, rejection_reason } = req.body || {};
    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be verified or rejected" });
    }
    const set = {
      "deliveryKyc.status": status,
    };
    if (status === "verified") {
      set["deliveryKyc.verifiedAt"] = new Date();
      set["deliveryKyc.rejectedReason"] = "";
    } else {
      set["deliveryKyc.verifiedAt"] = null;
      set["deliveryKyc.rejectedReason"] = String(rejection_reason || "Rejected").slice(0, 500);
    }
    const u = await User.findOneAndUpdate({ _id: uid, role: "delivery" }, { $set: set }, { new: true }).lean();
    if (!u) {
      return res.status(404).json({ error: "Delivery user not found" });
    }
    return res.json({
      user_id: String(u._id),
      kyc_status: u.deliveryKyc?.status,
      verified_at: u.deliveryKyc?.verifiedAt || null,
      rejection_reason: status === "rejected" ? u.deliveryKyc?.rejectedReason || "" : undefined,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/orders", async (_req, res, next) => {
  try {
    const rows = await Order.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("user", "name email")
      .lean();
    const out = rows.map((o) => ({
      order_id: String(o._id),
      user_name: (o.user && o.user.name) || "—",
      amount: o.totalAmount,
      payment_status: o.paymentStatus,
      order_status: o.orderStatus,
      created_at: o.createdAt,
    }));
    return res.json(out);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
