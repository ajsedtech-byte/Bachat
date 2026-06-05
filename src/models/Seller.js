const mongoose = require("mongoose");
const { CATEGORIES } = require("../lib/categories");
const { SELLER_KYC_DOC_KINDS } = require("../lib/sellerKycDocs");

/** DigiLocker issued-document row (URI never exposed to clients). */
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

const sellerKycDocumentSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: SELLER_KYC_DOC_KINDS,
      required: true,
    },
    filename: { type: String, default: "", trim: true, maxlength: 200 },
    mimeType: { type: String, default: "", trim: true, maxlength: 120 },
    /** Data URL or base64 payload (same practical cap as product images). */
    content: { type: String, default: "" },
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { _id: true }
);

const sellerFieldReviewSchema = new mongoose.Schema(
  {
    collectedByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    collectedByRole: { type: String, enum: ["", "admin", "sales"], default: "" },
    collectedByName: { type: String, default: "", trim: true, maxlength: 120 },
    collectedAt: { type: Date, default: null },
    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    aadhaarLast4: { type: String, default: "", trim: true, maxlength: 4 },
    panNumber: { type: String, default: "", trim: true, uppercase: true, maxlength: 10 },
    governmentIdType: { type: String, default: "", trim: true, maxlength: 80 },
    governmentIdNumber: { type: String, default: "", trim: true, maxlength: 80 },
    proofOfAddressType: { type: String, default: "", trim: true, maxlength: 80 },
    proofOfAddressNumber: { type: String, default: "", trim: true, maxlength: 80 },
    businessRegistrationType: { type: String, default: "", trim: true, maxlength: 80 },
    businessRegistrationNumber: { type: String, default: "", trim: true, maxlength: 80 },
    bankAccountHolder: { type: String, default: "", trim: true, maxlength: 120 },
    bankIfsc: { type: String, default: "", trim: true, uppercase: true, maxlength: 11 },
    bankAccountNumber: { type: String, default: "", trim: true, maxlength: 24 },
    aadhaarMatchesImage: { type: Boolean, default: false },
    panMatchesImage: { type: Boolean, default: false },
    governmentIdMatchesImage: { type: Boolean, default: false },
    proofOfAddressMatchesImage: { type: Boolean, default: false },
    businessRegistrationMatchesImage: { type: Boolean, default: false },
    bankingDetailsMatchImage: { type: Boolean, default: false },
  },
  { _id: false }
);

const sellerKycSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["awaiting_path", "salesman_pending", "direct_draft", "submitted", "verified", "rejected"],
      default: "awaiting_path",
    },
    path: { type: String, enum: ["", "salesman", "direct"], default: "" },
    gstNumber: { type: String, default: "", trim: true, maxlength: 20 },
    salesmanRequestedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    rejectedReason: { type: String, default: "", maxlength: 2000 },
    documents: { type: [sellerKycDocumentSchema], default: [] },
    /** Step 1 — business profile (onboarding wizard). */
    locality: { type: String, default: "", trim: true, maxlength: 200 },
    serviceAreas: { type: [String], default: undefined },
    offersDelivery: { type: Boolean, default: true },
    businessDetailsCompletedAt: { type: Date, default: null },
    /** Step 3 — optional payout bank (plain fields; restrict access in production). */
    bankAccountHolder: { type: String, default: "", trim: true, maxlength: 120 },
    bankIfsc: { type: String, default: "", trim: true, maxlength: 11 },
    bankAccountNumber: { type: String, default: "", trim: true, maxlength: 24 },
    bankDetailsProvidedAt: { type: Date, default: null },
    fieldReview: { type: sellerFieldReviewSchema, default: undefined },
    /** DigiLocker (Meri Pehchaan) — same OAuth keys as delivery; metadata only unless file fetch enabled. */
    digilockerLinkedAt: { type: Date, default: null },
    digilockerIssuedSyncedAt: { type: Date, default: null },
    digilockerIssuedItems: { type: [digilockerIssuedItemSchema], default: undefined },
    /** GSTIN structure + checksum validated on server (no portal call). */
    gstinChecksumOk: { type: Boolean, default: false },
    gstinChecksumCheckedAt: { type: Date, default: null },
    /** Optional HTTP registry lookup (GST_REGISTRY_LOOKUP_URL). */
    gstRegistryCheckedAt: { type: Date, default: null },
    gstRegistryActive: { type: Boolean, default: false },
    gstRegistryLegalName: { type: String, default: "", maxlength: 200 },
    /** Last registry HTTP error message (for seller UI / ops). */
    gstRegistryWarning: { type: String, default: "", maxlength: 500 },
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

const businessHoursSchema = new mongoose.Schema(
  {
    openTime: { type: String, default: "09:00", trim: true, maxlength: 5 },
    closeTime: { type: String, default: "21:00", trim: true, maxlength: 5 },
    timezone: { type: String, default: "Asia/Kolkata", trim: true, maxlength: 40 },
    weeklySchedule: {
      type: [
        new mongoose.Schema(
          {
            day: {
              type: String,
              enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
              required: true,
            },
            isOpen: { type: Boolean, default: true },
            openTime: { type: String, default: "09:00", trim: true, maxlength: 5 },
            closeTime: { type: String, default: "21:00", trim: true, maxlength: 5 },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
  },
  { _id: false }
);

const sellerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    shopName: { type: String, required: true, trim: true, maxlength: 160 },
    categories: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.every((c) => CATEGORIES.includes(c));
        },
        message: "Invalid seller category",
      },
    },
    // Legacy single category field kept for backward compatibility.
    category: { type: String, default: null },
    city: { type: String, required: true, trim: true },
    region: { type: String, required: true, trim: true },
    location: { type: preciseLocationSchema, default: undefined },
    shopImages: { type: [String], default: undefined },
    storefrontTagline: { type: String, default: "", trim: true, maxlength: 220 },
    menuNote: { type: String, default: "", trim: true, maxlength: 1200 },
    businessHours: { type: businessHoursSchema, default: () => ({}) },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    isVerified: { type: Boolean, default: false },
    /** Shopkeeper eKYC (new signups). Legacy rows omit this — trade is not blocked by KYC gate. */
    sellerKyc: { type: sellerKycSchema, default: undefined },
  },
  { timestamps: true }
);

sellerSchema.pre("save", function syncPrimaryCategory(next) {
  if (Array.isArray(this.categories) && this.categories.length > 0) {
    this.category = this.categories[0];
  } else if (this.category && !this.categories.length) {
    this.categories = [this.category];
  }
  next();
});

sellerSchema.index({ city: 1, region: 1 });

module.exports = mongoose.model("Seller", sellerSchema);
