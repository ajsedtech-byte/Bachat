const express = require("express");
const Order = require("../models/Order");
const Seller = require("../models/Seller");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatSeller } = require("../lib/format");
const { sendMail } = require("../services/email");

const router = express.Router();

const DOC_KINDS = new Set(["shop_photo", "gst_cert", "aadhaar", "udyam", "pan", "other"]);
const MAX_DOC_CHARS = 900000;
const MAX_DOCS = 6;

function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
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

/** Current shopkeeper eKYC state (documents are not echoed — use counts only). */
router.get("/kyc", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id }).lean();
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    const kyc = seller.sellerKyc || {};
    const n = Array.isArray(kyc.documents) ? kyc.documents.length : 0;
    return res.json({
      seller: formatSeller(seller),
      kyc: {
        status: kyc.status || "awaiting_path",
        path: kyc.path || "",
        gst_number: kyc.gstNumber || "",
        document_count: n,
        submitted_at: kyc.submittedAt || null,
        verified_at: kyc.verifiedAt || null,
        salesman_requested_at: kyc.salesmanRequestedAt || null,
        rejected_reason: kyc.rejectedReason || "",
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/kyc/path", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const { path } = req.body || {};
    const p = String(path || "").trim();
    if (!["salesman", "direct"].includes(p)) {
      return badRequest(res, "path must be salesman or direct");
    }
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Shop is already verified" });
    }
    const st = seller.sellerKyc?.status || "awaiting_path";
    if (["submitted", "verified"].includes(st)) {
      return res.status(400).json({ error: "Verification is already in progress or complete" });
    }
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    seller.sellerKyc.path = p;
    if (p === "salesman") {
      seller.sellerKyc.status = "salesman_pending";
      seller.sellerKyc.salesmanRequestedAt = new Date();
      seller.sellerKyc.documents = [];
    } else {
      seller.sellerKyc.status = "direct_draft";
      seller.sellerKyc.salesmanRequestedAt = null;
    }
    await seller.save();
    if (p === "salesman") {
      const u = await User.findById(req.user.id).lean();
      if (u && u.email) {
        try {
          await sendMail({
            to: u.email,
            subject: "Bachat — Field verification requested",
            text: `Hi ${u.name || ""},\n\nWe received your request to verify your shop with a Bachat field representative. Someone will contact you on your registered phone.\n\n— Bachat`,
            html: `<p>Hi ${u.name || "there"},</p><p>We received your request to verify your shop with a <strong>Bachat field representative</strong>. Someone will contact you on your registered phone.</p><p>— Bachat</p>`,
          });
        } catch (e) {
          console.error("[seller-kyc-salesman-mail]", e.message || e);
        }
      }
    }
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({ seller: formatSeller(fresh), message: p === "salesman" ? "Field team will contact you." : "Upload your business proofs, then submit for review." });
  } catch (err) {
    return next(err);
  }
});

router.post("/kyc/documents", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const { documents, gst_number } = req.body || {};
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Shop is already verified" });
    }
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    const st = seller.sellerKyc.status || "awaiting_path";
    if (st === "salesman_pending" && seller.sellerKyc.path === "salesman") {
      return badRequest(
        res,
        "You chose verify via field team — ask support to switch to direct upload if you need to change."
      );
    }
    if (["submitted", "verified"].includes(st)) {
      return res.status(400).json({ error: "Documents are under review or already approved." });
    }
    if (st === "awaiting_path" || st === "rejected") {
      seller.sellerKyc.path = "direct";
      seller.sellerKyc.status = "direct_draft";
    } else if (st !== "direct_draft") {
      return badRequest(res, "Cannot upload documents in the current state");
    }
    if (gst_number != null) {
      seller.sellerKyc.gstNumber = String(gst_number).replace(/\s/g, "").toUpperCase().slice(0, 20);
    }
    if (Array.isArray(documents) && documents.length) {
      const next = [];
      for (const row of documents.slice(0, MAX_DOCS)) {
        const kind = String(row?.kind || "").trim();
        if (!DOC_KINDS.has(kind)) {
          return badRequest(res, "Invalid document kind: " + kind);
        }
        const content = String(row?.data || row?.content || "").trim();
        if (!content) {
          return badRequest(res, "Each document needs data (base64 or data URL)");
        }
        if (content.length > MAX_DOC_CHARS) {
          return badRequest(res, "A document file is too large (max ~" + Math.floor(MAX_DOC_CHARS / 1000) + "KB encoded)");
        }
        next.push({
          kind,
          filename: String(row?.filename || "upload").slice(0, 200),
          mimeType: String(row?.mime_type || row?.mimeType || "application/octet-stream").slice(0, 120),
          content,
          uploadedAt: new Date(),
        });
      }
      seller.sellerKyc.documents = next;
      seller.sellerKyc.status = "direct_draft";
    }
    await seller.save();
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({
      seller: formatSeller(fresh),
      document_count: (fresh.sellerKyc && fresh.sellerKyc.documents && fresh.sellerKyc.documents.length) || 0,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/kyc/submit", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Shop is already verified" });
    }
    const st = seller.sellerKyc?.status;
    if (seller.sellerKyc?.path !== "direct" || st !== "direct_draft") {
      return badRequest(res, "Submit is only when direct uploads are saved in draft");
    }
    const n = (seller.sellerKyc.documents && seller.sellerKyc.documents.length) || 0;
    if (n < 1) {
      return badRequest(res, "Upload at least one proof document before submitting");
    }
    seller.sellerKyc.status = "submitted";
    seller.sellerKyc.submittedAt = new Date();
    seller.sellerKyc.rejectedReason = "";
    await seller.save();
    const user = await User.findById(req.user.id).lean();
    if (user && user.email) {
      try {
        await sendMail({
          to: user.email,
          subject: "We received your Bachat shop verification documents",
          text: `Hi ${user.name || ""},\n\nWe received your business verification upload. Our team will review it shortly.\n\n— Bachat`,
          html: `<p>Hi ${user.name || "there"},</p><p>We received your <strong>business verification</strong> upload. Our team will review it shortly.</p><p>— Bachat</p>`,
        });
      } catch (e) {
        console.error("[seller-kyc-submit-mail]", e.message || e);
      }
    }
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({ seller: formatSeller(fresh), message: "Submitted for review" });
  } catch (err) {
    return next(err);
  }
});

/** After rejection — choose another path or re-upload. */
router.post("/kyc/restart", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Already verified" });
    }
    if (seller.sellerKyc?.status !== "rejected") {
      return res.status(400).json({ error: "Restart is only available after a rejection" });
    }
    seller.sellerKyc.status = "awaiting_path";
    seller.sellerKyc.path = "";
    seller.sellerKyc.documents = [];
    seller.sellerKyc.rejectedReason = "";
    seller.sellerKyc.submittedAt = null;
    await seller.save();
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({ seller: formatSeller(fresh) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
