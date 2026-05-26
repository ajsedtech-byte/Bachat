const mongoose = require("mongoose");

const notificationDeliverySchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "NotificationCampaign", default: null, index: true },
    rule: { type: mongoose.Schema.Types.ObjectId, ref: "NotificationRule", default: null, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    channel: { type: String, enum: ["in_app", "email", "whatsapp", "sms"], default: "in_app", index: true },
    title: { type: String, default: "", trim: true, maxlength: 180 },
    body: { type: String, default: "", trim: true, maxlength: 1600 },
    status: { type: String, enum: ["queued", "sent", "failed", "opened", "clicked"], default: "queued", index: true },
    error: { type: String, default: "", trim: true, maxlength: 1000 },
    providerMessageId: { type: String, default: "", trim: true, maxlength: 200 },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
    clickUrl: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

notificationDeliverySchema.index({ campaign: 1, user: 1, channel: 1 });

module.exports = mongoose.model("NotificationDelivery", notificationDeliverySchema);
