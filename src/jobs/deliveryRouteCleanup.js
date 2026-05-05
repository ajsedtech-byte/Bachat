const Order = require("../models/Order");

function numEnv(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

async function runDeliveryRouteCleanupOnce() {
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
}

function startDeliveryRouteCleanupJob() {
  const everyMin = numEnv("DELIVERY_ROUTE_CLEANUP_INTERVAL_MIN", 60, 5);
  const intervalMs = everyMin * 60 * 1000;

  setTimeout(() => {
    runDeliveryRouteCleanupOnce().catch((err) => {
      console.warn("delivery route cleanup (startup) failed:", err.message);
    });
  }, 10_000);

  setInterval(() => {
    runDeliveryRouteCleanupOnce().catch((err) => {
      console.warn("delivery route cleanup failed:", err.message);
    });
  }, intervalMs);
}

module.exports = { startDeliveryRouteCleanupJob, runDeliveryRouteCleanupOnce };

