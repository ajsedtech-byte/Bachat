const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Seller = require("../models/Seller");
const Request = require("../models/Request");
const Quote = require("../models/Quote");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Dispute = require("../models/Dispute");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const Lead = require("../models/Lead");
const CityArea = require("../models/CityArea");
const NotificationRule = require("../models/NotificationRule");
const NotificationCampaign = require("../models/NotificationCampaign");
const NotificationDelivery = require("../models/NotificationDelivery");
const DeliveryAudit = require("../models/DeliveryAudit");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatRequest, formatOrder, formatDispute, formatSeller } = require("../lib/format");
const { SELLER_KYC_DOC_KINDS, MAX_DOC_CHARS, MAX_DOCS } = require("../lib/sellerKycDocs");
const { sendMail } = require("../services/email");
const { dispatchCampaign, dispatchDueCampaigns } = require("../services/notificationDispatcher");

const router = express.Router();
const SELLER_DOC_KIND_SET = new Set(SELLER_KYC_DOC_KINDS);
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/i;
const DOC_LABELS = {
  shop_photo: "Shop photo",
  gst_cert: "GST certificate",
  aadhaar: "Aadhaar",
  udyam: "Udyam",
  pan: "PAN card",
  government_id: "Government-issued ID",
  proof_of_address: "Proof of address",
  business_registration: "Business registration document",
  banking_details: "Banking details",
  other: "Other document",
};

function invalidInput(message) {
  const err = new Error(message);
  err.status = 400;
  err.publicMessage = message;
  return err;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sellerKycApprovedMail({ name, loginUrl }) {
  const safeName = escapeHtml(name || "there");
  const safeLoginUrl = escapeHtml(loginUrl);
  const itemFields = [
    "Item Title",
    "Details",
    "Price",
    "Available Quantity",
    "Quantity Unit",
    "Package Type",
    "Package size/variant",
    "Photos: up to 4 images",
  ];
  return {
    subject: "You are verified now - Bachat Shopkeeper",
    text:
      `Hi ${name || ""},\n\n` +
      "Congratulations! Your Bachat shop verification has been approved.\n\n" +
      "Your shopkeeper account is now verified, and you can start using the Bachat seller platform to add items, manage your shop details, and prepare your products for local buyers.\n\n" +
      `Login to your seller dashboard: ${loginUrl}\n\n` +
      "Next step: add your items on Bachat\n" +
      "Please sign in to your shopkeeper dashboard and add the products/items you want to sell on Bachat. Clear item details and good photos help buyers understand your products and place orders with confidence.\n\n" +
      "If you are not able to add items from the dashboard, you can send the item details over email in this format:\n\n" +
      itemFields.map((field) => `${field}:`).join("\n") +
      "\n\nFor photos, please attach up to 4 clear product images per item.\n\n" +
      "Our team may review listings for quality, completeness, and marketplace safety before they appear to customers.\n\n" +
      "Thank you for joining Bachat. We are excited to help your shop reach more local customers.\n\n" +
      "Regards,\nTeam Bachat",
    html:
      `<p>Hi ${safeName},</p>` +
      "<p><strong>Congratulations! Your Bachat shop verification has been approved.</strong></p>" +
      "<p>Your shopkeeper account is now verified, and you can start using the Bachat seller platform to add items, manage your shop details, and prepare your products for local buyers.</p>" +
      `<p><a href="${safeLoginUrl}">Log in to your seller dashboard</a></p>` +
      "<p><strong>Next step: add your items on Bachat</strong></p>" +
      "<p>Please sign in to your shopkeeper dashboard and add the products/items you want to sell on Bachat. Clear item details and good photos help buyers understand your products and place orders with confidence.</p>" +
      "<p>If you are not able to add items from the dashboard, you can send the item details over email in this format:</p>" +
      `<ul>${itemFields.map((field) => `<li><strong>${escapeHtml(field)}:</strong></li>`).join("")}</ul>` +
      "<p>For photos, please attach up to <strong>4 clear product images per item</strong>.</p>" +
      "<p>Our team may review listings for quality, completeness, and marketplace safety before they appear to customers.</p>" +
      "<p>Thank you for joining Bachat. We are excited to help your shop reach more local customers.</p>" +
      "<p>Regards,<br>Team Bachat</p>",
  };
}

function cleanText(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function cleanUpper(value, max) {
  return cleanText(value, max).toUpperCase();
}

function boolish(value) {
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
}

function docLabel(kind) {
  return DOC_LABELS[kind] || cleanText(kind, 40) || "Document";
}

function mapKycDocument(doc) {
  return {
    document_id: doc && doc._id ? String(doc._id) : "",
    kind: doc && doc.kind ? doc.kind : "",
    kind_label: docLabel(doc && doc.kind ? doc.kind : ""),
    filename: doc && doc.filename ? doc.filename : "",
    mime_type: doc && doc.mimeType ? doc.mimeType : "",
    content: doc && doc.content ? doc.content : "",
    uploaded_at: doc && doc.uploadedAt ? doc.uploadedAt : null,
  };
}

function mapFieldReview(review) {
  const r = review || {};
  return {
    collected_by_user_id: r.collectedByUser ? String(r.collectedByUser) : null,
    collected_by_role: r.collectedByRole || "",
    collected_by_name: r.collectedByName || "",
    collected_at: r.collectedAt || null,
    notes: r.notes || "",
    aadhaar_last4: r.aadhaarLast4 || "",
    pan_number: r.panNumber || "",
    government_id_type: r.governmentIdType || "",
    government_id_number: r.governmentIdNumber || "",
    proof_of_address_type: r.proofOfAddressType || "",
    proof_of_address_number: r.proofOfAddressNumber || "",
    business_registration_type: r.businessRegistrationType || "",
    business_registration_number: r.businessRegistrationNumber || "",
    bank_account_holder: r.bankAccountHolder || "",
    bank_ifsc: r.bankIfsc || "",
    bank_account_number: r.bankAccountNumber || "",
    aadhaar_matches_image: !!r.aadhaarMatchesImage,
    pan_matches_image: !!r.panMatchesImage,
    government_id_matches_image: !!r.governmentIdMatchesImage,
    proof_of_address_matches_image: !!r.proofOfAddressMatchesImage,
    business_registration_matches_image: !!r.businessRegistrationMatchesImage,
    banking_details_match_image: !!r.bankingDetailsMatchImage,
  };
}

function sanitizeKycDocuments(documents) {
  if (!Array.isArray(documents)) {
    throw invalidInput("documents must be an array");
  }
  const next = [];
  for (const row of documents.slice(0, MAX_DOCS)) {
    const kind = cleanText(row && row.kind ? row.kind : "", 40);
    if (!SELLER_DOC_KIND_SET.has(kind)) {
      throw invalidInput("Invalid document kind: " + kind);
    }
    const content = String(row && (row.data || row.content) ? row.data || row.content : "").trim();
    if (!content) {
      throw invalidInput(`Upload content is required for ${docLabel(kind)}`);
    }
    if (content.length > MAX_DOC_CHARS) {
      throw invalidInput(`A ${docLabel(kind)} file is too large`);
    }
    next.push({
      kind,
      filename: cleanText(row && row.filename ? row.filename : "upload", 200),
      mimeType: cleanText(row && (row.mime_type || row.mimeType) ? row.mime_type || row.mimeType : "application/octet-stream", 120),
      content,
      uploadedAt: new Date(),
    });
  }
  return next;
}

function mergeFieldReview(existing, incoming, actor) {
  const base = existing && typeof existing.toObject === "function" ? existing.toObject() : { ...(existing || {}) };
  const src = incoming && typeof incoming === "object" ? incoming : {};
  const textFields = [
    ["notes", 2000, cleanText],
    ["aadhaarLast4", 4, cleanText],
    ["panNumber", 10, cleanUpper],
    ["governmentIdType", 80, cleanText],
    ["governmentIdNumber", 80, cleanText],
    ["proofOfAddressType", 80, cleanText],
    ["proofOfAddressNumber", 80, cleanText],
    ["businessRegistrationType", 80, cleanText],
    ["businessRegistrationNumber", 80, cleanText],
    ["bankAccountHolder", 120, cleanText],
    ["bankIfsc", 11, cleanUpper],
    ["bankAccountNumber", 24, cleanText],
  ];
  const boolFields = [
    "aadhaarMatchesImage",
    "panMatchesImage",
    "governmentIdMatchesImage",
    "proofOfAddressMatchesImage",
    "businessRegistrationMatchesImage",
    "bankingDetailsMatchImage",
  ];
  let touched = false;
  for (const [key, max, cleaner] of textFields) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      base[key] = cleaner(src[key], max);
      touched = true;
    }
  }
  for (const key of boolFields) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      base[key] = boolish(src[key]);
      touched = true;
    }
  }
  if (touched) {
    base.collectedByUser = actor && actor._id ? actor._id : null;
    base.collectedByRole = actor && actor.role ? actor.role : "";
    base.collectedByName = cleanText((actor && (actor.name || actor.email)) || "", 120);
    base.collectedAt = new Date();
  }
  return base;
}

