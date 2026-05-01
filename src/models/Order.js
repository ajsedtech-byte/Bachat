const mongoose = require("mongoose");

const orderLineItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    title: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    unitPrice: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderType: { type: String, enum: ["quote", "catalog"], default: "quote" },
    request: { type: mongoose.Schema.Types.ObjectId, ref: "Request", default: undefined },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote", default: undefined },
    lineItems: { type: [orderLineItemSchema], default: [] },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true },
    finalPrice: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    orderStatus: {
      type: String,
      enum: ["processing", "shipped", "delivered", "cancelled"],
      default: "processing",
    },
  },
  { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ seller: 1, createdAt: -1 });
orderSchema.index(
  { request: 1 },
  { unique: true, partialFilterExpression: { request: { $exists: true } } }
);
orderSchema.index(
  { quote: 1 },
  { unique: true, partialFilterExpression: { quote: { $exists: true } } }
);

module.exports = mongoose.model("Order", orderSchema);
