import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import User from "../src/models/User.js";
import Seller from "../src/models/Seller.js";
import Order from "../src/models/Order.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const base = (process.env.TEST_API_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const skip = String(process.env.SKIP_API_TESTS || "").toLowerCase() === "1" || process.env.SKIP_API_TESTS === "true";

function tokenFor(userId, role) {
  return jwt.sign({ sub: String(userId), role }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

function referralCode(prefix) {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${rand}`.slice(0, 12);
}

async function req(token, method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function seedPaidOrder() {
  let buyer = await User.findOne({ email: "test-buyer-gps@bachat.local" });
  if (!buyer) {
    buyer = await User.create({
      email: "test-buyer-gps@bachat.local",
      referralCode: referralCode("BUY"),
      passwordHash: await bcrypt.hash("BachatBuyer2026!", 10),
      name: "Test Buyer GPS",
      city: "Indore",
      region: "MP",
      role: "buyer",
      emailVerifiedAt: new Date(),
    });
  }
  let sellerUser = await User.findOne({ email: "test-seller-gps@bachat.local" });
  if (!sellerUser) {
    sellerUser = await User.create({
      email: "test-seller-gps@bachat.local",
      referralCode: referralCode("SEL"),
      passwordHash: await bcrypt.hash("BachatSeller2026!", 10),
      name: "Test Seller GPS",
      city: "Indore",
      region: "MP",
      role: "seller",
      emailVerifiedAt: new Date(),
    });
  }
  let seller = await Seller.findOne({ user: sellerUser._id });
  if (!seller) {
    seller = await Seller.create({
      user: sellerUser._id,
      shopName: "Test Seller GPS Shop",
      categories: ["Groceries"],
      city: "Indore",
      region: "MP",
      isVerified: true,
      sellerKyc: { status: "verified", path: "direct", submittedAt: new Date(), verifiedAt: new Date() },
      location: {
        addressText: "Rajwada, Indore",
        pincode: "452001",
        lat: 22.7196,
        lng: 75.8577,
        capturedAt: new Date(),
        consentAcceptedAt: new Date(),
      },
    });
  }
  const order = await Order.create({
    orderType: "catalog",
    user: buyer._id,
    seller: seller._id,
    finalPrice: 199,
    platformFee: 0,
    totalAmount: 199,
    paymentStatus: "paid",
    orderStatus: "processing",
  });
  return { buyer, order };
}

test("delivery-request rejects missing dropoff coordinates", { skip }, async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const { buyer, order } = await seedPaidOrder();
  const buyerTok = tokenFor(buyer._id, "buyer");
  const { res, data } = await req(buyerTok, "POST", `/api/orders/${order._id}/delivery-request`, {
    dropoff: { address_text: "Vijay Nagar, Indore" },
  });
  await mongoose.disconnect();

  assert.equal(res.status, 400);
  assert.match(String(data.error || ""), /dropoff\.lat and dropoff\.lng are required/i);
});

test("delivery-request geofence mismatch is rejected (or geocode outage surfaces)", { skip }, async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const { buyer, order } = await seedPaidOrder();
  const buyerTok = tokenFor(buyer._id, "buyer");
  const { res, data } = await req(buyerTok, "POST", `/api/orders/${order._id}/delivery-request`, {
    dropoff: {
      address_text: "Chennai location mismatch probe",
      lat: 13.0827,
      lng: 80.2707,
      pincode: "600001",
      consent_accepted_at: new Date().toISOString(),
    },
    pickup: {
      address_text: "Rajwada, Indore",
      lat: 22.7196,
      lng: 75.8577,
      pincode: "452001",
      consent_accepted_at: new Date().toISOString(),
    },
  });
  await mongoose.disconnect();

  assert.ok([400, 502].includes(res.status), `expected 400/502, got ${res.status}`);
  if (res.status === 400) {
    assert.match(String(data.error || ""), /does not match/i);
  } else {
    assert.match(String(data.error || ""), /Could not validate GPS area/i);
  }
});

