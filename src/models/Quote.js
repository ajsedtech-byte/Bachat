const mongoose = require("mongoose");

const quoteSchema = new mongoose.Schema(
  {
    request: { type: mongoose.Schema.Types.ObjectId, ref: "Request", required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true },
    price: { type: Number, required: true, min: 1 },
    deliveryTime: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

quoteSchema.index({ request: 1, price: 1 });
quoteSchema.index({ request: 1, seller: 1 }, { unique: true });

module.exports = mongoose.model("Quote", quoteSchema);
