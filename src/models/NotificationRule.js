const mongoose = require("mongoose");

const TRIGGERS = [
  "buyer_request_created",
  "quote_received",
  "payment_failed",
  "delivery_delayed",
  "seller_kyc_pending",
  "inactive_seller",
  "manual_campaign",
];

const AUDIENCES = ["buyers", "sellers", "delivery", "sales", "admins", "all"];
const CHANNELS = ["in_app", "email", "whatsapp", "sms"];

const notificationRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    trigger: { type: String, enum: TRIGGERS, default: "manual_campaign", index: true },
    audience: { type: String, enum: AUDIENCES, default: "buyers", index: true },
    channels: { type: [String], enum: CHANNELS, default: ["in_app"] },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    region: { type: String, default: "", trim: true, maxlength: 80 },
    templateTitle: { type: String, default: "", trim: true, maxlength: 180 },
    templateBody: { type: String, default: "", trim: true, maxlength: 1200 },
    enabled: { type: Boolean, default: true, index: true },
    cooldownMinutes: { type: Number, default: 60, min: 0, max: 43200 },
    lastRunAt: { type: Date, default: null },
    runCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

notificationRuleSchema.statics.TRIGGERS = TRIGGERS;
notificationRuleSchema.statics.AUDIENCES = AUDIENCES;
notificationRuleSchema.statics.CHANNELS = CHANNELS;

module.exports = mongoose.model("NotificationRule", notificationRuleSchema);
