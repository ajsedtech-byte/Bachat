const crypto = require("crypto");

const PRICE_MARKUP_BANDS = Object.freeze([
  { maxBasePrice: 300, minMarkup: 0.12, maxMarkup: 0.18 },
  { maxBasePrice: 500, minMarkup: 0.15, maxMarkup: 0.20 },
  { maxBasePrice: 1000, minMarkup: 0.15, maxMarkup: 0.22 },
  { maxBasePrice: Infinity, minMarkup: 0.14, maxMarkup: 0.25 },
]);
const PRICE_MARKUP_SALT = "bachat_buyer_markup_v1";

function markupBandForPrice(basePrice) {
  const base = Number(basePrice);
  if (!Number.isFinite(base) || base <= 0) {
    return PRICE_MARKUP_BANDS[0];
  }
  return PRICE_MARKUP_BANDS.find((band) => base <= band.maxBasePrice) || PRICE_MARKUP_BANDS[PRICE_MARKUP_BANDS.length - 1];
}

/**
 * Stable pseudo-random markup inside the configured band for the seller price.
 * Used only when shaping buyer-facing prices — never exposed in API fields.
 */
function markupRateForProduct(productId, secret) {
  return markupRateForPriceBand(0, productId, secret);
}

function markupRateForPriceBand(sellerPrice, productId, secret) {
  const h = crypto.createHash("sha256").update(`${secret}:${String(productId)}`).digest();
  const n = h.readUInt32BE(0) / 0xffffffff;
  const band = markupBandForPrice(sellerPrice);
  return band.minMarkup + n * (band.maxMarkup - band.minMarkup);
}

function buyerDisplayPrice(sellerPrice, productId, mrp) {
  const base = Number(sellerPrice);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const m = markupRateForPriceBand(base, productId, PRICE_MARKUP_SALT);
  const display = Math.ceil(base * (1 + m));
  const maxRetail = Number(mrp);
  if (Number.isFinite(maxRetail) && maxRetail >= base && maxRetail > 0) {
    return Math.min(display, maxRetail);
  }
  return display;
}

/** Upper bound buyer list price at the max markup for that price band. */
function buyerMaxListedPrice(sellerPrice) {
  const base = Number(sellerPrice);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const band = markupBandForPrice(base);
  return Math.ceil(base * (1 + band.maxMarkup));
}

module.exports = { buyerDisplayPrice, markupRateForProduct, buyerMaxListedPrice, markupBandForPrice };
