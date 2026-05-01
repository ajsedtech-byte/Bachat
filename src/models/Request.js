const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    category: { type: String, required: true },
    productName: { type: String, required: true },
    specifications: { type: mongoose.Schema.Types.Mixed, default: null },
    budget: { type: Number, default: null },
    city: { type: String, required: true },
    region: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "quoted", "closed", "expired"],
      default: "open",
    },
  },
  { timestamps: true }
);

requestSchema.index({ user: 1, createdAt: -1 });
requestSchema.index({ category: 1, city: 1, region: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Request", requestSchema);
