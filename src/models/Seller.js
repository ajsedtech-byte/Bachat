const mongoose = require("mongoose");
const { CATEGORIES } = require("../lib/categories");

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
