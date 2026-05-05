const express = require("express");
const mongoose = require("mongoose");
const Request = require("../models/Request");
const Seller = require("../models/Seller");
const User = require("../models/User");
const Order = require("../models/Order");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatRequest } = require("../lib/format");
const { CATEGORY_SET, sellerCategoryList } = require("../lib/categories");
const { recordEvent } = require("../lib/analytics");
const { requireSellerTradeUnblocked } = require("../lib/sellerKycGate");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

router.post("/", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const { category, product_name, specifications, budget } = req.body || {};
    if (!category || !product_name) {
      return badRequest(res, "category and product_name are required");
    }
    const cat = String(category).trim();
    if (!CATEGORY_SET.has(cat)) return badRequest(res, "Invalid category");

    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const doc = await Request.create({
      user: user._id,
      category: cat,
      productName: String(product_name).trim().slice(0, 200),
      specifications: specifications ?? null,
      budget: budget == null ? null : Number(budget),
      city: String(user.city || "").trim(),
      region: String(user.region || "").trim(),
      status: "open",
    });
    recordEvent("request_created", {
      userId: user._id,
      meta: { request_id: String(doc._id), category: cat },
    });
    return res.status(201).json(formatRequest(doc));
  } catch (err) {
    return next(err);
  }
});

router.get("/mine", requireAuth, requireRole("buyer", "admin"), async (req, res, next) => {
  try {
    const filter = req.user.role === "admin" ? {} : { user: req.user.id };
    const rows = await Request.find(filter).sort({ createdAt: -1 }).lean();
    return res.json(rows.map((r) => formatRequest(r)));
  } catch (err) {
    return next(err);
  }
});

router.get("/seller/open", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id }).lean();
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });
    const sellerCats = new Set(sellerCategoryList(seller));
    if (!sellerCats.size) return res.json([]);

    const rows = await Request.find({
      status: { $in: ["open", "quoted"] },
      city: seller.city,
      region: seller.region,
      category: { $in: [...sellerCats] },
    })
      .sort({ createdAt: -1 })
      .limit(150)
      .lean();
    return res.json(rows.map((r) => formatRequest(r)));
  } catch (err) {
    return next(err);
  }
});

router.get("/:requestId", requireAuth, async (req, res, next) => {
  try {
    const rid = req.params.requestId;
    if (!mongoose.isValidObjectId(rid)) return res.status(404).json({ error: "Not found" });
    const doc = await Request.findById(rid);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (req.user.role === "buyer" && String(doc.user) !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.json(formatRequest(doc));
  } catch (err) {
    return next(err);
  }
});

router.delete("/:requestId", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const rid = req.params.requestId;
    if (!mongoose.isValidObjectId(rid)) return res.status(404).json({ error: "Not found" });
    const doc = await Request.findById(rid);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (String(doc.user) !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const st = String(doc.status || "").toLowerCase();
    if (st === "closed") {
      return res.status(409).json({ error: "Closed requests cannot be deleted" });
    }
    const hasOrder = await Order.exists({ request: doc._id });
    if (hasOrder) {
      return res.status(409).json({ error: "Request already has an order and cannot be deleted" });
    }
    await doc.deleteOne();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
