const express = require("express");
const Order = require("../models/Order");
const Seller = require("../models/Seller");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

router.get("/payouts-summary", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id }).lean();
    if (!seller) {
      return res.json({
        paid_orders_count: 0,
        gross_sales: 0,
        pending_settlement: 0,
        pending_orders_count: 0,
      });
    }
    const paid = await Order.find({ seller: seller._id, paymentStatus: "paid" }).lean();
    const pending = await Order.find({
      seller: seller._id,
      paymentStatus: "pending",
      orderStatus: { $ne: "cancelled" },
    }).lean();
    const gross = paid.reduce((s, o) => s + Number(o.finalPrice || 0), 0);
    const pend = pending.reduce((s, o) => s + Number(o.finalPrice || 0), 0);
    return res.json({
      paid_orders_count: paid.length,
      gross_sales: round2(gross),
      pending_settlement: round2(pend),
      pending_orders_count: pending.length,
      note: "Gross sales sums final_price on paid orders; settlement to your bank follows your Bachat agreement.",
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
