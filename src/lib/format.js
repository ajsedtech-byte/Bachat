function idStr(x) {
  if (x == null) return null;
  if (typeof x === "string") return x;
  return String(x);
}

const { sellerCategoryList } = require("./categories");

function formatUser(u) {
  if (!u) return null;
  const o = u.toObject ? u.toObject() : u;
  const saved = o.savedProducts || [];
  return {
    user_id: idStr(o._id),
    email: o.email,
    name: o.name,
    phone: o.phone,
    city: o.city,
    region: o.region,
    role: o.role,
    email_verified_at: o.emailVerifiedAt || null,
    created_at: o.createdAt,
    referral_code: o.referralCode || null,
    saved_product_count: Array.isArray(saved) ? saved.length : 0,
  };
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
  return {
    request_id: idStr(o._id),
    user_id: idStr(o.user),
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
  return {
    order_id: idStr(x._id),
    order_type: orderType,
    request_id: x.request ? idStr(x.request) : null,
    quote_id: x.quote ? idStr(x.quote) : null,
    user_id: idStr(x.user),
    seller_id: idStr(x.seller),
    final_price: x.finalPrice,
    platform_fee: x.platformFee,
    total_amount: x.totalAmount,
    payment_status: x.paymentStatus,
    order_status: x.orderStatus,
    line_items: lineItems,
    summary,
    created_at: x.createdAt,
  };
}

module.exports = { formatUser, formatSeller, formatRequest, formatQuote, formatOrder, idStr };
