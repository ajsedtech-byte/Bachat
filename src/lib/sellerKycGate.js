const Seller = require("../models/Seller");

/**
 * Any shop that is not ops-verified must complete eKYC before trading or using the dashboard.
 * Applies to new signups and legacy sellers (no sellerKyc subdoc, or any in-progress status).
 */
function sellerTradeBlocked(sellerLeanOrDoc) {
  if (!sellerLeanOrDoc || sellerLeanOrDoc.isVerified) {
    return false;
  }
  return true;
}

function forbiddenKyc(res) {
  return res.status(403).json({
    error: "Complete shop verification (eKYC) before using this feature.",
    code: "SELLER_KYC_REQUIRED",
  });
}

/** Express middleware after requireAuth + requireRole("seller"). */
function requireSellerTradeUnblocked(req, res, next) {
  Seller.findOne({ user: req.user.id })
    .lean()
    .then((seller) => {
      if (!seller) {
        return res.status(404).json({ error: "Seller profile not found" });
      }
      if (sellerTradeBlocked(seller)) {
        return forbiddenKyc(res);
      }
      req.sellerProfile = seller;
      return next();
    })
    .catch(next);
}

module.exports = { sellerTradeBlocked, requireSellerTradeUnblocked, forbiddenKyc };
