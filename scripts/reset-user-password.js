/**
 * Reset an existing user's password in MongoDB from a trusted machine.
 *
 * Usage:
 *   node scripts/reset-user-password.js <email> <role> <new-password>
 *
 * Example:
 *   node scripts/reset-user-password.js shop@example.com seller "NewPassword123"
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

const VALID_ROLES = new Set(["buyer", "seller", "admin", "sales", "delivery"]);

async function main() {
  const email = String(process.argv[2] || "").toLowerCase().trim();
  const role = String(process.argv[3] || "").toLowerCase().trim();
  const password = String(process.argv[4] || "");

  if (!email || !role || !password) {
    console.error("Usage: node scripts/reset-user-password.js <email> <role> <new-password>");
    process.exit(1);
  }

  if (!VALID_ROLES.has(role)) {
    console.error(`Invalid role "${role}". Use one of: ${Array.from(VALID_ROLES).join(", ")}`);
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("New password must be at least 8 characters.");
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.findOneAndUpdate(
    { email, role },
    { $set: { passwordHash } },
    { new: true, runValidators: true }
  );

  if (!user) {
    console.error(`No ${role} account found for ${email}.`);
    process.exitCode = 1;
  } else {
    console.log("Password reset complete:");
    console.log("  Email:  ", user.email);
    console.log("  Role:   ", user.role);
    console.log("  Name:   ", user.name);
    console.log("  user_id:", String(user._id));
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
