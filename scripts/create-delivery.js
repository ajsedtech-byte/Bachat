/**
 * Create (or update) a delivery driver user — pre-verified email so login works immediately.
 * Not self-serve registration; run from a trusted machine.
 *
 * Usage:
 *   node scripts/create-delivery.js <email> <password> "Driver Name"
 *
 * Or env: DELIVERY_EMAIL, DELIVERY_PASSWORD, DELIVERY_NAME
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

async function main() {
  const email =
    process.argv[2] || process.env.DELIVERY_EMAIL || "driver@bachat.local";
  const password = process.argv[3] || process.env.DELIVERY_PASSWORD;
  const name = process.argv[4] || process.env.DELIVERY_NAME || "Delivery Partner";
  const city = process.env.DELIVERY_CITY || "Indore";
  const region = process.env.DELIVERY_REGION || "MP";

  if (!password || password.length < 6) {
    console.error(
      "Provide a password (min 6 chars):\n  node scripts/create-delivery.js you@email.com YourSecurePassword \"Your Name\"\nOr set DELIVERY_EMAIL and DELIVERY_PASSWORD in .env"
    );
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  const passwordHash = await bcrypt.hash(password, 10);
  const emailNorm = String(email).toLowerCase().trim();

  const doc = await User.findOneAndUpdate(
    { email: emailNorm },
    {
      $set: {
        passwordHash,
        name,
        city,
        region,
        role: "delivery",
        emailVerifiedAt: new Date(),
        phone: process.env.DELIVERY_PHONE || "",
        phoneVerifiedAt: process.env.DELIVERY_PHONE ? new Date() : null,
        deliveryKyc: {
          status: "verified",
          verifiedAt: new Date(),
          consentAcceptedAt: new Date(),
          submittedAt: new Date(),
        },
      },
      $setOnInsert: { email: emailNorm },
    },
    { upsert: true, new: true, runValidators: true }
  );

  console.log("Delivery user ready:");
  console.log("  Email:   ", doc.email);
  console.log("  Name:    ", doc.name);
  console.log("  Role:    ", doc.role);
  console.log("  City:    ", doc.city);
  console.log("  Region:  ", doc.region);
  console.log("  user_id: ", String(doc._id));
  console.log("\nUse Customer/Shopkeeper login UI with role delivery, or POST /api/auth/login.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
