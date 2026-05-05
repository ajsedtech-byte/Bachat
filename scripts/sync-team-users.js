/**
 * Upsert all three team-login identities in MongoDB (Admin, Ops — both role admin —
 * and Sales). Reads ADMIN_*, OPS_*, SALES_* from .env.
 *
 *   npm run sync-team
 */
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

function randomReferralCode() {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += ALPHABET[buf[i % buf.length] % ALPHABET.length];
  }
  return code;
}

async function upsert(cfg) {
  const passwordHash = await bcrypt.hash(cfg.password, 10);
  const emailNorm = cfg.emailNorm;
  const doc = await User.findOneAndUpdate(
    { email: emailNorm },
    {
      $set: {
        passwordHash,
        name: cfg.name,
        city: cfg.city,
        region: cfg.region,
        role: cfg.role,
        emailVerifiedAt: new Date(),
        phone: cfg.phone || "",
        phoneVerifiedAt: cfg.phone ? new Date() : null,
      },
      $setOnInsert: { email: emailNorm, referralCode: randomReferralCode() },
    },
    { upsert: true, new: true, runValidators: true }
  );
  return doc;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  const adminEmail =
    process.env.ADMIN_EMAIL || "admin@bachat.local";
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME || "Administrator";

  const opsEmail =
    process.env.OPS_EMAIL || "ops@bachat.local";
  const opsPassword = process.env.OPS_PASSWORD;
  const opsName = process.env.OPS_NAME || "Operations";

  const salesEmail =
    process.env.SALES_EMAIL || "sales@bachat.local";
  const salesPassword = process.env.SALES_PASSWORD;
  const salesName = process.env.SALES_NAME || "Field Sales";

  const missing = [];
  if (!adminPassword || adminPassword.length < 6) missing.push("ADMIN_PASSWORD");
  if (!opsPassword || opsPassword.length < 6) missing.push("OPS_PASSWORD");
  if (!salesPassword || salesPassword.length < 6) missing.push("SALES_PASSWORD");
  if (missing.length) {
    console.error(`Set ${missing.join(", ")} in .env (min 6 chars each).`);
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  const admins = await upsert({
    emailNorm: String(adminEmail).toLowerCase().trim(),
    password: adminPassword,
    name: adminName,
    city: process.env.ADMIN_CITY || "Indore",
    region: process.env.ADMIN_REGION || "MP",
    phone: process.env.ADMIN_PHONE || "",
    role: "admin",
  });
  console.log("[Admin]", admins.email, "role=", admins.role, "id=", String(admins._id));

  const ops = await upsert({
    emailNorm: String(opsEmail).toLowerCase().trim(),
    password: opsPassword,
    name: opsName,
    city: process.env.OPS_CITY || process.env.ADMIN_CITY || "Indore",
    region: process.env.OPS_REGION || process.env.ADMIN_REGION || "MP",
    phone: process.env.OPS_PHONE || "",
    role: "admin",
  });
  console.log("[Ops]  ", ops.email, "role=", ops.role, "id=", String(ops._id));

  const sales = await upsert({
    emailNorm: String(salesEmail).toLowerCase().trim(),
    password: salesPassword,
    name: salesName,
    city: process.env.SALES_CITY || "Indore",
    region: process.env.SALES_REGION || "MP",
    phone: process.env.SALES_PHONE || "",
    role: "sales",
  });
  console.log("[Sales]", sales.email, "role=", sales.role, "id=", String(sales._id));

  await mongoose.disconnect();
  console.log("\nDone. Sign in at /team-login.html (Sales / Ops / Admin chips).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