function syncReviewedBankDetails(seller) {
  const review = seller && seller.sellerKyc ? seller.sellerKyc.fieldReview : null;
  if (!review) return;
  const holder = cleanText(review.bankAccountHolder, 120);
  const ifsc = cleanUpper(review.bankIfsc, 11);
  const accountNumber = cleanText(review.bankAccountNumber, 24);
  if (!holder && !ifsc && !accountNumber) return;
  seller.sellerKyc.bankAccountHolder = holder;
  seller.sellerKyc.bankIfsc = ifsc;
  seller.sellerKyc.bankAccountNumber = accountNumber;
  seller.sellerKyc.bankDetailsProvidedAt = new Date();
}

function validateFieldSalesApproval(seller) {
  const kyc = seller && seller.sellerKyc ? seller.sellerKyc : {};
  const review = kyc.fieldReview || {};
  const docs = Array.isArray(kyc.documents) ? kyc.documents : [];
  const docKinds = new Set(docs.map((doc) => String(doc && doc.kind ? doc.kind : "")));
  const hasDoc = (kind) => docKinds.has(kind);
  const hasAny = (...values) => values.some((value) => cleanText(value, 120));
  const aadhaarLast4 = String(review.aadhaarLast4 || "");
  const panNumber = String(review.panNumber || "");
  const hasGovernmentId = hasDoc("government_id") || hasAny(review.governmentIdType, review.governmentIdNumber);
  const hasProofOfAddress = hasDoc("proof_of_address") || hasAny(review.proofOfAddressType, review.proofOfAddressNumber);
  const hasBusinessRegistration =
    hasDoc("business_registration") || hasAny(review.businessRegistrationType, review.businessRegistrationNumber);
  const hasBankingDetails =
    hasDoc("banking_details") || hasAny(review.bankAccountHolder, review.bankIfsc, review.bankAccountNumber);

  if ((hasDoc("aadhaar") || aadhaarLast4) && !/^\d{4}$/.test(aadhaarLast4)) {
    return "Enter Aadhaar last 4 digits";
  }
  if ((hasDoc("pan") || panNumber) && !PAN_RE.test(panNumber)) {
    return "Enter a valid PAN number";
  }
  if (hasGovernmentId && !cleanText(review.governmentIdType, 80)) {
    return "Enter the government-issued ID type";
  }
  if (hasGovernmentId && !cleanText(review.governmentIdNumber, 80)) {
    return "Enter the government-issued ID number";
  }
  if (hasProofOfAddress && !cleanText(review.proofOfAddressType, 80)) {
    return "Enter the proof of address type";
  }
  if (hasBusinessRegistration && !cleanText(review.businessRegistrationType, 80)) {
    return "Enter the business registration document type";
  }
  if (hasBusinessRegistration && !cleanText(review.businessRegistrationNumber, 80)) {
    return "Enter the business registration number";
  }
  if (hasBankingDetails && !cleanText(review.bankAccountHolder, 120)) {
    return "Enter the bank account holder name";
  }
  if (hasBankingDetails && !IFSC_RE.test(String(review.bankIfsc || ""))) {
    return "Enter a valid IFSC code";
  }
  if (hasBankingDetails && cleanText(review.bankAccountNumber, 24).length < 5) {
    return "Enter a valid bank account number";
  }
  const confirmations = [
    ["aadhaarMatchesImage", "Aadhaar", hasDoc("aadhaar")],
    ["panMatchesImage", "PAN card", hasDoc("pan")],
    ["governmentIdMatchesImage", "Government-issued ID", hasDoc("government_id")],
    ["proofOfAddressMatchesImage", "Proof of address", hasDoc("proof_of_address")],
    ["businessRegistrationMatchesImage", "Business registration", hasDoc("business_registration")],
    ["bankingDetailsMatchImage", "Banking details", hasDoc("banking_details")],
  ].filter(([key, _label, required]) => required && !review[key]);
  if (confirmations.length) {
    return `Confirm the document match checks for: ${confirmations.map((row) => row[1]).join(", ")}`;
  }
  return "";
}

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
        review_started_at: kyc.fieldReview && kyc.fieldReview.collectedAt ? kyc.fieldReview.collectedAt : null,
        gst_checksum_ok: Boolean(kyc.gstinChecksumOk),
        gst_registry_active: Boolean(kyc.gstRegistryActive),
        digilocker_linked: Boolean(kyc.digilockerLinkedAt),
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

