/**
 * Create (or update) a field-sales user (role: sales). Same pattern as create-admin.js.
 *
 *   node scripts/create-sales.js <email> <password> "Display Name"
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

async function main() {
  const email = process.argv[2] || process.env.SALES_EMAIL;
  const password = process.argv[3] || process.env.SALES_PASSWORD;
  const name = process.argv[4] || process.env.SALES_NAME || "Field Sales";

  if (!email || !password || password.length < 6) {
    console.error(
      "Usage: node scripts/create-sales.js you@company.com YourPassword \"Your Name\"\nOr set SALES_EMAIL and SALES_PASSWORD in .env"
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
  const city = process.env.SALES_CITY || "Indore";
  const region = process.env.SALES_REGION || "MP";

  const doc = await User.findOneAndUpdate(
    { email: emailNorm },
    {
      $set: {
        passwordHash,
        name,
        city,
        region,
        role: "sales",
        emailVerifiedAt: new Date(),
        phone: process.env.SALES_PHONE || "",
        phoneVerifiedAt: process.env.SALES_PHONE ? new Date() : null,
      },
      $setOnInsert: { email: emailNorm },
    },
    { upsert: true, new: true, runValidators: true }
  );

  console.log("Sales user ready:");
  console.log("  Email:   ", doc.email);
  console.log("  Name:    ", doc.name);
  console.log("  Role:    ", doc.role);
  console.log("  user_id: ", String(doc._id));
  console.log("\nLog in at http://localhost:3000/team-login.html (Field sales tab) then open http://localhost:3000/admin-sales.html");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
