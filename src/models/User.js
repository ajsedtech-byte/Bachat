const mongoose = require("mongoose");

/** One row from DigiLocker “issued documents” list (URI kept server-side only; never expose in public APIs). */
const digilockerIssuedItemSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    doctype: { type: String, default: "" },
    mime: { type: String, default: "" },
    date: { type: String, default: "" },
    issuer: { type: String, default: "" },
    issuerid: { type: String, default: "" },
    uri: { type: String, default: "" },
  },
  { _id: false }
);

/** Delivery partners only — identity review (Aadhaar-style fields are minimal; no full UID stored). */
const deliveryKycSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["not_started", "awaiting_submit", "submitted", "verified", "rejected"],
      default: "not_started",
    },
    /** Last 4 digits of Aadhaar only — never store full 12-digit number. */
    aadharLast4: { type: String, default: "" },
    /** Last 4 characters of PAN (optional). */
    panLast4: { type: String, default: "" },
    consentAcceptedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    rejectedReason: { type: String, default: "" },
    /** Set when DigiLocker OAuth callback succeeds (optional; production KYC path). */
    digilockerLinkedAt: { type: Date, default: null },
    /** Last successful sync from DigiLocker issued-doc list API (metadata only unless you enable file fetch). */
    digilockerIssuedSyncedAt: { type: Date, default: null },
    digilockerIssuedItems: { type: [digilockerIssuedItemSchema], default: undefined },
  },
  { _id: false }
);

const preciseLocationSchema = new mongoose.Schema(
  {
    addressText: { type: String, default: "", trim: true, maxlength: 300 },
    landmark: { type: String, default: "", trim: true, maxlength: 160 },
    pincode: { type: String, default: "", trim: true, maxlength: 12 },
    lat: { type: Number, default: null, min: -90, max: 90 },
    lng: { type: Number, default: null, min: -180, max: 180 },
    accuracyM: { type: Number, default: null, min: 0, max: 50000 },
    capturedAt: { type: Date, default: null },
    consentAcceptedAt: { type: Date, default: null },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    /** Set when mobile on profile is confirmed (email code flow; not SMS by default). */
    phoneVerifiedAt: { type: Date, default: null },
    city: { type: String, required: true },
    region: { type: String, required: true },
    role: {
      type: String,
      enum: ["buyer", "seller", "admin", "sales", "delivery"],
      default: "buyer",
    },
    /** TOTP second factor for team roles (admin, sales) — secret stored encrypted. */
    mfaTotpEnabled: { type: Boolean, default: false },
    mfaTotpEnc: { type: String, default: "" },
    mfaTotpVerifiedAt: { type: Date, default: null },
    mfaTotpPendingEnc: { type: String, default: "" },
    /** Linked IdP subject (team OIDC) — pair with oidcIssuer. */
    oidcSubject: { type: String, default: "", trim: true },
    oidcIssuer: { type: String, default: "", trim: true },
    emailVerifiedAt: { type: Date, default: null },
    /** Buyer wishlist — product ObjectIds */
    savedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    /** Unique invite code for Refer & Earn */
    referralCode: { type: String, default: undefined, unique: true, sparse: true, trim: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    location: { type: preciseLocationSchema, default: undefined },
    deliveryKyc: { type: deliveryKycSchema, default: undefined },
  },
  { timestamps: true }
);

userSchema.index({ role: 1, "deliveryKyc.status": 1 });
userSchema.index(
  { oidcIssuer: 1, oidcSubject: 1 },
  {
    unique: true,
    partialFilterExpression: {
      oidcIssuer: { $exists: true, $type: "string", $ne: "" },
      oidcSubject: { $exists: true, $type: "string", $ne: "" },
    },
  }
);

module.exports = mongoose.model("User", userSchema);
