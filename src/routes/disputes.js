const express = require("express");
const mongoose = require("mongoose");
const Dispute = require("../models/Dispute");
const Order = require("../models/Order");
const Seller = require("../models/Seller");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatDispute } = require("../lib/format");
const { recordEvent } = require("../lib/analytics");

const router = express.Router();
const REASONS = Dispute.DISPUTE_REASONS;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

const OPEN = ["open", "under_review"];

async function sellerForUser(userId) {
  return Seller.findOne({ user: userId }).lean();
}

router.post("/", requireAuth, requireRole("buyer", "seller"), async (req, res, next) => {
  try {
    const { order_id, reason_code, description } = req.body || {};
    if (!order_id || !mongoose.isValidObjectId(order_id)) {
      return badRequest(res, "order_id is required");
    }
    const rc = String(reason_code || "").trim();
    if (!REASONS.includes(rc)) {
      return badRequest(res, "reason_code must be one of: " + REASONS.join(", "));
    }
    const order = await Order.findById(order_id).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    let openedByRole = req.user.role === "buyer" ? "buyer" : "seller";
    if (openedByRole === "buyer") {
      if (String(order.user) !== String(req.user.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else {
      const seller = await sellerForUser(req.user.id);
      if (!seller || String(order.seller) !== String(seller._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const dup = await Dispute.findOne({ order: order._id, status: { $in: OPEN } }).lean();
    if (dup) {
      return res.status(409).json({ error: "An open dispute already exists for this order" });
    }

    const desc = String(description || "").slice(0, 8000);
    const doc = await Dispute.create({
      order: order._id,
      buyerUser: order.user,
      seller: order.seller,
      openedByRole,
      openedByUser: req.user.id,
      reasonCode: rc,
      description: desc,
      status: "open",
      events: [
        {
          at: new Date(),
          message: "Dispute opened",
          authorRole: openedByRole,
          authorUser: req.user.id,
        },
      ],
    });
    recordEvent("dispute_opened", { userId: req.user.id, orderId: order._id, meta: { reason_code: rc } });
    return res.status(201).json(formatDispute(doc.toObject ? doc.toObject() : doc));
  } catch (err) {
    return next(err);
  }
});

router.get("/mine", requireAuth, requireRole("buyer", "seller"), async (req, res, next) => {
  try {
    let filter;
    if (req.user.role === "buyer") {
      filter = { buyerUser: req.user.id };
    } else {
      const seller = await sellerForUser(req.user.id);
      if (!seller) {
        return res.json([]);
      }
      filter = { seller: seller._id };
    }
    const rows = await Dispute.find(filter).sort({ updatedAt: -1 }).limit(100).lean();
    return res.json(rows.map((d) => formatDispute(d)));
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Not found" });
    }
    const doc = await Dispute.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ error: "Not found" });
    }
    if (req.user.role === "admin") {
      return res.json(formatDispute(doc));
    }
    if (req.user.role === "buyer" && String(doc.buyerUser) === String(req.user.id)) {
      return res.json(formatDispute(doc));
    }
    if (req.user.role === "seller") {
      const seller = await sellerForUser(req.user.id);
      if (seller && String(doc.seller) === String(seller._id)) {
        return res.json(formatDispute(doc));
      }
    }
    return res.status(403).json({ error: "Forbidden" });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/notes", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Not found" });
    }
    const { message } = req.body || {};
    const msg = String(message || "").trim();
    if (!msg) {
      return badRequest(res, "message is required");
    }
    const doc = await Dispute.findById(id);
    if (!doc) {
      return res.status(404).json({ error: "Not found" });
    }

    let authorRole = "buyer";
    let ok = false;
    if (req.user.role === "admin") {
      authorRole = "admin";
      ok = true;
    } else if (req.user.role === "buyer" && String(doc.buyerUser) === String(req.user.id)) {
      authorRole = "buyer";
      ok = true;
    } else if (req.user.role === "seller") {
      const seller = await sellerForUser(req.user.id);
      if (seller && String(doc.seller) === String(seller._id)) {
        authorRole = "seller";
        ok = true;
      }
    }
    if (!ok) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!OPEN.includes(doc.status)) {
      return badRequest(res, "Dispute is closed for new messages");
    }

    doc.events.push({
      at: new Date(),
      message: msg.slice(0, 4000),
      authorRole,
      authorUser: req.user.id,
    });
    await doc.save();
    return res.json(formatDispute(doc.toObject()));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
