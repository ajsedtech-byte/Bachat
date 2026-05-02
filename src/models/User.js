const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    city: { type: String, required: true },
    region: { type: String, required: true },
    role: {
      type: String,
      enum: ["buyer", "seller", "admin"],
      default: "buyer",
    },
    emailVerifiedAt: { type: Date, default: null },
    /** Buyer wishlist — product ObjectIds */
    savedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    /** Unique invite code for Refer & Earn */
    referralCode: { type: String, default: null, unique: true, sparse: true, trim: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
