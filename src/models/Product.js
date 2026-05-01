const mongoose = require("mongoose");
const { CATEGORIES } = require("../lib/categories");

const productSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", maxlength: 8000 },
    category: { type: String, required: true, enum: CATEGORIES },
    images: { type: [String], default: [] },
    sellerPrice: { type: Number, required: true, min: 1 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ seller: 1, updatedAt: -1 });
productSchema.index({ category: 1, isActive: 1, updatedAt: -1 });

module.exports = mongoose.model("Product", productSchema);
