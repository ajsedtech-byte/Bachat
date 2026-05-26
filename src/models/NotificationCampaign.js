const mongoose = require("mongoose");

const AUDIENCES = ["buyers", "sellers", "delivery", "sales", "admins", "all"];
const CHANNELS = ["in_app", "email", "whatsapp", "sms"];
const STATUSES = ["draft", "scheduled", "sent", "paused", "cancelled"];

const notificationCampaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    audience: { type: String, enum: AUDIENCES, default: "buyers", index: true },
    channels: { type: [String], enum: CHANNELS, default: ["in_app"] },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    region: { type: String, default: "", trim: true, maxlength: 80 },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    body: { type: String, required: true, trim: true, maxlength: 1600 },
    couponCode: { type: String, default: "", trim: true, maxlength: 40 },
    status: { type: String, enum: STATUSES, default: "draft", index: true },
    scheduledAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    estimatedRecipients: { type: Number, default: 0, min: 0 },
    sentCount: { type: Number, default: 0, min: 0 },
    clickedCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

notificationCampaignSchema.statics.AUDIENCES = AUDIENCES;
notificationCampaignSchema.statics.CHANNELS = CHANNELS;
notificationCampaignSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model("NotificationCampaign", notificationCampaignSchema);
