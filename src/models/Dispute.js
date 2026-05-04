const mongoose = require("mongoose");

const DISPUTE_REASONS = ["item_not_received", "damaged", "wrong_item", "quality", "other"];

const disputeEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: () => new Date() },
    message: { type: String, required: true, maxlength: 4000 },
    authorRole: { type: String, enum: ["buyer", "seller", "admin", "system"], default: "system" },
    authorUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    buyerUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true, index: true },
    openedByRole: { type: String, enum: ["buyer", "seller"], required: true },
    openedByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reasonCode: { type: String, required: true, enum: DISPUTE_REASONS },
    description: { type: String, default: "", maxlength: 8000 },
    status: {
      type: String,
      enum: ["open", "under_review", "resolved_refund", "resolved_denied", "closed"],
      default: "open",
      index: true,
    },
    resolutionNotes: { type: String, default: "", maxlength: 8000 },
    events: { type: [disputeEventSchema], default: [] },
  },
  { timestamps: true }
);

disputeSchema.index({ status: 1, updatedAt: -1 });

const DisputeModel = mongoose.model("Dispute", disputeSchema);
DisputeModel.DISPUTE_REASONS = DISPUTE_REASONS;
module.exports = DisputeModel;
