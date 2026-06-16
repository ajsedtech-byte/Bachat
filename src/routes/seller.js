const express = require("express");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Seller = require("../models/Seller");
const User = require("../models/User");
const NotificationDelivery = require("../models/NotificationDelivery");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatSeller } = require("../lib/format");
const { normalizeSellerCategories } = require("../lib/categories");
const { WEEK_DAYS, normalizeBusinessHours } = require("../lib/shopHours");
const { normalizeIndiaRegionCity } = require("../lib/indiaLocations");
const { validateGstinChecksum } = require("../lib/gstinValidate");
const { gstRegistryLookupHttp } = require("../lib/gstRegistryLookup");
const { SELLER_KYC_DOC_KINDS, MAX_DOC_CHARS, MAX_DOCS } = require("../lib/sellerKycDocs");
const { sendMail } = require("../services/email");

const router = express.Router();

const DOC_KINDS = new Set(SELLER_KYC_DOC_KINDS);
const SHOP_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_SHOP_IMAGE_CHARS = 750_000;

function normalizeShopImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 4)) {
    const src = String(item || "").trim();
    if (!src) continue;
    if (src.length > MAX_SHOP_IMAGE_CHARS) {
      const err = new Error("A shop image is too large. Upload smaller images.");
      err.status = 400;
      throw err;
    }
    out.push(src);
  }
  return out;
}

