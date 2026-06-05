const mongoose = require("mongoose");

let connecting;
let indexesReconciled = false;

function directAtlasUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return "";
  }
  if (parsed.protocol !== "mongodb+srv:" || parsed.hostname !== "learnx-mumbai.aiicaw.mongodb.net") {
    return "";
  }
  const params = new URLSearchParams(parsed.search || "");
  params.set("ssl", "true");
  params.set("replicaSet", "atlas-61zl98-shard-0");
  params.set("authSource", params.get("authSource") || "admin");
  params.set("retryWrites", params.get("retryWrites") || "true");
  params.set("w", params.get("w") || "majority");
  return `mongodb://${parsed.username}:${parsed.password}@learnx-mumbai-shard-00-00.aiicaw.mongodb.net:27017,learnx-mumbai-shard-00-01.aiicaw.mongodb.net:27017,learnx-mumbai-shard-00-02.aiicaw.mongodb.net:27017${parsed.pathname}?${params.toString()}`;
}

/**
 * Idempotent connect for local server and Vercel serverless cold starts.
 */
async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    await reconcileUserEmailRoleIndex();
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
  connecting = mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 }).catch((err) => {
    const fallbackUri = /querySrv/i.test(err.message || "") ? directAtlasUri(uri) : "";
    if (!fallbackUri) throw err;
    console.warn("MongoDB SRV lookup failed; retrying with direct Atlas seed hosts.");
    return mongoose.connect(fallbackUri, { serverSelectionTimeoutMS: 10_000 });
  });
  try {
    await connecting;
    await reconcileUserEmailRoleIndex();
  } finally {
    connecting = null;
  }
}

async function reconcileUserEmailRoleIndex() {
  if (indexesReconciled || mongoose.connection.readyState !== 1) return;
  const users = mongoose.connection.collection("users");
  let indexes = [];
  try {
    indexes = await users.indexes();
  } catch (err) {
    if (err && (err.codeName === "NamespaceNotFound" || err.code === 26)) {
      indexes = [];
    } else {
      throw err;
    }
  }
  const oldEmailIndex = indexes.find((idx) => idx.name === "email_1" && idx.unique);
  if (oldEmailIndex) {
    await users.dropIndex("email_1");
  }
  await users.createIndex({ email: 1, role: 1 }, { unique: true, name: "email_1_role_1" });
  indexesReconciled = true;
}

module.exports = { connectDb };
