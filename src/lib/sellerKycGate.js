const Seller = require("../models/Seller");

/** Statuses where the shop cannot quote, list products, or change orders until ops approves KYC. */
const KYC_BLOCKED = new Set(["awaiting_path", "salesman_pending", "direct_draft", "submitted", "rejected"]);

function sellerTradeBlocked(sellerLeanOrDoc) {
  if (!sellerLeanOrDoc || sellerLeanOrDoc.isVerified) {
    return false;
  }
  const st = sellerLeanOrDoc.sellerKyc && sellerLeanOrDoc.sellerKyc.status;
  if (st == null || st === "") {
    return false;
  }
  return KYC_BLOCKED.has(st);
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

module.exports = { sellerTradeBlocked, requireSellerTradeUnblocked, forbiddenKyc, KYC_BLOCKED };
