/**
 * DIY bootstrap: create .env from .env.example if missing, print next steps.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

function main() {
  if (!fs.existsSync(examplePath)) {
    console.error("Missing .env.example — cannot bootstrap.");
    process.exit(1);
  }

  if (fs.existsSync(envPath)) {
    console.log(".env already exists — leaving it unchanged.");
  } else {
    fs.copyFileSync(examplePath, envPath);
    console.log("Created .env from .env.example");
  }

  const raw = fs.readFileSync(envPath, "utf8");
  const reminders = [];
  if (/JWT_SECRET\s*=\s*change_this/i.test(raw) || !/JWT_SECRET\s*=\s*\S+/.test(raw)) {
    reminders.push("Set JWT_SECRET in .env to a long random string (not the example text).");
  }
  if (!/MONGO_URI\s*=\s*\S+/.test(raw)) {
    reminders.push("Set MONGO_URI in .env to your MongoDB connection string.");
  }

  console.log("\nNext steps:");
  console.log("  1. Edit .env — at minimum MONGO_URI and JWT_SECRET.");
  console.log("  2. npm install   (if you have not already)");
  console.log("  3. npm run dev   — then open http://localhost:3000 (or your PORT)\n");
  if (reminders.length) {
    console.log("Reminders:");
    reminders.forEach((line) => console.log("  -", line));
    console.log("");
  }
}

main();
