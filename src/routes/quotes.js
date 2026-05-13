const express = require("express");
const mongoose = require("mongoose");
const Quote = require("../models/Quote");
const Request = require("../models/Request");
const Seller = require("../models/Seller");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatQuote } = require("../lib/format");
const { recordEvent } = require("../lib/analytics");
const { requireSellerTradeUnblocked, sellerTradeBlocked, forbiddenKyc } = require("../lib/sellerKycGate");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
}

router.post("/", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const { request_id, price, delivery_time, notes } = req.body || {};
    if (!request_id || !mongoose.isValidObjectId(request_id)) {
      return badRequest(res, "request_id is required");
    }
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount < 1) {
      return badRequest(res, "price must be a number >= 1");
    }

    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });
    const reqDoc = await Request.findById(request_id);
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });
    if (!["open", "quoted"].includes(reqDoc.status)) {
      return badRequest(res, "Request is not open for quoting");
    }
    if (normText(reqDoc.city) !== normText(seller.city) || normText(reqDoc.region) !== normText(seller.region)) {
      return res.status(403).json({ error: "Outside your service area" });
    }

    const doc = await Quote.findOneAndUpdate(
      { request: reqDoc._id, seller: seller._id },
      {
        $set: {
          price: amount,
          deliveryTime: String(delivery_time || "").slice(0, 120),
          notes: String(notes || "").slice(0, 2000),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (reqDoc.status === "open") {
      reqDoc.status = "quoted";
      await reqDoc.save();
    }

    recordEvent("quote_sent", {
      userId: req.user.id,
      meta: { request_id: String(reqDoc._id), seller_id: String(seller._id), quote_id: String(doc._id) },
    });

    return res.status(201).json(formatQuote(doc, seller));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Quote already exists for this request" });
    }
    return next(err);
  }
});

router.get("/request/:requestId", requireAuth, async (req, res, next) => {
  try {
    const rid = req.params.requestId;
    if (!mongoose.isValidObjectId(rid)) return res.json([]);
    const reqDoc = await Request.findById(rid).lean();
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });
    if (req.user.role === "seller") {
      const sk = await Seller.findOne({ user: req.user.id }).lean();
      if (sellerTradeBlocked(sk)) {
        return forbiddenKyc(res);
      }
    }
    if (req.user.role === "buyer" && String(reqDoc.user) !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rows = await Quote.find({ request: rid }).sort({ price: 1 }).lean();
    const sellerIds = [...new Set(rows.map((r) => String(r.seller)))];
    const sellers = await Seller.find({ _id: { $in: sellerIds } }).lean();
    const sellerMap = Object.fromEntries(sellers.map((s) => [String(s._id), s]));
    return res.json(rows.map((q) => formatQuote(q, sellerMap[String(q.seller)])));
  } catch (err) {
    return next(err);
  }
});

router.get("/mine/seller", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id }).lean();
    if (!seller) return res.json([]);
    const rows = await Quote.find({ seller: seller._id }).sort({ createdAt: -1 }).lean();
    return res.json(rows.map((q) => formatQuote(q)));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
