const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Seller = require("../models/Seller");
const Request = require("../models/Request");
const Quote = require("../models/Quote");
const Order = require("../models/Order");
const Dispute = require("../models/Dispute");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatRequest, formatOrder, formatDispute, formatSeller } = require("../lib/format");
const { sendMail } = require("../services/email");

const router = express.Router();

/** Read-only pipeline counts — shared with field sales portal. */
/** Shopkeepers waiting for eKYC (field visit or document review). */
router.get("/seller-kyc/pending", requireAuth, requireRole("admin", "sales"), async (_req, res, next) => {
  try {
    const filter = {
      isVerified: false,
      $or: [{ "sellerKyc.status": "salesman_pending" }, { "sellerKyc.status": "submitted" }],
    };
    const rows = await Seller.find(filter)
      .sort({ updatedAt: -1 })
      .limit(100)
      .populate("user", "name email phone city region createdAt")
      .lean();
    const items = rows.map((s) => {
      const u = s.user && typeof s.user === "object" ? s.user : null;
      const kyc = s.sellerKyc || {};
      return {
        seller_id: String(s._id),
        shop_name: s.shopName,
        city: s.city,
        region: s.region,
        kyc_status: kyc.status,
        kyc_path: kyc.path || "",
        document_count: Array.isArray(kyc.documents) ? kyc.documents.length : 0,
        submitted_at: kyc.submittedAt || null,
        salesman_requested_at: kyc.salesmanRequestedAt || null,
        owner_name: u ? u.name : "—",
        owner_email: u ? u.email : "—",
        owner_phone: u ? u.phone || "" : "",
      };
    });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.patch("/seller-kyc/:sellerId", requireAuth, requireRole("admin", "sales"), async (req, res, next) => {
  try {
    const sid = req.params.sellerId;
    if (!mongoose.isValidObjectId(sid)) {
      return res.status(400).json({ error: "Invalid seller id" });
    }
    const { action, rejection_reason } = req.body || {};
    if (!["verify", "reject"].includes(action)) {
      return res.status(400).json({ error: "action must be verify or reject" });
    }
    const seller = await Seller.findById(sid).populate("user", "name email");
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    const st = seller.sellerKyc.status;
    if (action === "verify") {
      if (!["submitted", "salesman_pending"].includes(st)) {
        return res.status(400).json({ error: "Seller is not in a state that can be verified from the queue" });
      }
      seller.isVerified = true;
      seller.sellerKyc.status = "verified";
      seller.sellerKyc.verifiedAt = new Date();
      seller.sellerKyc.rejectedReason = "";
      await seller.save();
      const u = seller.user;
      const email = u && u.email;
      if (email) {
        try {
          await sendMail({
            to: email,
            subject: "Your Bachat shop verification is complete",
            text: `Hi ${(u && u.name) || ""},\n\nYour shop eKYC / business verification on Bachat is approved. You can now sign in and use the full Shopkeeper dashboard.\n\n— Bachat`,
            html: `<p>Hi ${(u && u.name) || "there"},</p><p>Your <strong>shop eKYC / business verification</strong> on Bachat is <strong>approved</strong>. You can now sign in and use the full Shopkeeper dashboard.</p><p>— Bachat</p>`,
          });
        } catch (e) {
          console.error("[seller-kyc-verify-mail]", e.message || e);
        }
      }
      return res.json({ seller: formatSeller(seller.toObject ? seller.toObject() : seller), message: "Verified" });
    }
    if (st !== "submitted" && st !== "salesman_pending") {
      return res.status(400).json({ error: "Only pending sellers can be rejected from this queue" });
    }
    seller.sellerKyc.status = "rejected";
    seller.sellerKyc.rejectedReason = String(rejection_reason || "Please resubmit or choose another verification option.").slice(
      0,
      2000
    );
    seller.isVerified = false;
    await seller.save();
    const u2 = seller.user;
    if (u2 && u2.email) {
      try {
        const reasonEsc = String(seller.sellerKyc.rejectedReason || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        await sendMail({
          to: u2.email,
          subject: "Bachat shop verification needs attention",
          text: `Hi ${u2.name || ""},\n\nWe could not approve your verification yet.\nReason: ${seller.sellerKyc.rejectedReason}\n\nPlease sign in to Bachat and complete verification again.\n\n— Bachat`,
          html: `<p>Hi ${u2.name || "there"},</p><p>We could not approve your verification yet.</p><p><strong>Reason:</strong></p><p style="white-space:pre-wrap">${reasonEsc}</p><p>Please sign in to Bachat and complete verification again.</p><p>— Bachat</p>`,
        });
      } catch (e) {
        console.error("[seller-kyc-reject-mail]", e.message || e);
      }
    }
    return res.json({ seller: formatSeller(seller.toObject()), message: "Rejected" });
  } catch (err) {
    return next(err);
  }
});

router.get("/sales-pipeline", requireAuth, requireRole("admin", "sales"), async (_req, res, next) => {
  try {
    const [sellers, verified, buyers] = await Promise.all([
      Seller.countDocuments(),
      Seller.countDocuments({ isVerified: true }),
      User.countDocuments({ role: "buyer" }),
    ]);
    return res.json({
      sellers_total: sellers,
      sellers_verified: verified,
      sellers_pending_verify: sellers - verified,
      buyers_total: buyers,
      note: "Lightweight pipeline counts; CRM leads live under /api/leads.",
    });
  } catch (err) {
    return next(err);
  }
});

router.use(requireAuth, requireRole("admin"));

function qsInt(v, def, min, max) {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

router.get("/orders", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 40, 1, 100);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const [total, rows] = await Promise.all([
      Order.countDocuments(),
      Order.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .populate("seller", "shopName")
        .lean(),
    ]);
    const items = rows.map((o) => ({
      ...formatOrder(o),
      user_name: (o.user && o.user.name) || "—",
      user_email: (o.user && o.user.email) || "",
      shop_name: (o.seller && o.seller.shopName) || "—",
    }));
    return res.json({ total, items });
  } catch (err) {
    return next(err);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 30, 1, 100);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const q = String(req.query.q || "").trim();
    const filter = {};
    if (req.query.role) {
      filter.role = String(req.query.role);
    }
    if (q) {
      const rx = new RegExp(escapeRegExp(q), "i");
      filter.$or = [{ email: rx }, { name: rx }, { phone: rx }];
    }
    const [total, rows] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("email name role phone city region emailVerifiedAt phoneVerifiedAt createdAt referralCode")
        .lean(),
    ]);
    return res.json({
      total,
      items: rows.map((u) => ({
        user_id: String(u._id),
        email: u.email,
        name: u.name,
        role: u.role,
        phone: u.phone || "",
        city: u.city,
        region: u.region,
        email_verified_at: u.emailVerifiedAt || null,
        phone_verified_at: u.phoneVerifiedAt || null,
        referral_code: u.referralCode || null,
        created_at: u.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/sellers", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 30, 1, 100);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const [total, rows] = await Promise.all([
      Seller.countDocuments(),
      Seller.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "email name phone")
        .lean(),
    ]);
    return res.json({
      total,
      items: rows.map((s) => ({
        seller_id: String(s._id),
        user_id: String(s.user && s.user._id),
        owner_email: (s.user && s.user.email) || "",
        owner_name: (s.user && s.user.name) || "",
        shop_name: s.shopName,
        categories: s.categories || [],
        city: s.city,
        region: s.region,
        is_verified: !!s.isVerified,
        created_at: s.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/requests", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 40, 1, 100);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const filter = {};
    if (req.query.status) {
      filter.status = String(req.query.status);
    }
    const [total, rows] = await Promise.all([
      Request.countDocuments(filter),
      Request.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
    ]);
    return res.json({
      total,
      items: rows.map((r) => ({
        ...formatRequest(r),
        buyer_name: (r.user && r.user.name) || "—",
        buyer_email: (r.user && r.user.email) || "",
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/finance-summary", async (_req, res, next) => {
  try {
    const [paidAgg, byPayment, byOrder] = await Promise.all([
      Order.aggregate([
        { $match: { paymentStatus: "paid" } },
        { $group: { _id: null, sum: { $sum: "$totalAmount" }, n: { $sum: 1 } } },
      ]),
      Order.aggregate([{ $group: { _id: "$paymentStatus", n: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: "$orderStatus", n: { $sum: 1 } } }]),
    ]);
    const paid = paidAgg[0] || { sum: 0, n: 0 };
    return res.json({
      paid_revenue_inr: paid.sum || 0,
      paid_orders: paid.n || 0,
      payment_breakdown: Object.fromEntries(byPayment.map((x) => [x._id, x.n])),
      order_status_breakdown: Object.fromEntries(byOrder.map((x) => [x._id, x.n])),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/marketing-summary", async (_req, res, next) => {
  try {
    const [withRef, buyers] = await Promise.all([
      User.countDocuments({ referredBy: { $ne: null } }),
      User.countDocuments({ role: "buyer" }),
    ]);
    return res.json({
      buyers_total: buyers,
      signups_with_referrer: withRef,
      note: "Referral attribution when referredBy is set at signup.",
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/notifications-summary", async (_req, res, next) => {
  try {
    const [kycPending, openReq] = await Promise.all([
      User.countDocuments({ role: "delivery", "deliveryKyc.status": "submitted" }),
      Request.countDocuments({ status: "open" }),
    ]);
    return res.json({
      delivery_kyc_pending_review: kycPending,
      open_buyer_requests: openReq,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/disputes", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 40, 1, 100);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const filter = {};
    if (req.query.status) {
      filter.status = String(req.query.status);
    }
    const [total, rows] = await Promise.all([
      Dispute.countDocuments(filter),
      Dispute.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("buyerUser", "name email")
        .populate("order", "totalAmount paymentStatus orderStatus")
        .lean(),
    ]);
    const items = rows.map((d) => {
      const base = formatDispute(d);
      const bu = d.buyerUser && typeof d.buyerUser === "object" ? d.buyerUser : null;
      const ord = d.order && typeof d.order === "object" ? d.order : null;
      return {
        ...base,
        buyer_name: bu ? bu.name || "—" : "—",
        buyer_email: bu ? bu.email || "" : "",
        order_total_inr: ord ? ord.totalAmount : null,
        order_payment_status: ord ? ord.paymentStatus : null,
        order_status: ord ? ord.orderStatus : null,
      };
    });
    return res.json({ total, items });
  } catch (err) {
    return next(err);
  }
});

router.patch("/disputes/:disputeId", async (req, res, next) => {
  try {
    const id = req.params.disputeId;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid dispute id" });
    }
    const { status, resolution_notes } = req.body || {};
    const allowed = ["open", "under_review", "resolved_refund", "resolved_denied", "closed"];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: "status must be one of: " + allowed.join(", ") });
    }
    const doc = await Dispute.findById(id);
    if (!doc) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    doc.status = status;
    if (resolution_notes != null) {
      doc.resolutionNotes = String(resolution_notes).slice(0, 8000);
    }
    doc.events.push({
      at: new Date(),
      message: `Status set to ${status}` + (doc.resolutionNotes ? ` — ${doc.resolutionNotes.slice(0, 500)}` : ""),
      authorRole: "admin",
      authorUser: req.user.id,
    });
    await doc.save();
    return res.json(formatDispute(doc.toObject()));
  } catch (err) {
    return next(err);
  }
});

router.get("/analytics-events", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 50, 1, 200);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const days = qsInt(req.query.since_days, 7, 1, 90);
    const since = new Date(Date.now() - days * 86400000);
    const filter = { createdAt: { $gte: since } };
    if (req.query.type) {
      filter.type = String(req.query.type);
    }
    const [total, rows] = await Promise.all([
      AnalyticsEvent.countDocuments(filter),
      AnalyticsEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return res.json({
      total,
      items: rows.map((r) => ({
        id: String(r._id),
        type: r.type,
        user_id: r.user ? String(r.user) : null,
        order_id: r.order ? String(r.order) : null,
        meta: r.meta || {},
        created_at: r.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/analytics-rollup", async (req, res, next) => {
  try {
    const days = qsInt(req.query.since_days, 7, 1, 90);
    const since = new Date(Date.now() - days * 86400000);
    const rows = await AnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$type", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    return res.json({
      since: since.toISOString(),
      days,
      by_type: Object.fromEntries(rows.map((x) => [x._id, x.n])),
    });
  } catch (err) {
    return next(err);
  }
});

/** Orders that may need ops attention (not a full dispute model). */
router.get("/dispute-signals", async (_req, res, next) => {
  try {
    const rows = await Order.find({
      $or: [{ paymentStatus: { $in: ["failed", "refunded"] } }, { orderStatus: "cancelled" }],
    })
      .sort({ createdAt: -1 })
      .limit(40)
      .populate("user", "name email")
      .lean();
    return res.json({
      items: rows.map((o) => ({
        ...formatOrder(o),
        user_name: (o.user && o.user.name) || "—",
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/platform-modules", (_req, res) => {
  return res.json({
    modules: [
      { id: "core_marketplace", label: "Buyer · seller · quotes · orders", status: "live" },
      { id: "catalog_cart", label: "Catalog, cart, saved", status: "live" },
      { id: "payments", label: "Razorpay checkout + webhook", status: "partial", detail: "API present; polish buyer/seller payment UX." },
      { id: "delivery", label: "Delivery pool, KYC, DigiLocker", status: "partial", detail: "See /api/delivery, admin-delivery, delivery-kyc.html" },
      { id: "disputes", label: "Disputes / chargebacks", status: "live", detail: "GET /api/disputes, /api/admin/disputes; dispute-signals for payment flags." },
      { id: "city_ops", label: "City coverage & heatmaps", status: "planned" },
      { id: "field_sales", label: "Field sales CRM", status: "live", detail: "GET/POST/PATCH /api/leads (admin + sales)." },
      { id: "notifications", label: "Notification centre & rules", status: "partial", detail: "Admin summary endpoint only." },
      { id: "analytics", label: "Warehouse analytics", status: "live", detail: "AnalyticsEvent + /api/admin/analytics-*." },
      { id: "team_2fa", label: "Team portal + 2FA + OIDC", status: "live", detail: "TOTP for admin/sales; /api/auth/oidc/team/* when OIDC_* env set." },
    ],
  });
});

module.exports = router;
