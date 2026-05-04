/**
 * Fire-and-forget analytics events (Mongo). Never throws to callers.
 * @param {string} type
 * @param {{ userId?: import("mongoose").Types.ObjectId|string|null, orderId?: import("mongoose").Types.ObjectId|string|null, meta?: object }} [extra]
 */
function recordEvent(type, extra = {}) {
  const payload = { type: String(type || "").slice(0, 64), ...extra };
  setImmediate(() => {
    (async () => {
      try {
        const AnalyticsEvent = require("../models/AnalyticsEvent");
        const row = { type: payload.type, meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {} };
        if (payload.userId) row.user = payload.userId;
        if (payload.orderId) row.order = payload.orderId;
        await AnalyticsEvent.create(row);
      } catch (e) {
        console.error("[analytics]", e && e.message ? e.message : e);
      }
    })();
  });
}

module.exports = { recordEvent };
