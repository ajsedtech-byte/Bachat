/**
 * Create (or update) an admin user in MongoDB. Pre-verifies email so login works immediately.
 *
 * Usage:
 *   node scripts/create-admin.js <email> <password> "Display Name"
 *
 * Or set env (see .env.example): ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

async function main() {
  const email =
    process.argv[2] || process.env.ADMIN_EMAIL || "admin@bachat.local";
  const password = process.argv[3] || process.env.ADMIN_PASSWORD;
  const name = process.argv[4] || process.env.ADMIN_NAME || "Ops Admin";
  const city = process.env.ADMIN_CITY || "Indore";
  const region = process.env.ADMIN_REGION || "MP";

  if (!password || password.length < 6) {
    console.error(
      "Provide a password (min 6 chars):\n  node scripts/create-admin.js you@email.com YourSecurePassword \"Your Name\"\nOr set ADMIN_EMAIL and ADMIN_PASSWORD in .env"
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
        role: "admin",
        emailVerifiedAt: new Date(),
        phone: process.env.ADMIN_PHONE || "",
      },
      $setOnInsert: { email: emailNorm },
    },
    { upsert: true, new: true, runValidators: true }
  );

  console.log("Admin user ready:");
  console.log("  Email:   ", doc.email);
  console.log("  Name:    ", doc.name);
  console.log("  Role:    ", doc.role);
  console.log("  user_id: ", String(doc._id));
  console.log("\nLog in at http://localhost:3000/login.html then open Admin Dashboard.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
