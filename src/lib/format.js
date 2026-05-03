function idStr(x) {
  if (x == null) return null;
  if (typeof x === "string") return x;
  return String(x);
}

const { sellerCategoryList } = require("./categories");
const { maskPhone } = require("./delivery");

function formatUser(u) {
  if (!u) return null;
  const o = u.toObject ? u.toObject() : u;
  const saved = o.savedProducts || [];
  const base = {
    user_id: idStr(o._id),
    email: o.email,
    name: o.name,
    phone: o.phone,
    city: o.city,
    region: o.region,
    role: o.role,
    email_verified_at: o.emailVerifiedAt || null,
    phone_verified_at: o.phoneVerifiedAt || null,
    created_at: o.createdAt,
    referral_code: o.referralCode || null,
    saved_product_count: Array.isArray(saved) ? saved.length : 0,
  };
  if (o.role === "delivery") {
    const k = o.deliveryKyc || {};
    base.delivery_kyc = {
      status: k.status || "not_started",
      submitted_at: k.submittedAt || null,
      verified_at: k.verifiedAt || null,
    };
    if (k.status === "rejected" && k.rejectedReason) {
      base.delivery_kyc.rejection_reason = k.rejectedReason;
    }
    if (k.digilockerLinkedAt) {
      base.delivery_kyc.digilocker_linked_at = k.digilockerLinkedAt;
    }
    if (k.digilockerIssuedSyncedAt) {
      base.delivery_kyc.digilocker_issued_synced_at = k.digilockerIssuedSyncedAt;
    }
    const issued = k.digilockerIssuedItems;
    if (Array.isArray(issued) && issued.length) {
      base.delivery_kyc.digilocker_issued_docs = issued.map((row) => {
        const { uri: _omit, ...rest } = row || {};
        return rest;
      });
    }
  }
  return base;
}

function formatSeller(s) {
  if (!s) return null;
  const o = s.toObject ? s.toObject() : s;
  const cats = sellerCategoryList(o);
  return {
    seller_id: idStr(o._id),
    user_id: idStr(o.user),
    shop_name: o.shopName,
    categories: cats,
    category: cats[0] || o.category || null,
    city: o.city,
    region: o.region,
    rating: o.rating,
    is_verified: o.isVerified,
    created_at: o.createdAt,
  };
}

function formatRequest(r) {
  const o = r.toObject ? r.toObject() : r;
  const uid = o.user && typeof o.user === "object" && o.user._id != null ? o.user._id : o.user;
  return {
    request_id: idStr(o._id),
    user_id: idStr(uid),
    category: o.category,
    product_name: o.productName,
    specifications: o.specifications ?? null,
    budget: o.budget ?? null,
    city: o.city,
    region: o.region,
    status: o.status,
    created_at: o.createdAt,
  };
}

function formatQuote(q, sellerDoc = null) {
  const o = q.toObject ? q.toObject() : q;
  const base = {
    quote_id: idStr(o._id),
    request_id: idStr(o.request),
    seller_id: idStr(o.seller),
    price: o.price,
    delivery_time: o.deliveryTime || "",
    notes: o.notes || "",
    created_at: o.createdAt,
  };
  if (sellerDoc) {
    const sd = sellerDoc.toObject ? sellerDoc.toObject() : sellerDoc;
    base.shop_name = sd.shopName;
    base.seller_rating = sd.rating;
    base.seller_city = sd.city;
    base.seller_region = sd.region;
  }
  return base;
}

