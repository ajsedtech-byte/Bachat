const Seller = require("../models/Seller");
const User = require("../models/User");
const { claimTimeoutMs, normalizeAddressPart } = require("../lib/delivery");
const {
  areaMatches,
  inIndiaBounds,
  normalizePreciseLocation,
  reverseGeocodeCoords,
} = require("../lib/location");

const REQUESTABLE_DELIVERY_STATUSES = new Set([
  "none",
  "expired_unclaimed",
  "pending_details",
]);

class DeliveryRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DeliveryRequestError";
    this.status = status;
  }
}

function deliveryError(status, message) {
  return new DeliveryRequestError(status, message);
}

function sourceWithDetails(primary, fallback) {
  if (primary && Object.keys(primary).length) return primary;
  return fallback || {};
}

function requireValidPlace(label, place) {
  const lat = Number(place?.lat);
  const lng = Number(place?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw deliveryError(400, `${label} GPS location is required for delivery.`);
  }
  if (!inIndiaBounds(lat, lng)) {
    throw deliveryError(400, `${label} GPS location must be inside India.`);
  }
  if (!normalizeAddressPart(place?.addressText || place?.address)) {
    throw deliveryError(400, `${label} address text is required.`);
  }
}

function resetDeliveryAssignment(order) {
  order.delivery.driver = null;
  order.delivery.assignedAt = null;
  order.delivery.readyForPickupAt = null;
  order.delivery.pickedUpAt = null;
  order.delivery.deliveredAt = null;
  order.delivery.deliveryOtpHash = "";
  order.delivery.deliveryOtpSentAt = null;
  order.delivery.deliveryOtpExpiresAt = null;
  order.delivery.deliveryOtpVerifiedAt = null;
  order.delivery.deliveryOtpAttempts = 0;
  order.delivery.driverLastLat = null;
  order.delivery.driverLastLng = null;
  order.delivery.driverLocationAt = null;
  order.delivery.routePoints = [];
}

async function markPendingDeliveryDetails(order, buyer, reason) {
  order.delivery = order.delivery || {};
  order.delivery.status = "pending_details";
  order.delivery.fee = Number(order.delivery.fee || 0);
  order.delivery.requestedAt = null;
  order.delivery.claimExpiresAt = null;
  order.delivery.dropoffCity = normalizeAddressPart(buyer?.city || order.delivery.dropoffCity);
  order.delivery.dropoffRegion = normalizeAddressPart(buyer?.region || order.delivery.dropoffRegion);
  resetDeliveryAssignment(order);
  await order.save();
  return { order, status: "pending_details", reason };
}

async function requestDeliveryForOrder(order, options = {}) {
  const {
    dropoff,
    pickup,
    fee,
    allowPendingDetails = false,
    validateArea = true,
  } = options;

  if (!order) throw deliveryError(404, "Order not found");
  if (order.paymentStatus !== "paid") {
    throw deliveryError(400, "Order must be paid before requesting delivery");
  }

  order.delivery = order.delivery || {};
  const currentStatus = order.delivery.status || "none";
  if (!REQUESTABLE_DELIVERY_STATUSES.has(currentStatus)) {
    if (allowPendingDetails) return { order, status: "already_requested" };
    throw deliveryError(400, "Delivery already requested or in progress");
  }

  const buyer = await User.findById(order.user).lean();
  if (!buyer) throw deliveryError(404, "User not found");
  const sellerDoc = await Seller.findById(order.seller).lean();
  if (!sellerDoc) throw deliveryError(404, "Seller not found");

  const buyerLoc = normalizePreciseLocation(sourceWithDetails(dropoff, buyer?.location));
  const sellerLoc = normalizePreciseLocation(sourceWithDetails(pickup, sellerDoc?.location));
  if (!buyerLoc.capturedAt) buyerLoc.capturedAt = new Date();
  if (!sellerLoc.capturedAt) sellerLoc.capturedAt = new Date();

  const pendingOrThrow = async (error) => {
    if (!allowPendingDetails) throw error;
    return markPendingDeliveryDetails(order, buyer, error.message);
  };

  try {
    requireValidPlace("Drop-off", buyerLoc);
    requireValidPlace("Pickup", sellerLoc);
  } catch (error) {
    return pendingOrThrow(error);
  }

  let buyerReverse = null;
  let sellerReverse = null;
  if (validateArea) {
    try {
      buyerReverse = await reverseGeocodeCoords(buyerLoc.lat, buyerLoc.lng);
      sellerReverse = await reverseGeocodeCoords(sellerLoc.lat, sellerLoc.lng);
    } catch (error) {
      return pendingOrThrow(deliveryError(502, "Could not validate delivery GPS area. Please try again."));
    }

    if (!areaMatches(buyer?.city, buyer?.region, buyerReverse)) {
      return pendingOrThrow(deliveryError(400, "Drop-off GPS does not match the buyer city/state."));
    }
    if (!areaMatches(sellerDoc?.city, sellerDoc?.region, sellerReverse)) {
      return pendingOrThrow(deliveryError(400, "Pickup GPS does not match the seller city/state."));
    }
  }

  const dropPincode = normalizeAddressPart(
    buyerLoc.pincode || buyerReverse?.pincode || buyer?.pincode
  );
  const pickupPincode = normalizeAddressPart(
    sellerLoc.pincode || sellerReverse?.pincode || sellerDoc?.pincode
  );
  const dropPhone = normalizeAddressPart(dropoff?.contactPhone || buyer?.phone);
  const pickupPhone = normalizeAddressPart(pickup?.contactPhone || sellerDoc?.phone || sellerDoc?.contactPhone);

  order.delivery.status = "delivery_requested";
  order.delivery.fee = Math.max(0, Number(fee || 0) || 0);
  order.delivery.requestedAt = new Date();
  order.delivery.claimExpiresAt = new Date(Date.now() + claimTimeoutMs());
  order.delivery.dropoffCity = normalizeAddressPart(buyer?.city);
  order.delivery.dropoffRegion = normalizeAddressPart(buyer?.region);
  order.delivery.dropoff = {
    address: normalizeAddressPart(buyerLoc.addressText || buyerLoc.address),
    addressText: normalizeAddressPart(buyerLoc.addressText || buyerLoc.address),
    landmark: normalizeAddressPart(buyerLoc.landmark),
    pincode: dropPincode,
    lat: buyerLoc.lat,
    lng: buyerLoc.lng,
    accuracyM: buyerLoc.accuracyM,
    capturedAt: buyerLoc.capturedAt,
    contactPhone: dropPhone,
  };
  order.delivery.pickup = {
    address: normalizeAddressPart(sellerLoc.addressText || sellerLoc.address),
    addressText: normalizeAddressPart(sellerLoc.addressText || sellerLoc.address),
    landmark: normalizeAddressPart(sellerLoc.landmark),
    pincode: pickupPincode,
    lat: sellerLoc.lat,
    lng: sellerLoc.lng,
    accuracyM: sellerLoc.accuracyM,
    capturedAt: sellerLoc.capturedAt,
    contactPhone: pickupPhone,
  };
  resetDeliveryAssignment(order);

  await order.save();
  return { order, status: "delivery_requested" };
}

module.exports = {
  DeliveryRequestError,
  requestDeliveryForOrder,
};
