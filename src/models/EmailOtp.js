const mongoose = require("mongoose");

const emailOtpSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    codeHash: { type: String, required: true },
    purpose: { type: String, default: "email_verify" },
    /** For purpose `phone_verify`: normalized 10-digit Indian mobile (no +91). */
    phone: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

emailOtpSchema.index({ user: 1, consumedAt: 1, expiresAt: -1 });

module.exports = mongoose.model("EmailOtp", emailOtpSchema);
