const crypto = require("crypto");

const MIN_MARKUP = 0.05;
const MAX_MARKUP = 0.07;

/**
 * Stable pseudo-random markup in [5%, 7%] per product (server secret).
 * Used only when shaping buyer-facing prices — never exposed in API fields.
 */
function markupRateForProduct(productId, secret) {
  const h = crypto.createHash("sha256").update(`${secret}:${String(productId)}`).digest();
  const n = h.readUInt32BE(0) / 0xffffffff;
  return MIN_MARKUP + n * (MAX_MARKUP - MIN_MARKUP);
}

function buyerDisplayPrice(sellerPrice, productId) {
  const secret = process.env.PRICE_MARKUP_SECRET || "bachat_dev_markup_change_me";
  const base = Number(sellerPrice);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const m = markupRateForProduct(productId, secret);
  return Math.ceil(base * (1 + m));
}

/** Upper bound buyer list price at max markup (for “savings vs worst-case markup” KPI). */
function buyerMaxListedPrice(sellerPrice) {
  const base = Number(sellerPrice);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.ceil(base * (1 + MAX_MARKUP));
}

module.exports = { buyerDisplayPrice, markupRateForProduct, buyerMaxListedPrice };
