const mongoose = require("mongoose");

const analyticsEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, maxlength: 64, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

analyticsEventSchema.index({ createdAt: -1 });
analyticsEventSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model("AnalyticsEvent", analyticsEventSchema);
