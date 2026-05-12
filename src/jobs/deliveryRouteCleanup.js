const mongoose = require("mongoose");
const Order = require("../models/Order");

function numEnv(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

async function runDeliveryRouteCleanupOnce() {
  if (mongoose.connection.readyState !== 1) {
    return { skipped: true, reason: "db_not_ready" };
  }

  const retentionDays = numEnv("DELIVERY_ROUTE_RETENTION_DAYS", 7, 1);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const maxPoints = numEnv("DELIVERY_ROUTE_MAX_POINTS", 1200, 100);

  await Order.updateMany(
    { "delivery.routePoints.0": { $exists: true } },
    [
      {
        $set: {
          "delivery.routePoints": {
            $slice: [
              {
                $filter: {
                  input: "$delivery.routePoints",
                  as: "p",
                  cond: { $gte: ["$$p.at", cutoff] },
                },
              },
              -maxPoints,
            ],
          },
        },
      },
    ]
  );

  return { skipped: false };
}

function isTransientMongoMonitorError(err) {
  const msg = String((err && err.message) || "").toLowerCase();
  return (
    msg.includes("server monitor timeout") ||
    msg.includes("topology was destroyed") ||
    msg.includes("connection") && msg.includes("interrupted")
  );
}

function logCleanupFailure(prefix, err) {
  if (isTransientMongoMonitorError(err)) {
    console.warn(`${prefix} skipped: MongoDB temporarily unreachable (${err.message})`);
    return;
  }
  console.warn(`${prefix}:`, err.message);
}

function startDeliveryRouteCleanupJob() {
  const everyMin = numEnv("DELIVERY_ROUTE_CLEANUP_INTERVAL_MIN", 60, 5);
  const intervalMs = everyMin * 60 * 1000;

  setTimeout(() => {
    runDeliveryRouteCleanupOnce().catch((err) => {
      logCleanupFailure("delivery route cleanup (startup)", err);
    });
  }, 10_000);

  setInterval(() => {
    runDeliveryRouteCleanupOnce().catch((err) => {
      logCleanupFailure("delivery route cleanup", err);
    });
  }, intervalMs);
}

module.exports = { startDeliveryRouteCleanupJob, runDeliveryRouteCleanupOnce };

