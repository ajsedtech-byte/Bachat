const mongoose = require("mongoose");
const { CATEGORIES } = require("../lib/categories");

const sellerKycDocumentSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["shop_photo", "gst_cert", "aadhaar", "udyam", "pan", "other"],
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