router.get("/seller-kyc/:sellerId", requireAuth, requireRole("admin", "sales"), async (req, res, next) => {
  try {
    const sid = req.params.sellerId;
    if (!mongoose.isValidObjectId(sid)) {
      return res.status(400).json({ error: "Invalid seller id" });
    }
    const seller = await Seller.findById(sid).populate("user", "name email phone city region createdAt").lean();
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }
    const user = seller.user && typeof seller.user === "object" ? seller.user : null;
    const kyc = seller.sellerKyc || {};
    const liveDocs = Array.isArray(kyc.documents) ? kyc.documents.map(mapKycDocument) : [];
    return res.json({
      seller: formatSeller(seller),
      owner: {
        name: user ? user.name || "" : "",
        email: user ? user.email || "" : "",
        phone: user ? user.phone || "" : "",
        city: user ? user.city || "" : "",
        region: user ? user.region || "" : "",
        created_at: user ? user.createdAt || null : null,
      },
      kyc: {
        status: kyc.status || "awaiting_path",
        path: kyc.path || "",
        gst_number: kyc.gstNumber || "",
        submitted_at: kyc.submittedAt || null,
        verified_at: kyc.verifiedAt || null,
        salesman_requested_at: kyc.salesmanRequestedAt || null,
        rejected_reason: kyc.rejectedReason || "",
        document_count: liveDocs.length,
        documents: liveDocs,
        business: {
          locality: kyc.locality || "",
          service_areas: Array.isArray(kyc.serviceAreas) ? kyc.serviceAreas : [],
          offers_delivery: kyc.offersDelivery !== false,
          completed_at: kyc.businessDetailsCompletedAt || null,
        },
        bank: {
          account_holder: kyc.bankAccountHolder || "",
          ifsc: kyc.bankIfsc || "",
          account_number: kyc.bankAccountNumber || "",
          saved_at: kyc.bankDetailsProvidedAt || null,
        },
        field_review: mapFieldReview(kyc.fieldReview),
        live: {
          gst_checksum_ok: Boolean(kyc.gstinChecksumOk),
          gst_checksum_checked_at: kyc.gstinChecksumCheckedAt || null,
          gst_registry_active: Boolean(kyc.gstRegistryActive),
          gst_registry_legal_name: kyc.gstRegistryLegalName || "",
          gst_registry_checked_at: kyc.gstRegistryCheckedAt || null,
          gst_registry_warning: kyc.gstRegistryWarning || "",
          digilocker_linked_at: kyc.digilockerLinkedAt || null,
          digilocker_issued_synced_at: kyc.digilockerIssuedSyncedAt || null,
          digilocker_issued_docs: Array.isArray(kyc.digilockerIssuedItems)
            ? kyc.digilockerIssuedItems.map((row) => {
                const { uri: _uri, ...rest } = row || {};
                return rest;
              })
            : [],
        },
      },
    });
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
    const { action, rejection_reason, review, documents } = req.body || {};
    if (!["save_review", "verify", "reject"].includes(action)) {
      return res.status(400).json({ error: "action must be save_review, verify, or reject" });
    }
    const [seller, actor] = await Promise.all([
      Seller.findById(sid).populate("user", "name email phone"),
      User.findById(req.user.id).select("name email role").lean(),
    ]);
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }
    if (!seller.sellerKyc) {
      seller.sellerKyc = {};
    }
    const st = seller.sellerKyc.status;
    if (documents !== undefined) {
      seller.sellerKyc.documents = sanitizeKycDocuments(documents);
    }
    if (review && typeof review === "object") {
      seller.sellerKyc.fieldReview = mergeFieldReview(seller.sellerKyc.fieldReview, review, actor);
      syncReviewedBankDetails(seller);
    }
    if (action === "save_review") {
      if (!["salesman_pending", "submitted"].includes(st)) {
        return res.status(400).json({ error: "Only pending seller eKYC records can be updated" });
      }
      await seller.save();
      return res.json({
        seller: formatSeller(seller.toObject ? seller.toObject() : seller),
        field_review: mapFieldReview(seller.sellerKyc.fieldReview),
        document_count: Array.isArray(seller.sellerKyc.documents) ? seller.sellerKyc.documents.length : 0,
        message: "Field review saved",
      });
    }
    if (action === "verify") {
      if (!["submitted", "salesman_pending"].includes(st)) {
        return res.status(400).json({ error: "Seller is not in a state that can be verified from the queue" });
      }
      if (seller.sellerKyc.path === "salesman") {
        const validationMessage = validateFieldSalesApproval(seller);
        if (validationMessage) {
          return res.status(400).json({ error: validationMessage });
        }
      }
      seller.isVerified = true;
      seller.sellerKyc.status = "verified";
      seller.sellerKyc.verifiedAt = new Date();
      seller.sellerKyc.submittedAt = seller.sellerKyc.submittedAt || new Date();
      seller.sellerKyc.rejectedReason = "";
      syncReviewedBankDetails(seller);
      await seller.save();
      const u = seller.user;
      const email = u && u.email;
      if (email) {
        try {
          const loginUrl = "https://bachat.seekhen.com/login.html";
          const mail = sellerKycApprovedMail({ name: (u && u.name) || "", loginUrl });
          await sendMail({
            to: email,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
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
    if (err && err.status) {
      return res.status(err.status).json({ error: err.publicMessage || err.message });
    }
    return next(err);
  }
});

router.get("/sales-pipeline", requireAuth, requireRole("admin", "sales"), async (req, res, next) => {
  try {
    const leadBase =
      req.user.role === "admin"
        ? {}
        : { $or: [{ ownerUser: null }, { ownerUser: req.user.id }] };
    const [sellers, verified, buyers, leads_total, stageAgg] = await Promise.all([
      Seller.countDocuments(),
      Seller.countDocuments({ isVerified: true }),
      User.countDocuments({ role: "buyer" }),
      Lead.countDocuments(leadBase),
      Lead.aggregate([
        { $match: leadBase },
        { $group: { _id: "$stage", n: { $sum: 1 } } },
      ]),
    ]);
    const leads_by_stage = {};
    stageAgg.forEach((row) => {
      if (row && row._id) leads_by_stage[row._id] = row.n;
    });
    return res.json({
      sellers_total: sellers,
      sellers_verified: verified,
      sellers_pending_verify: sellers - verified,
      buyers_total: buyers,
      leads_total,
      leads_by_stage,
      note: "Pipeline + CRM lead counts for your access scope.",
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

function cleanShort(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

async function estimateAudience({ audience, city, region }) {
  const roles =
    audience === "all"
      ? ["buyer", "seller", "delivery", "sales", "admin"]
      : audience === "buyers"
      ? ["buyer"]
      : audience === "sellers"
      ? ["seller"]
      : audience === "admins"
      ? ["admin"]
      : [audience];
  const filter = { role: { $in: roles } };
  if (city) filter.city = new RegExp(`^${escapeRegExp(city)}$`, "i");
  if (region) filter.region = new RegExp(`^${escapeRegExp(region)}$`, "i");
  return User.countDocuments(filter);
}

function fmtCityArea(row, metrics = {}) {
  return {
    area_id: row && row._id ? String(row._id) : "",
    city: row.city,
    region: row.region,
    active: row.active !== false,
    priority: row.priority || "normal",
    service_radius_km: row.serviceRadiusKm || 0,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    notes: row.notes || "",
    metrics,
    updated_at: row.updatedAt || null,
  };
}

function avgCoords(items) {
  const pts = items
    .map((x) => x && x.location)
    .filter((loc) => Number.isFinite(Number(loc?.lat)) && Number.isFinite(Number(loc?.lng)));
  if (!pts.length) return { lat: null, lng: null };
  return {
    lat: Math.round((pts.reduce((s, p) => s + Number(p.lat), 0) / pts.length) * 1000000) / 1000000,
    lng: Math.round((pts.reduce((s, p) => s + Number(p.lng), 0) / pts.length) * 1000000) / 1000000,
  };
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
    const commissionRate = Math.max(0, Number(process.env.SELLER_COMMISSION_RATE || 0));
    const [paidAgg, failedAgg, refundAgg, byPayment, byOrder, recentPayments] = await Promise.all([
      Order.aggregate([
        { $match: { paymentStatus: "paid" } },
        { $group: { _id: null, sum: { $sum: "$totalAmount" }, n: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { paymentStatus: "failed" } },
        { $group: { _id: null, sum: { $sum: "$totalAmount" }, n: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { paymentStatus: "refunded" } },
        { $group: { _id: null, sum: { $sum: "$totalAmount" }, n: { $sum: 1 } } },
      ]),
      Order.aggregate([{ $group: { _id: "$paymentStatus", n: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: "$orderStatus", n: { $sum: 1 } } }]),
      Payment.find({}).sort({ updatedAt: -1 }).limit(50).populate("order", "totalAmount finalPrice paymentStatus orderStatus").lean(),
    ]);
    const paid = paidAgg[0] || { sum: 0, n: 0 };
    const failed = failedAgg[0] || { sum: 0, n: 0 };
    const refunds = refundAgg[0] || { sum: 0, n: 0 };
    const commission = Math.round(Number(paid.sum || 0) * commissionRate * 100) / 100;
    return res.json({
      paid_revenue_inr: paid.sum || 0,
      paid_orders: paid.n || 0,
      failed_payment_value_inr: failed.sum || 0,
      failed_payment_orders: failed.n || 0,
      refunds_value_inr: refunds.sum || 0,
      refunds_count: refunds.n || 0,
      seller_commission_rate: commissionRate,
      seller_commission_inr: commission,
      seller_payable_inr: Math.max(0, Math.round((Number(paid.sum || 0) - commission) * 100) / 100),
      payment_breakdown: Object.fromEntries(byPayment.map((x) => [x._id, x.n])),
      order_status_breakdown: Object.fromEntries(byOrder.map((x) => [x._id, x.n])),
      recent_payments: recentPayments.map((p) => ({
        payment_id: String(p._id),
        order_id: p.order ? String(p.order._id) : "",
        amount: p.amount || (p.order && (p.order.finalPrice || p.order.totalAmount)) || 0,
        status: p.status,
        provider: p.provider,
        provider_order_id: p.providerOrderId || "",
        provider_payment_id: p.providerPaymentId || "",
        order_payment_status: p.order ? p.order.paymentStatus : "",
        order_status: p.order ? p.order.orderStatus : "",
        updated_at: p.updatedAt,
      })),
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
    const [kycPending, openReq, rulesEnabled, campaignsScheduled] = await Promise.all([
      User.countDocuments({ role: "delivery", "deliveryKyc.status": "submitted" }),
      Request.countDocuments({ status: "open" }),
      NotificationRule.countDocuments({ enabled: true }),
      NotificationCampaign.countDocuments({ status: "scheduled" }),
    ]);
    return res.json({
      delivery_kyc_pending_review: kycPending,
      open_buyer_requests: openReq,
      enabled_rules: rulesEnabled,
      scheduled_campaigns: campaignsScheduled,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/notification-rules", async (_req, res, next) => {
  try {
    const rows = await NotificationRule.find({}).sort({ updatedAt: -1 }).limit(200).lean();
    return res.json({
      triggers: NotificationRule.TRIGGERS,
      audiences: NotificationRule.AUDIENCES,
      channels: NotificationRule.CHANNELS,
      items: rows.map((r) => ({
        rule_id: String(r._id),
        name: r.name,
        trigger: r.trigger,
        audience: r.audience,
        channels: r.channels || [],
        city: r.city || "",
        region: r.region || "",
        template_title: r.templateTitle || "",
        template_body: r.templateBody || "",
        enabled: r.enabled !== false,
        cooldown_minutes: r.cooldownMinutes || 0,
        last_run_at: r.lastRunAt || null,
        run_count: r.runCount || 0,
        updated_at: r.updatedAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/notification-rules", async (req, res, next) => {
  try {
    const body = req.body || {};
    const channels = asArray(body.channels).map((x) => cleanShort(x, 40)).filter((x) => NotificationRule.CHANNELS.includes(x));
    const doc = await NotificationRule.create({
      name: cleanShort(body.name, 160) || "Notification rule",
      trigger: NotificationRule.TRIGGERS.includes(body.trigger) ? body.trigger : "manual_campaign",
      audience: NotificationRule.AUDIENCES.includes(body.audience) ? body.audience : "buyers",
      channels: channels.length ? channels : ["in_app"],
      city: cleanShort(body.city, 80),
      region: cleanShort(body.region, 80),
      templateTitle: cleanShort(body.template_title || body.templateTitle, 180),
      templateBody: cleanShort(body.template_body || body.templateBody, 1200),
      enabled: body.enabled !== false,
      cooldownMinutes: Math.max(0, Math.min(43200, Number(body.cooldown_minutes || body.cooldownMinutes || 60) || 0)),
      createdBy: req.user.id,
    });
    return res.status(201).json({ rule_id: String(doc._id) });
  } catch (err) {
    return next(err);
  }
});

router.patch("/notification-rules/:ruleId", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.ruleId)) return res.status(400).json({ error: "Invalid rule id" });
    const body = req.body || {};
    const set = {};
    if (body.name != null) set.name = cleanShort(body.name, 160);
    if (body.trigger != null && NotificationRule.TRIGGERS.includes(body.trigger)) set.trigger = body.trigger;
    if (body.audience != null && NotificationRule.AUDIENCES.includes(body.audience)) set.audience = body.audience;
    if (body.channels != null) {
      const channels = asArray(body.channels).map((x) => cleanShort(x, 40)).filter((x) => NotificationRule.CHANNELS.includes(x));
      set.channels = channels.length ? channels : ["in_app"];
    }
    if (body.city != null) set.city = cleanShort(body.city, 80);
    if (body.region != null) set.region = cleanShort(body.region, 80);
    if (body.template_title != null || body.templateTitle != null) set.templateTitle = cleanShort(body.template_title || body.templateTitle, 180);
    if (body.template_body != null || body.templateBody != null) set.templateBody = cleanShort(body.template_body || body.templateBody, 1200);
    if (body.enabled != null) set.enabled = Boolean(body.enabled);
    if (body.cooldown_minutes != null || body.cooldownMinutes != null) {
      set.cooldownMinutes = Math.max(0, Math.min(43200, Number(body.cooldown_minutes || body.cooldownMinutes) || 0));
    }
    const doc = await NotificationRule.findByIdAndUpdate(req.params.ruleId, { $set: set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ error: "Rule not found" });
    return res.json({ rule_id: String(doc._id), enabled: doc.enabled !== false });
  } catch (err) {
    return next(err);
  }
});

router.get("/notification-campaigns", async (_req, res, next) => {
  try {
    const rows = await NotificationCampaign.find({}).sort({ updatedAt: -1 }).limit(200).lean();
    const ids = rows.map((c) => c._id);
    const openedAgg = ids.length
      ? await NotificationDelivery.aggregate([
          { $match: { campaign: { $in: ids }, openedAt: { $ne: null } } },
          { $group: { _id: "$campaign", n: { $sum: 1 } } },
        ])
      : [];
    const openedMap = new Map(openedAgg.map((x) => [String(x._id), x.n]));
    return res.json({
      audiences: NotificationCampaign.AUDIENCES,
      channels: NotificationCampaign.CHANNELS,
      statuses: NotificationCampaign.STATUSES,
      items: rows.map((c) => ({
        campaign_id: String(c._id),
        name: c.name,
        audience: c.audience,
        channels: c.channels || [],
        city: c.city || "",
        region: c.region || "",
        title: c.title,
        body: c.body,
        coupon_code: c.couponCode || "",
        status: c.status,
        scheduled_at: c.scheduledAt || null,
        sent_at: c.sentAt || null,
        estimated_recipients: c.estimatedRecipients || 0,
        sent_count: c.sentCount || 0,
        opened_count: openedMap.get(String(c._id)) || 0,
        clicked_count: c.clickedCount || 0,
        updated_at: c.updatedAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/notification-campaigns", async (req, res, next) => {
  try {
    const body = req.body || {};
    const channels = asArray(body.channels).map((x) => cleanShort(x, 40)).filter((x) => NotificationCampaign.CHANNELS.includes(x));
    const audience = NotificationCampaign.AUDIENCES.includes(body.audience) ? body.audience : "buyers";
    const city = cleanShort(body.city, 80);
    const region = cleanShort(body.region, 80);
    const status = NotificationCampaign.STATUSES.includes(body.status) ? body.status : "draft";
    const estimated = await estimateAudience({ audience, city, region });
    const doc = await NotificationCampaign.create({
      name: cleanShort(body.name, 160) || "Campaign",
      audience,
      channels: channels.length ? channels : ["in_app"],
      city,
      region,
      title: cleanShort(body.title, 180) || "Bachat update",
      body: cleanShort(body.body, 1600) || "New update from Bachat.",
      couponCode: cleanShort(body.coupon_code || body.couponCode, 40),
      status,
      scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
      sentAt: status === "sent" ? new Date() : null,
      estimatedRecipients: estimated,
      sentCount: status === "sent" ? estimated : 0,
      createdBy: req.user.id,
    });
    return res.status(201).json({ campaign_id: String(doc._id), estimated_recipients: estimated });
  } catch (err) {
    return next(err);
  }
});

router.patch("/notification-campaigns/:campaignId", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.campaignId)) return res.status(400).json({ error: "Invalid campaign id" });
    const body = req.body || {};
    const set = {};
    if (body.status != null && NotificationCampaign.STATUSES.includes(body.status)) {
      set.status = body.status;
      if (body.status === "sent") set.sentAt = new Date();
    }
    if (body.scheduled_at != null) set.scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
    const doc = await NotificationCampaign.findById(req.params.campaignId);
    if (!doc) return res.status(404).json({ error: "Campaign not found" });
    Object.assign(doc, set);
    doc.estimatedRecipients = await estimateAudience({ audience: doc.audience, city: doc.city, region: doc.region });
    if (doc.status === "sent" && !doc.sentCount) doc.sentCount = doc.estimatedRecipients;
    await doc.save();
    return res.json({ campaign_id: String(doc._id), status: doc.status, estimated_recipients: doc.estimatedRecipients });
  } catch (err) {
    return next(err);
  }
});

router.post("/notification-campaigns/:campaignId/dispatch", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.campaignId)) return res.status(400).json({ error: "Invalid campaign id" });
    const campaign = await NotificationCampaign.findById(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const result = await dispatchCampaign(campaign);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/notification-campaigns/dispatch-due", async (_req, res, next) => {
  try {
    return res.json(await dispatchDueCampaigns());
  } catch (err) {
    return next(err);
  }
});

router.get("/notification-deliveries", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.campaign_id && mongoose.isValidObjectId(req.query.campaign_id)) filter.campaign = req.query.campaign_id;
    const rows = await NotificationDelivery.find(filter).sort({ updatedAt: -1 }).limit(200).populate("user", "name email role").lean();
    return res.json({
      items: rows.map((d) => ({
        delivery_id: String(d._id),
        campaign_id: d.campaign ? String(d.campaign) : "",
        rule_id: d.rule ? String(d.rule) : "",
        user_name: d.user?.name || "",
        user_email: d.user?.email || "",
        user_role: d.user?.role || "",
        channel: d.channel,
        status: d.status,
        error: d.error || "",
        sent_at: d.sentAt || null,
        opened_at: d.openedAt || null,
        clicked_at: d.clickedAt || null,
        updated_at: d.updatedAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/city-ops", async (_req, res, next) => {
  try {
    const [buyers, sellers, drivers, requests, orders, configured, usersWithLoc, sellersWithLoc] = await Promise.all([
      User.aggregate([{ $match: { role: "buyer" } }, { $group: { _id: { city: "$city", region: "$region" }, n: { $sum: 1 } } }]),
      Seller.aggregate([{ $group: { _id: { city: "$city", region: "$region" }, n: { $sum: 1 }, verified: { $sum: { $cond: ["$isVerified", 1, 0] } } } }]),
      User.aggregate([{ $match: { role: "delivery" } }, { $group: { _id: { city: "$city", region: "$region" }, n: { $sum: 1 }, verified: { $sum: { $cond: [{ $eq: ["$deliveryKyc.status", "verified"] }, 1, 0] } } } }]),
      Request.aggregate([{ $group: { _id: { city: "$city", region: "$region" }, n: { $sum: 1 }, open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } } } }]),
      Order.aggregate([{ $group: { _id: { city: "$delivery.dropoffCity", region: "$delivery.dropoffRegion" }, n: { $sum: 1 }, paid: { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] } } } }]),
      CityArea.find({}).lean(),
      User.find({ "location.lat": { $ne: null }, "location.lng": { $ne: null } }).select("city region location").lean(),
      Seller.find({ "location.lat": { $ne: null }, "location.lng": { $ne: null } }).select("city region location").lean(),
    ]);
    const map = new Map();
    function key(city, region) {
      return `${String(city || "").trim().toLowerCase()}|${String(region || "").trim().toLowerCase()}`;
    }
    function ensure(city, region) {
      const k = key(city, region);
      if (!map.has(k)) {
        map.set(k, { city: city || "Unknown", region: region || "Unknown", buyers: 0, sellers: 0, sellers_verified: 0, drivers: 0, drivers_verified: 0, requests: 0, open_requests: 0, orders: 0, paid_orders: 0 });
      }
      return map.get(k);
    }
    buyers.forEach((x) => { ensure(x._id.city, x._id.region).buyers = x.n; });
    sellers.forEach((x) => { const r = ensure(x._id.city, x._id.region); r.sellers = x.n; r.sellers_verified = x.verified || 0; });
    drivers.forEach((x) => { const r = ensure(x._id.city, x._id.region); r.drivers = x.n; r.drivers_verified = x.verified || 0; });
    requests.forEach((x) => { const r = ensure(x._id.city, x._id.region); r.requests = x.n; r.open_requests = x.open || 0; });
    orders.forEach((x) => { const r = ensure(x._id.city, x._id.region); r.orders = x.n; r.paid_orders = x.paid || 0; });
    const coordMap = new Map();
    [...usersWithLoc, ...sellersWithLoc].forEach((x) => {
      const k = key(x.city, x.region);
      if (!coordMap.has(k)) coordMap.set(k, []);
      coordMap.get(k).push(x);
    });
    const configMap = new Map(configured.map((x) => [key(x.city, x.region), x]));
    const areas = [...map.values()].map((m) => {
      const coords = avgCoords(coordMap.get(key(m.city, m.region)) || []);
      const cfg = configMap.get(key(m.city, m.region)) || { city: m.city, region: m.region, active: true, priority: "normal", serviceRadiusKm: 5, notes: "", lat: coords.lat, lng: coords.lng };
      if (cfg.lat == null && coords.lat != null) cfg.lat = coords.lat;
      if (cfg.lng == null && coords.lng != null) cfg.lng = coords.lng;
      const score = m.open_requests * 3 + m.orders * 2 + m.buyers + m.sellers_verified * 4 + m.drivers_verified * 3;
      return fmtCityArea(cfg, { ...m, heat_score: score });
    }).sort((a, b) => (b.metrics.heat_score || 0) - (a.metrics.heat_score || 0));
    return res.json({ items: areas });
  } catch (err) {
    return next(err);
  }
});

router.patch("/city-ops/area", async (req, res, next) => {
  try {
    const city = cleanShort(req.body?.city, 80);
    const region = cleanShort(req.body?.region, 80);
    if (!city || !region) return res.status(400).json({ error: "city and region are required" });
    const set = {
      active: req.body.active !== false,
      priority: ["low", "normal", "high"].includes(req.body.priority) ? req.body.priority : "normal",
      serviceRadiusKm: Math.max(0, Math.min(100, Number(req.body.service_radius_km || req.body.serviceRadiusKm || 5) || 5)),
      lat: Number.isFinite(Number(req.body.lat)) ? Number(req.body.lat) : null,
      lng: Number.isFinite(Number(req.body.lng)) ? Number(req.body.lng) : null,
      notes: cleanShort(req.body.notes, 1000),
      updatedBy: req.user.id,
    };
    const doc = await CityArea.findOneAndUpdate({ city, region }, { $set: { city, region, ...set } }, { upsert: true, new: true });
    return res.json(fmtCityArea(doc.toObject()));
  } catch (err) {
    return next(err);
  }
});

router.get("/delivery-ops", async (req, res, next) => {
  try {
    const status = cleanShort(req.query.status, 80);
    const filter = {};
    if (status) filter["delivery.status"] = status;
    else filter["delivery.status"] = { $nin: ["none"] };
    const [orders, drivers] = await Promise.all([
      Order.find(filter).sort({ updatedAt: -1 }).limit(200).populate("user", "name email phone").populate("seller", "shopName city region").lean(),
      User.find({ role: "delivery", "deliveryKyc.status": "verified" }).select("name email phone city region deliveryKyc deliveryAvailability").sort({ city: 1, name: 1 }).lean(),
    ]);
    const activeByDriver = await Order.aggregate([
      { $match: { "delivery.driver": { $ne: null }, "delivery.status": { $in: ["delivery_assigned", "driver_en_route_pickup", "picked_up", "en_route_dropoff"] } } },
      { $group: { _id: "$delivery.driver", n: { $sum: 1 } } },
    ]);
    const activeMap = new Map(activeByDriver.map((x) => [String(x._id), x.n]));
    return res.json({
      drivers: drivers.map((d) => ({
        user_id: String(d._id),
        name: d.name,
        email: d.email,
        phone: d.phone || "",
        city: d.city,
        region: d.region,
        is_online: Boolean(d.deliveryAvailability?.isOnline),
        max_active_jobs: d.deliveryAvailability?.maxActiveJobs || 3,
        active_jobs: activeMap.get(String(d._id)) || 0,
      })),
      items: orders.map((o) => {
        const base = formatOrder(o);
        return {
          ...base,
          buyer_name: o.user?.name || "",
          buyer_phone: o.user?.phone || "",
          seller_name: o.seller?.shopName || "",
          seller_area: [o.seller?.city, o.seller?.region].filter(Boolean).join(", "),
          delivery_status: o.delivery?.status || "none",
          driver_user_id: o.delivery?.driver ? String(o.delivery.driver) : "",
          ready_for_pickup_at: o.delivery?.readyForPickupAt || null,
          claim_expires_at: o.delivery?.claimExpiresAt || null,
          driver_location_at: o.delivery?.driverLocationAt || null,
          route_points_count: Array.isArray(o.delivery?.routePoints) ? o.delivery.routePoints.length : 0,
          failed_reason: o.delivery?.failedReason || "",
          cancelled_reason: o.delivery?.cancelledReason || "",
          reassignment_count: o.delivery?.reassignmentCount || 0,
        };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

router.patch("/delivery-ops/:orderId/assign", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId) || !mongoose.isValidObjectId(req.body?.driver_user_id)) {
      return res.status(400).json({ error: "Valid order id and driver_user_id are required" });
    }
    const driver = await User.findOne({ _id: req.body.driver_user_id, role: "delivery", "deliveryKyc.status": "verified" }).lean();
    if (!driver) return res.status(404).json({ error: "Verified delivery partner not found" });
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    order.delivery = order.delivery || {};
    const prevDriver = order.delivery.driver ? String(order.delivery.driver) : "";
    const prevStatus = order.delivery.status || "";
    if (prevDriver && prevDriver !== String(driver._id)) {
      order.delivery.reassignmentCount = Number(order.delivery.reassignmentCount || 0) + 1;
    }
    order.delivery.driver = driver._id;
    order.delivery.status = "delivery_assigned";
    order.delivery.assignedAt = new Date();
    await order.save();
    await DeliveryAudit.create({
      order: order._id,
      actor: req.user.id,
      action: prevDriver ? "reassign_driver" : "assign_driver",
      fromStatus: prevStatus,
      toStatus: order.delivery.status,
      driver: driver._id,
      meta: { previous_driver: prevDriver },
    });
    return res.json({ order: formatOrder(order) });
  } catch (err) {
    return next(err);
  }
});

router.patch("/delivery-ops/:orderId/status", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ error: "Invalid order id" });
    const allowed = ["delivery_requested", "delivery_assigned", "driver_en_route_pickup", "picked_up", "en_route_dropoff", "delivered", "cancelled", "failed", "expired_unclaimed"];
    const status = cleanShort(req.body?.status, 80);
    if (!allowed.includes(status)) return res.status(400).json({ error: "Unsupported delivery status" });
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    order.delivery = order.delivery || {};
    const prevStatus = order.delivery.status || "";
    const reason = cleanShort(req.body?.reason, 800);
    order.delivery.status = status;
    if (status === "cancelled" || status === "failed" || status === "expired_unclaimed") order.delivery.driver = null;
    if (status === "failed") {
      order.delivery.failedAt = new Date();
      order.delivery.failedReason = reason || "Marked failed by ops";
    }
    if (status === "cancelled") {
      order.delivery.cancelledReason = reason || "Cancelled by ops";
    }
    if (status === "delivered") {
      order.delivery.deliveredAt = new Date();
      order.orderStatus = "delivered";
    }
    await order.save();
    await DeliveryAudit.create({
      order: order._id,
      actor: req.user.id,
      action: "set_delivery_status",
      fromStatus: prevStatus,
      toStatus: status,
      reason,
    });
    return res.json({ order: formatOrder(order) });
  } catch (err) {
    return next(err);
  }
});

router.get("/delivery-ops/:orderId/audit", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ error: "Invalid order id" });
    const rows = await DeliveryAudit.find({ order: req.params.orderId }).sort({ createdAt: -1 }).limit(100).populate("actor", "name email role").populate("driver", "name email").lean();
    return res.json({
      items: rows.map((a) => ({
        audit_id: String(a._id),
        action: a.action,
        from_status: a.fromStatus || "",
        to_status: a.toStatus || "",
        reason: a.reason || "",
        actor_name: a.actor?.name || "",
        actor_email: a.actor?.email || "",
        driver_user_id: a.driver ? String(a.driver._id || a.driver) : "",
        driver_name: a.driver?.name || "",
        driver_email: a.driver?.email || "",
        meta: a.meta || {},
        created_at: a.createdAt,
      })),
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
      { id: "payments", label: "Razorpay checkout + webhook", status: "live", detail: "Checkout, webhook, failed payment handling, and admin reconciliation are present." },
      { id: "delivery", label: "Delivery pool, KYC, DigiLocker", status: "live", detail: "Delivery KYC, live route tracking, assignment, failure handling, and ops controls are present." },
      { id: "disputes", label: "Disputes / chargebacks", status: "live", detail: "GET /api/disputes, /api/admin/disputes; dispute-signals for payment flags." },
      { id: "city_ops", label: "City coverage & heatmaps", status: "live", detail: "GET/PATCH /api/admin/city-ops with active area controls." },
      { id: "field_sales", label: "Field sales CRM", status: "live", detail: "GET/POST/PATCH /api/leads (admin + sales)." },
      { id: "notifications", label: "Notification centre & rules", status: "live", detail: "Rules and campaigns endpoints with targeting and performance metrics." },
      { id: "analytics", label: "Warehouse analytics", status: "live", detail: "AnalyticsEvent + /api/admin/analytics-*." },
      { id: "team_2fa", label: "Team portal + 2FA + OIDC", status: "live", detail: "TOTP for admin/sales; /api/auth/oidc/team/* when OIDC_* env set." },
    ],
  });
});

module.exports = router;
