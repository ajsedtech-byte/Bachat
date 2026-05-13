const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../src/models/User");
const Seller = require("../src/models/Seller");
const Request = require("../src/models/Request");
const Lead = require("../src/models/Lead");
const Order = require("../src/models/Order");
const { normalizeIndiaRegionCity } = require("../src/lib/indiaLocations");

const WRITE = process.argv.includes("--write");
const SAMPLE_LIMIT = 5;
const BULK_SIZE = 200;

function changedLocation(region, city) {
  const next = normalizeIndiaRegionCity(region, city);
  const nextRegion = next.region || String(region || "").trim();
  const nextCity = next.city || String(city || "").trim();
  const curRegion = String(region || "").trim();
  const curCity = String(city || "").trim();
  const changed = nextRegion !== curRegion || nextCity !== curCity;
  return { changed, region: nextRegion, city: nextCity, prevRegion: curRegion, prevCity: curCity };
}

async function flushBulk(Model, ops) {
  if (!ops.length) return;
  await Model.bulkWrite(ops, { ordered: false });
  ops.length = 0;
}

async function normalizeSimpleCollection(label, Model, cityPath = "city", regionPath = "region", query = {}) {
  const cursor = Model.find(query).select({ [cityPath]: 1, [regionPath]: 1 }).lean().cursor();
  const ops = [];
  const sample = [];
  let scanned = 0;
  let changed = 0;

  for await (const doc of cursor) {
    scanned += 1;
    const region = doc[regionPath];
    const city = doc[cityPath];
    const next = changedLocation(region, city);
    if (!next.changed) continue;
    changed += 1;
    if (sample.length < SAMPLE_LIMIT) {
      sample.push({
        id: String(doc._id),
        from: `${next.prevCity}, ${next.prevRegion}`,
        to: `${next.city}, ${next.region}`,
      });
    }
    if (WRITE) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { [cityPath]: next.city, [regionPath]: next.region } },
        },
      });
      if (ops.length >= BULK_SIZE) {
        await flushBulk(Model, ops);
      }
    }
  }

  if (WRITE) {
    await flushBulk(Model, ops);
  }

  return { label, scanned, changed, sample };
}

async function normalizeOrders() {
  const cursor = Order.find({
    $or: [
      { "delivery.dropoffCity": { $exists: true, $ne: "" } },
      { "delivery.dropoffRegion": { $exists: true, $ne: "" } },
    ],
  })
    .select({ "delivery.dropoffCity": 1, "delivery.dropoffRegion": 1 })
    .lean()
    .cursor();
  const ops = [];
  const sample = [];
  let scanned = 0;
  let changed = 0;

  for await (const doc of cursor) {
    scanned += 1;
    const next = changedLocation(doc.delivery?.dropoffRegion, doc.delivery?.dropoffCity);
    if (!next.changed) continue;
    changed += 1;
    if (sample.length < SAMPLE_LIMIT) {
      sample.push({
        id: String(doc._id),
        from: `${next.prevCity}, ${next.prevRegion}`,
        to: `${next.city}, ${next.region}`,
      });
    }
    if (WRITE) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              "delivery.dropoffCity": next.city,
              "delivery.dropoffRegion": next.region,
            },
          },
        },
      });
      if (ops.length >= BULK_SIZE) {
        await flushBulk(Order, ops);
      }
    }
  }

  if (WRITE) {
    await flushBulk(Order, ops);
  }

  return { label: "orders.delivery", scanned, changed, sample };
}

function printSummary(summary) {
  console.log(`\n[${summary.label}] scanned=${summary.scanned} changed=${summary.changed}`);
  if (!summary.sample.length) return;
  summary.sample.forEach((row) => {
    console.log(`  ${row.id}: ${row.from} -> ${row.to}`);
  });
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(WRITE ? "Running location normalization in WRITE mode" : "Running location normalization in DRY-RUN mode");

  const summaries = [];
  summaries.push(await normalizeSimpleCollection("users", User));
  summaries.push(await normalizeSimpleCollection("sellers", Seller));
  summaries.push(await normalizeSimpleCollection("requests", Request));
  summaries.push(await normalizeSimpleCollection("leads", Lead));
  summaries.push(await normalizeOrders());

  summaries.forEach(printSummary);

  const totalChanged = summaries.reduce((sum, item) => sum + item.changed, 0);
  console.log(`\nTotal changed candidates: ${totalChanged}`);
  if (!WRITE) {
    console.log("No writes applied. Re-run with --write to update MongoDB.");
  } else {
    console.log("Writes applied successfully.");
  }

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = { changedLocation };
