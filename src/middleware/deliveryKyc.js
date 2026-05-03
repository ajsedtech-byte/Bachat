const User = require("../models/User");

function forbidden(res, message = "Forbidden", extra = {}) {
  return res.status(403).json({ error: message, ...extra });
}

/** After email verification, delivery partners must complete KYC and be approved (or auto-verified in dev). */
async function requireDeliveryKycVerified(req, res, next) {
  if (req.user.role !== "delivery") {
    return next();
  }
  try {
    const u = await User.findById(req.user.id).select("deliveryKyc").lean();
    const st = u?.deliveryKyc?.status || "not_started";
    if (st !== "verified") {
      return forbidden(res, "Complete delivery partner verification first", {
        kyc_status: st,
      });
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { requireDeliveryKycVerified };
