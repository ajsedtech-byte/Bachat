/**
 * Delivery job lifecycle helpers (driver role + order.delivery subdocument).
 */

const DELIVERY_STATUSES = [
  "none",
  "pending_details",
  "delivery_requested",
  "delivery_assigned",
  "driver_en_route_pickup",
  "picked_up",
  "en_route_dropoff",
  "delivered",
  "cancelled",
  "failed",
  "expired_unclaimed",
];

const ACTIVE_POOL = "delivery_requested";

function claimTimeoutMs() {
  const min = Number(process.env.DELIVERY_CLAIM_TIMEOUT_MINUTES || 15);
  return Math.max(5, Math.min(120, Number.isFinite(min) ? min : 15)) * 60 * 1000;
}

function maskPhone(phone) {
  const s = String(phone || "").replace(/\s/g, "");
  if (!s) return "";
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}

/** Lazy expire stale delivery_requested jobs (no cron). */
async function expireStaleDeliveryRequests(Order) {
  const now = new Date();
  await Order.updateMany(
    {
      "delivery.status": ACTIVE_POOL,
      "delivery.claimExpiresAt": { $lt: now },
    },
    { $set: { "delivery.status": "expired_unclaimed" } }
  );
}

const TRANSITIONS = {
  none: ["delivery_requested"],
  pending_details: ["delivery_requested"],
  delivery_requested: ["delivery_assigned", "cancelled"],
  expired_unclaimed: ["delivery_requested", "cancelled"],
  delivery_assigned: ["driver_en_route_pickup", "cancelled", "failed"],
  driver_en_route_pickup: ["picked_up", "cancelled", "failed"],
  picked_up: ["en_route_dropoff", "failed"],
  en_route_dropoff: ["delivered", "failed"],
  delivered: [],
  cancelled: [],
  failed: [],
};

function canTransition(from, to) {
  const row = TRANSITIONS[from] || [];
  return row.includes(to);
}

function normalizeAddressPart(x) {
  return String(x || "").trim();
}

module.exports = {
  DELIVERY_STATUSES,
  ACTIVE_POOL,
  claimTimeoutMs,
  maskPhone,
  expireStaleDeliveryRequests,
  canTransition,
  normalizeAddressPart,
};
