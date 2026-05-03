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

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    /** Set when mobile OTP is completed (Indian mobile on `phone`). */
    phoneVerifiedAt: { type: Date, default: null },
    city: { type: String, required: true },
    region: { type: String, required: true },
    role: {
      type: String,
      enum: ["buyer", "seller", "admin", "delivery"],
      default: "buyer",
    },
    emailVerifiedAt: { type: Date, default: null },
    /** Buyer wishlist — product ObjectIds */
    savedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    /** Unique invite code for Refer & Earn */
    referralCode: { type: String, default: null, unique: true, sparse: true, trim: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deliveryKyc: { type: deliveryKycSchema, default: undefined },
  },
  { timestamps: true }
);

userSchema.index({ role: 1, "deliveryKyc.status": 1 });

module.exports = mongoose.model("User", userSchema);
