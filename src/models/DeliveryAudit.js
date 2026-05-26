const mongoose = require("mongoose");

const deliveryAuditSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    action: { type: String, required: true, trim: true, maxlength: 80 },
    fromStatus: { type: String, default: "", trim: true, maxlength: 80 },
    toStatus: { type: String, default: "", trim: true, maxlength: 80 },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, default: "", trim: true, maxlength: 800 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

deliveryAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model("DeliveryAudit", deliveryAuditSchema);
