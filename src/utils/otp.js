const crypto = require("crypto");
const bcrypt = require("bcryptjs");

function generateSixDigitCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

async function hashOtp(code) {
  return bcrypt.hash(code, 10);
}

async function verifyOtp(code, hash) {
  return bcrypt.compare(code, hash);
}

module.exports = { generateSixDigitCode, hashOtp, verifyOtp };
