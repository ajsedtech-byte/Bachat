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
