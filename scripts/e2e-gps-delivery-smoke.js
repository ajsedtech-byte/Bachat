/* eslint-disable no-console */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Seller = require("../src/models/Seller");
const Order = require("../src/models/Order");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function tokenFor(userId, role) {
  return jwt.sign({ sub: String(userId), role }, mustEnv("JWT_SECRET"), { expiresIn: "1h" });
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(base, token, method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${route} -> ${res.status}: ${data.error || "failed"}`);
  }
  return data;
}

async function ensureUsers() {
  let buyer = await User.findOne({ role: "buyer" });
  if (!buyer) {
    buyer = await User.create({
      email: "gpsbuyer@bachat.local",
      passwordHash: await bcrypt.hash("BachatBuyer2026!", 10),
      name: "GPS Buyer",
      city: "Indore",
      region: "MP",
      phone: "9999990001",
      role: "buyer",
      emailVerifiedAt: new Date(),
      location: {
        addressText: "Vijay Nagar, Indore",
        landmark: "Square",
        pincode: "452010",
        lat: 22.7533,
        lng: 75.8937,
        accuracyM: 12,
        capturedAt: new Date(),
        consentAcceptedAt: new Date(),
      },
    });
  }

  let sellerUser = await User.findOne({ role: "seller" });
  let seller = null;
  if (sellerUser) seller = await Seller.findOne({ user: sellerUser._id });
  if (!sellerUser || !seller) {
    sellerUser =
      sellerUser ||
      (await User.create({
        email: "gpsseller@bachat.local",
        passwordHash: await bcrypt.hash("BachatSeller2026!", 10),
        name: "GPS Seller",
        city: "Indore",
        region: "MP",
        phone: "9999990002",
        role: "seller",
        emailVerifiedAt: new Date(),
      }));
    seller = await Seller.findOneAndUpdate(
      { user: sellerUser._id },
      {
        $set: {
          shopName: "GPS Shop",
          categories: ["Groceries"],
          city: "Indore",
          region: "MP",
          isVerified: true,
          sellerKyc: {
            status: "verified",
            path: "direct",
            submittedAt: new Date(),
            verifiedAt: new Date(),
            businessDetailsCompletedAt: new Date(),
          },
          location: {
            addressText: "Rajwada, Indore",
            landmark: "Main Road",
            pincode: "452001",
            lat: 22.7196,
            lng: 75.8577,
            accuracyM: 10,
            capturedAt: new Date(),
            consentAcceptedAt: new Date(),
          },
        },
      },
      { upsert: true, new: true }
    );
  }
  if (!seller.sellerKyc || seller.sellerKyc.status !== "verified") {
    seller.sellerKyc = {
      ...(seller.sellerKyc ? seller.sellerKyc.toObject?.() || seller.sellerKyc : {}),
      status: "verified",
      path: "direct",
      submittedAt: seller.sellerKyc?.submittedAt || new Date(),
      verifiedAt: new Date(),
      businessDetailsCompletedAt: seller.sellerKyc?.businessDetailsCompletedAt || new Date(),
    };
    seller.isVerified = true;
    await seller.save();
  }

  let driver = await User.findOne({ role: "delivery" });
  if (!driver) {
    driver = await User.create({
      email: "gpsdriver@bachat.local",
      passwordHash: await bcrypt.hash("BachatDriver2026!", 10),
      name: "GPS Driver",
      city: "Indore",
      region: "MP",
      phone: "9999990003",
      role: "delivery",
      emailVerifiedAt: new Date(),
      deliveryKyc: {
        status: "verified",
        verifiedAt: new Date(),
        submittedAt: new Date(),
        consentAcceptedAt: new Date(),
      },
    });
  } else if (driver.deliveryKyc?.status !== "verified") {
    driver.deliveryKyc = {
      status: "verified",
      verifiedAt: new Date(),
      submittedAt: new Date(),
      consentAcceptedAt: new Date(),
    };
    await driver.save();
  }

  const admin = await User.findOne({ role: "admin" });
  if (!admin) throw new Error("No admin user found");
  return { buyer, sellerUser, seller, driver, admin };
}

async function main() {
  const base = (process.env.TEST_API_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  await mongoose.connect(mustEnv("MONGO_URI"), { serverSelectionTimeoutMS: 15000 });
  const { buyer, sellerUser, seller, driver, admin } = await ensureUsers();

  const order = await Order.create({
    orderType: "catalog",
    user: buyer._id,
    seller: seller._id,
    finalPrice: 499,
    platformFee: 0,
    totalAmount: 499,
    paymentStatus: "paid",
    orderStatus: "processing",
  });

  const buyerTok = tokenFor(buyer._id, "buyer");
  const sellerTok = tokenFor(sellerUser._id, "seller");
  const driverTok = tokenFor(driver._id, "delivery");
  const adminTok = tokenFor(admin._id, "admin");

  console.log("order:", String(order._id));

  await api(base, buyerTok, "POST", `/api/orders/${order._id}/delivery-request`, {
    pickup: {
      address_text: "Rajwada, Indore",
      landmark: "Main Road",
      pincode: "452001",
      lat: 22.7196,
      lng: 75.8577,
      accuracy_m: 9,
      consent_accepted_at: new Date().toISOString(),
    },
    dropoff: {
      address_text: "Vijay Nagar, Indore",
      landmark: "Square",
      pincode: "452010",
      lat: 22.7533,
      lng: 75.8937,
      accuracy_m: 8,
      consent_accepted_at: new Date().toISOString(),
    },
  });
  console.log("buyer requested delivery");

  await api(base, driverTok, "POST", `/api/delivery/jobs/${order._id}/claim`);
  await api(base, driverTok, "PATCH", `/api/delivery/jobs/${order._id}/status`, {
    status: "driver_en_route_pickup",
  });
  await api(base, driverTok, "POST", `/api/delivery/jobs/${order._id}/location`, {
    lat: 22.7301,
    lng: 75.8701,
    accuracy_m: 14,
  });
  console.log("driver claimed + en route pickup + location");

  await api(base, sellerTok, "POST", `/api/orders/seller/${order._id}/delivery-ready`, {
    pickup: {
      address_text: "Rajwada, Indore",
      landmark: "Main Road",
      pincode: "452001",
      lat: 22.7196,
      lng: 75.8577,
      accuracy_m: 9,
      captured_at: new Date().toISOString(),
    },
  });
  console.log("seller marked ready");

  await api(base, driverTok, "PATCH", `/api/delivery/jobs/${order._id}/status`, { status: "picked_up" });
  await api(base, driverTok, "PATCH", `/api/delivery/jobs/${order._id}/status`, { status: "en_route_dropoff" });
  await wait(Number(process.env.DELIVERY_GPS_MIN_GAP_MS || 6000) + 500);
  await api(base, driverTok, "POST", `/api/delivery/jobs/${order._id}/location`, {
    lat: 22.7444,
    lng: 75.8852,
    accuracy_m: 13,
  });
  await api(base, driverTok, "PATCH", `/api/delivery/jobs/${order._id}/status`, { status: "delivered" });
  console.log("driver completed delivery");

  const buyerTrack = await api(base, buyerTok, "GET", `/api/delivery/track/${order._id}`);
  const adminTrack = await api(base, adminTok, "GET", `/api/delivery/track/${order._id}`);
  console.log("buyer track status:", buyerTrack.delivery && buyerTrack.delivery.status);
  console.log("admin track points:", (adminTrack.delivery && adminTrack.delivery.route_points || []).length);

  await mongoose.disconnect();
  console.log("E2E GPS delivery smoke: PASS");
}

main().catch(async (e) => {
  console.error("E2E GPS delivery smoke: FAIL");
  console.error(e.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});

