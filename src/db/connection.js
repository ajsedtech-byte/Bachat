const mongoose = require("mongoose");

let connecting;

/**
 * Idempotent connect for local server and Vercel serverless cold starts.
 */
async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return;
  }
  if (connecting) {
    await connecting;
    return;
  }
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is not set");
  }
  connecting = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });
  await connecting;
  connecting = null;
}

module.exports = { connectDb };
