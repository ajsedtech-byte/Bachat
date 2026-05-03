const mongoose = require("mongoose");

const deliveryPlaceSchema = new mongoose.Schema(
  {
    address: { type: String, default: "" },
    landmark: { type: String, default: "" },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    /** Shown to assigned driver only; pool listings use masked phone. */
    contactPhone: { type: String, default: "" },
  },
  { _id: false }
);

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
    delivery: {
      status: {
        type: String,
        enum: [
          "none",
          "pending_details",
          "delivery_requested",
          "delivery_assigned",
          "driver_en_route_pickup",
          "picked_up",
          "en_route_dropoff",
          "delivered",
          "cancelled",
          "failed",
          "expired_unclaimed",
        ],
        default: "none",
      },
      fee: { type: Number, default: 0, min: 0 },
      driver: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      requestedAt: { type: Date, default: null },
      claimExpiresAt: { type: Date, default: null },
      assignedAt: { type: Date, default: null },
      pickup: { type: deliveryPlaceSchema, default: () => ({}) },
      dropoff: { type: deliveryPlaceSchema, default: () => ({}) },
      driverLastLat: { type: Number, default: null },
      driverLastLng: { type: Number, default: null },
      driverLocationAt: { type: Date, default: null },
      /** Shopkeeper confirms order is ready for driver pickup. */
      readyForPickupAt: { type: Date, default: null },
      pickedUpAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      /** Copied from buyer profile at request time — used to match drivers by area. */
      dropoffCity: { type: String, default: "" },
      dropoffRegion: { type: String, default: "" },
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
orderSchema.index({ "delivery.status": 1, "delivery.claimExpiresAt": 1 });
orderSchema.index({ "delivery.driver": 1, "delivery.status": 1 });

module.exports = mongoose.model("Order", orderSchema);
