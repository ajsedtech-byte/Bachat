import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
require("dotenv").config();

const mongoose = require("mongoose");
const AnalyticsEvent = require("../src/models/AnalyticsEvent");
const CityArea = require("../src/models/CityArea");
const DeliveryAudit = require("../src/models/DeliveryAudit");
const NotificationCampaign = require("../src/models/NotificationCampaign");
const NotificationDelivery = require("../src/models/NotificationDelivery");
const NotificationRule = require("../src/models/NotificationRule");
const Order = require("../src/models/Order");
const Payment = require("../src/models/Payment");
const Seller = require("../src/models/Seller");
const User = require("../src/models/User");

const requiredEnv = ["MONGO_URI", "JWT_SECRET"];
const optionalEnv = [
  "PUBLIC_BASE_URL",
  "APP_BASE_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "WHATSAPP_WEBHOOK_URL",
  "SMS_WEBHOOK_URL",
];
const models = [
  AnalyticsEvent,
  CityArea,
  DeliveryAudit,
  NotificationCampaign,
  NotificationDelivery,
  NotificationRule,
  Order,
  Payment,
  Seller,
  User,
];

function present(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function envReport(names) {
  return names.map((name) => ({ name, present: present(name) }));
}

async function connectMongo() {
  const timeoutMs = Number(process.env.READINESS_MONGO_TIMEOUT_MS || 10000);
  await Promise.race([
    mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      socketTimeoutMS: timeoutMs,
      maxPoolSize: 4,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Mongo readiness connection timed out")), timeoutMs + 1000)),
  ]);
}

const missingRequired = requiredEnv.filter((name) => !present(name));
const report = {
  env: {
    required: envReport(requiredEnv),
    optional: envReport(optionalEnv),
  },
  indexes: [],
};

if (missingRequired.length) {
  console.error("Deployment readiness failed: missing required env values:", missingRequired.join(", "));
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

let failed = false;

try {
  await connectMongo();

  for (const model of models) {
    await model.createIndexes();
    report.indexes.push({
      model: model.modelName,
      collection: model.collection.name,
      indexes: await model.collection.indexes(),
    });
  }

  const cityAreasWithCoords = await CityArea.countDocuments({
    lat: { $ne: null },
    lng: { $ne: null },
  });
  const enabledRules = await NotificationRule.countDocuments({ enabled: true });
  const scheduledCampaigns = await NotificationCampaign.countDocuments({ status: "scheduled" });

  report.runtime = {
    city_areas_with_coordinates: cityAreasWithCoords,
    enabled_notification_rules: enabledRules,
    scheduled_notification_campaigns: scheduledCampaigns,
  };

  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  failed = true;
  console.error("Deployment readiness failed:", err.message || err);
  process.exitCode = 1;
} finally {
  await Promise.race([
    mongoose.disconnect().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (failed) process.exit(1);
}