function normalizeWeeklyHoursInput(rows, fallbackOpen, fallbackClose) {
  if (!Array.isArray(rows)) return null;
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const day = String(row?.day || "").trim().toLowerCase();
    if (!WEEK_DAYS.includes(day) || seen.has(day)) continue;
    seen.add(day);
    const isOpen = row?.is_open !== false && row?.isOpen !== false && String(row?.is_open).toLowerCase() !== "false";
    const openTime = String(row?.open_time || row?.openTime || fallbackOpen).trim();
    const closeTime = String(row?.close_time || row?.closeTime || fallbackClose).trim();
    if (!SHOP_TIME_RE.test(openTime) || !SHOP_TIME_RE.test(closeTime) || openTime === closeTime) {
      const err = new Error(`Choose valid open and close times for ${day}.`);
      err.status = 400;
      throw err;
    }
    out.push({ day, isOpen, openTime, closeTime });
  }
  return out.length ? out : null;
}

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
router.get("/payouts-history", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id }).lean();
    if (!seller) return res.json({ items: [] });

    const orders = await Order.find({ seller: seller._id }).sort({ createdAt: -1 }).limit(250).lean();
    const orderIds = orders.map((o) => o._id);
    const payments = orderIds.length ? await Payment.find({ order: { $in: orderIds } }).lean() : [];
    const paymentByOrder = new Map(payments.map((p) => [String(p.order), p]));
    const commissionRate = Math.max(0, Number(process.env.SELLER_COMMISSION_RATE || 0));

    const items = orders.map((o) => {
      const payment = paymentByOrder.get(String(o._id)) || {};
      const gross = round2(o.finalPrice || o.totalAmount || 0);
      const commission = round2(gross * commissionRate);
      const net = round2(Math.max(0, gross - commission));
      const paymentStatus = String(o.paymentStatus || "pending");
      const orderStatus = String(o.orderStatus || "");
      let settlementStatus = "not_ready";
      if (paymentStatus === "paid" && orderStatus === "delivered") settlementStatus = "ready_for_settlement";
      else if (paymentStatus === "paid") settlementStatus = "delivery_pending";
      else if (paymentStatus === "failed") settlementStatus = "payment_failed";
      else if (orderStatus === "cancelled") settlementStatus = "cancelled";

      return {
        order_id: String(o._id),
        created_at: o.createdAt,
        summary: o.summary || "Order",
        order_status: orderStatus,
        payment_status: paymentStatus,
        settlement_status: settlementStatus,
        gross,
        commission,
        net,
        provider_order_id: payment.providerOrderId || "",
        provider_payment_id: payment.providerPaymentId || "",
      };
    });

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.get("/kyc", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user.id }).lean();
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    const kyc = seller.sellerKyc || {};
    const n = Array.isArray(kyc.documents) ? kyc.documents.length : 0;
    const areas = Array.isArray(kyc.serviceAreas) ? kyc.serviceAreas : [];
    const bankSaved = Boolean(
      kyc.bankDetailsProvidedAt &&
        (String(kyc.bankIfsc || "").trim() || String(kyc.bankAccountNumber || "").trim())
    );
    const issued = Array.isArray(kyc.digilockerIssuedItems) ? kyc.digilockerIssuedItems : [];
    const issuedPreview = issued.map((row) => {
      const { uri: _u, ...rest } = row || {};
      return rest;
    });
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
        business: {
          completed_at: kyc.businessDetailsCompletedAt || null,
          locality: kyc.locality || "",
          service_areas: areas,
          offers_delivery: kyc.offersDelivery !== false,
        },
        bank_saved: bankSaved,
        live: {
          gst_checksum_ok: Boolean(kyc.gstinChecksumOk),
          gst_checksum_checked_at: kyc.gstinChecksumCheckedAt || null,
          gst_registry_active: Boolean(kyc.gstRegistryActive),
          gst_registry_legal_name: kyc.gstRegistryLegalName || "",
          gst_registry_checked_at: kyc.gstRegistryCheckedAt || null,
          gst_registry_warning: kyc.gstRegistryWarning || "",
          digilocker_linked_at: kyc.digilockerLinkedAt || null,
          digilocker_issued_synced_at: kyc.digilockerIssuedSyncedAt || null,
          digilocker_issued_docs: issuedPreview,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/notifications", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const rows = await NotificationDelivery.find({
      user: req.user.id,
      channel: "in_app",
      status: { $in: ["sent", "opened", "clicked"] },
    })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean();
    return res.json({
      items: rows.map((row) => ({
        notification_id: String(row._id),
        title: row.title || "Notification",
        body: row.body || "",
        click_url: row.clickUrl || "",
        created_at: row.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Live GST checks: (1) 15-digit format + checksum on server; (2) optional GET to GST_REGISTRY_LOOKUP_URL.
 */
router.post("/kyc/verify-gst", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const { gstin } = req.body || {};
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Shop is already verified" });
    }
    const st = seller.sellerKyc?.status || "awaiting_path";
    if (st === "submitted") {
      return res.status(400).json({ error: "GST cannot be changed while verification is under review" });
    }
    const chk = validateGstinChecksum(gstin);
    if (!chk.ok) {
      return badRequest(res, chk.error);
    }
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    seller.sellerKyc.gstNumber = chk.gstin;
    seller.sellerKyc.gstinChecksumOk = true;
    seller.sellerKyc.gstinChecksumCheckedAt = new Date();

    const registry = await gstRegistryLookupHttp(chk.gstin);
    let registry_warning = null;
    if (registry && !registry.skipped) {
      seller.sellerKyc.gstRegistryCheckedAt = new Date();
      if (registry.error) {
        registry_warning = registry.error;
        seller.sellerKyc.gstRegistryActive = false;
        seller.sellerKyc.gstRegistryLegalName = "";
        seller.sellerKyc.gstRegistryWarning = String(registry.error).slice(0, 500);
      } else {
        seller.sellerKyc.gstRegistryActive = !!registry.active;
        seller.sellerKyc.gstRegistryLegalName = String(registry.legal_name || "").slice(0, 200);
        seller.sellerKyc.gstRegistryWarning = "";
      }
    }

    await seller.save();
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({
      seller: formatSeller(fresh),
      gst_checksum_ok: true,
      gst_registry_active: !!(fresh.sellerKyc && fresh.sellerKyc.gstRegistryActive),
      gst_registry_legal_name: (fresh.sellerKyc && fresh.sellerKyc.gstRegistryLegalName) || "",
      registry_warning,
    });
  } catch (err) {
    return next(err);
  }
});

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/i;

/** Step 1 wizard — shop profile + locality / service areas (not allowed while documents are under review). */
router.post("/kyc/business-details", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const {
      shop_name,
      owner_name,
      categories,
      city,
      region,
      locality,
      service_areas,
      offers_delivery,
      gst_number,
      open_time,
      close_time,
    } = req.body || {};
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Shop is already verified" });
    }
    const st = seller.sellerKyc?.status || "awaiting_path";
    if (st === "submitted") {
      return res.status(400).json({ error: "Business details cannot be changed while verification is under review" });
    }
    const sn = String(shop_name || "").trim();
    if (!sn || sn.length > 160) {
      return badRequest(res, "shop_name is required (max 160 characters)");
    }
    const nextCats = normalizeSellerCategories(
      Array.isArray(categories) ? categories : categories != null ? [categories] : []
    );
    if (!nextCats.length) {
      return badRequest(res, "Select at least one business category");
    }
    const normalizedPlace = normalizeIndiaRegionCity(region, city);
    const c = normalizedPlace.city || String(city || "").trim();
    const r = normalizedPlace.region || String(region || "").trim();
    if (!c || !r) {
      return badRequest(res, "city and region are required");
    }
    const loc = String(locality || "").trim();
    if (!loc) {
      return badRequest(res, "locality (area) is required");
    }
    let areas = [];
    if (Array.isArray(service_areas)) {
      const seen = new Set();
      for (const x of service_areas) {
        const t = String(x || "").trim().slice(0, 100);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        areas.push(t);
        if (areas.length >= 20) break;
      }
    }
    const offers =
      offers_delivery === false || String(offers_delivery).toLowerCase() === "false" ? false : true;
    const openTime = String(open_time || "09:00").trim();
    const closeTime = String(close_time || "21:00").trim();
    if (!SHOP_TIME_RE.test(openTime) || !SHOP_TIME_RE.test(closeTime) || openTime === closeTime) {
      return badRequest(res, "Choose valid shop open and close times.");
    }

    seller.shopName = sn;
    seller.categories = nextCats;
    seller.category = nextCats[0];
    seller.city = c;
    seller.region = r;
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    seller.sellerKyc.locality = loc.slice(0, 200);
    seller.sellerKyc.serviceAreas = areas.length ? areas : [];
    seller.sellerKyc.offersDelivery = offers;
    seller.businessHours = normalizeBusinessHours({ open_time: openTime, close_time: closeTime });
    seller.sellerKyc.businessDetailsCompletedAt = new Date();
    if (gst_number != null && gst_number !== "") {
      seller.sellerKyc.gstNumber = String(gst_number).replace(/\s/g, "").toUpperCase().slice(0, 20);
    }
    await seller.save();

    const on = String(owner_name || "").trim().slice(0, 120);
    if (on) {
      await User.updateOne({ _id: req.user.id, role: "seller" }, { $set: { name: on, city: c, region: r } });
    } else {
      await User.updateOne({ _id: req.user.id, role: "seller" }, { $set: { city: c, region: r } });
    }

    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({ seller: formatSeller(fresh), message: "Business details saved" });
  } catch (err) {
    return next(err);
  }
});

