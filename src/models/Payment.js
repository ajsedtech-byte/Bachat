const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    amount: { type: Number, required: true },
    method: { type: String, default: "razorpay" },
    status: {
      type: String,
      enum: ["created", "authorized", "captured", "failed"],
      default: "created",
    },
    provider: { type: String, default: "razorpay" },
    providerOrderId: { type: String, default: "" },
    providerPaymentId: { type: String, default: "" },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

paymentSchema.index({ order: 1 });
paymentSchema.index({ providerOrderId: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