function formatDeliveryPublic(d) {
  if (!d || !d.status || d.status === "none") {
    return {
      status: d?.status || "none",
      fee: d?.fee ?? 0,
      driver_id: d?.driver ? idStr(d.driver) : null,
      claim_expires_at: d?.claimExpiresAt || null,
      ready_for_pickup_at: d?.readyForPickupAt || null,
      picked_up_at: d?.pickedUpAt || null,
      delivered_at: d?.deliveredAt || null,
      driver_last_lat: d?.driverLastLat ?? null,
      driver_last_lng: d?.driverLastLng ?? null,
      driver_location_at: d?.driverLocationAt || null,
      dropoff_city: d?.dropoffCity != null ? d.dropoffCity : "",
      dropoff_region: d?.dropoffRegion != null ? d.dropoffRegion : "",
    };
  }
  const dropPhone = d.dropoff?.contactPhone ? maskPhone(d.dropoff.contactPhone) : "";
  const pickupPhone = d.pickup?.contactPhone ? maskPhone(d.pickup.contactPhone) : "";
  return {
    status: d.status,
    fee: d.fee ?? 0,
    driver_id: d.driver ? idStr(d.driver) : null,
    claim_expires_at: d.claimExpiresAt || null,
    ready_for_pickup_at: d.readyForPickupAt || null,
    picked_up_at: d.pickedUpAt || null,
    delivered_at: d.deliveredAt || null,
    driver_last_lat: d.driverLastLat ?? null,
    driver_last_lng: d.driverLastLng ?? null,
    driver_location_at: d.driverLocationAt || null,
    pickup: {
      address: d.pickup?.address || "",
      landmark: d.pickup?.landmark || "",
      lat: d.pickup?.lat ?? null,
      lng: d.pickup?.lng ?? null,
      contact_phone_masked: pickupPhone,
    },
    dropoff: {
      address: d.dropoff?.address || "",
      landmark: d.dropoff?.landmark || "",
      lat: d.dropoff?.lat ?? null,
      lng: d.dropoff?.lng ?? null,
      contact_phone_masked: dropPhone,
    },
    dropoff_city: d.dropoffCity || "",
    dropoff_region: d.dropoffRegion || "",
  };
}

function formatDeliveryPrivate(d) {
  const pub = formatDeliveryPublic(d);
  if (!d || d.status === "none") return pub;
  return {
    ...pub,
    pickup: {
      ...pub.pickup,
      contact_phone: d.pickup?.contactPhone || "",
    },
    dropoff: {
      ...pub.dropoff,
      contact_phone: d.dropoff?.contactPhone || "",
    },
  };
}

function formatOrder(doc) {
  const x = doc.toObject ? doc.toObject() : doc;
  const orderType = x.orderType || "quote";
  const lineItems = (x.lineItems || []).map((li) => ({
    product_id: idStr(li.product),
    title: li.title,
    quantity: li.quantity,
    unit_price: li.unitPrice,
  }));
  let summary = null;
  if (orderType === "catalog" && lineItems.length) {
    summary = lineItems.map((li) => `${li.title} ×${li.quantity}`).join(", ");
  } else if (orderType === "quote") {
    summary = "Custom request";
  }
  const uid = x.user && typeof x.user === "object" && x.user._id != null ? x.user._id : x.user;
  const sid = x.seller && typeof x.seller === "object" && x.seller._id != null ? x.seller._id : x.seller;
  return {
    order_id: idStr(x._id),
    order_type: orderType,
    request_id: x.request ? idStr(x.request) : null,
    quote_id: x.quote ? idStr(x.quote) : null,
    user_id: idStr(uid),
    seller_id: idStr(sid),
    final_price: x.finalPrice,
    platform_fee: x.platformFee,
    total_amount: x.totalAmount,
    payment_status: x.paymentStatus,
    order_status: x.orderStatus,
    line_items: lineItems,
    summary,
    created_at: x.createdAt,
    delivery: formatDeliveryPublic(x.delivery),
  };
}

/** Mask account email for UI, e.g. `ab***@gmail.com`. */
function maskEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return "";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!domain) return "";
  const head = local.slice(0, Math.min(2, local.length));
  const mid = local.length > 2 ? "***" : "";
  return `${head}${mid}@${domain}`;
}

module.exports = {
  formatUser,
  formatSeller,
  formatRequest,
  formatQuote,
  formatOrder,
  formatDeliveryPublic,
  formatDeliveryPrivate,
  idStr,
  maskEmail,
};