router.patch("/business-hours", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const { open_time, close_time, weekly_hours } = req.body || {};
    const openTime = String(open_time || "").trim();
    const closeTime = String(close_time || "").trim();
    if (!SHOP_TIME_RE.test(openTime) || !SHOP_TIME_RE.test(closeTime) || openTime === closeTime) {
      return badRequest(res, "Choose valid shop open and close times.");
    }
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    const weeklySchedule = normalizeWeeklyHoursInput(weekly_hours, openTime, closeTime);
    seller.businessHours = normalizeBusinessHours({
      open_time: openTime,
      close_time: closeTime,
      weekly_hours: weeklySchedule,
    });
    await seller.save();
    return res.json({ seller: formatSeller(seller), message: "Shop opening hours saved" });
  } catch (err) {
    return next(err);
  }
});

/** Step 3 — optional payout bank (before or after document submit, until verified). */
router.patch("/storefront", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const { shop_images, storefront_tagline, menu_note } = req.body || {};
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    seller.shopImages = normalizeShopImages(shop_images);
    seller.storefrontTagline = String(storefront_tagline || "").trim().slice(0, 220);
    seller.menuNote = String(menu_note || "").trim().slice(0, 1200);
    await seller.save();
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({ seller: formatSeller(fresh), message: "Shop storefront saved" });
  } catch (err) {
    return next(err);
  }
});

router.post("/kyc/bank-details", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const { account_holder, ifsc, account_number } = req.body || {};
    const seller = await Seller.findOne({ user: req.user.id });
    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }
    if (seller.isVerified) {
      return res.status(400).json({ error: "Shop is already verified" });
    }
    const st = seller.sellerKyc?.status || "awaiting_path";
    if (st === "submitted") {
      return res.status(400).json({ error: "Bank details cannot be changed while verification is under review" });
    }
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    const holder = String(account_holder || "").trim().slice(0, 120);
    const ifscClean = String(ifsc || "").trim().toUpperCase().slice(0, 11);
    const acct = String(account_number || "").replace(/\s/g, "").slice(0, 24);

    if (!holder && !ifscClean && !acct) {
      seller.sellerKyc.bankAccountHolder = "";
      seller.sellerKyc.bankIfsc = "";
      seller.sellerKyc.bankAccountNumber = "";
      seller.sellerKyc.bankDetailsProvidedAt = null;
      await seller.save();
      const fresh = await Seller.findOne({ user: req.user.id }).lean();
      return res.json({ seller: formatSeller(fresh), message: "Bank details cleared" });
    }
    if (!holder || holder.length < 2) {
      return badRequest(res, "account_holder is required when saving bank details");
    }
    if (!IFSC_RE.test(ifscClean)) {
      return badRequest(res, "Enter a valid 11-character IFSC");
    }
    if (!acct || acct.length < 5) {
      return badRequest(res, "account_number looks invalid");
    }
    seller.sellerKyc.bankAccountHolder = holder;
    seller.sellerKyc.bankIfsc = ifscClean;
    seller.sellerKyc.bankAccountNumber = acct;
    seller.sellerKyc.bankDetailsProvidedAt = new Date();
    await seller.save();
    const fresh = await Seller.findOne({ user: req.user.id }).lean();
    return res.json({ seller: formatSeller(fresh), message: "Bank details saved" });
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
