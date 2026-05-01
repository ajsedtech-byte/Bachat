const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const collection = mongoose.connection.collection("orders");
  const indexes = await collection.indexes();

  if (indexes.find((i) => i.name === "request_1")) {
    await collection.dropIndex("request_1");
    console.log("Dropped index request_1");
  }
  if (indexes.find((i) => i.name === "quote_1")) {
    await collection.dropIndex("quote_1");
    console.log("Dropped index quote_1");
  }

  const unsetResult = await collection.updateMany(
    { $or: [{ request: null }, { quote: null }] },
    { $unset: { request: "", quote: "" } }
  );
  console.log(`Unset null request/quote on ${unsetResult.modifiedCount} orders`);

  await collection.createIndex(
    { request: 1 },
    { name: "request_1", unique: true, partialFilterExpression: { request: { $exists: true } } }
  );
  console.log("Created partial unique request_1");

  await collection.createIndex(
    { quote: 1 },
    { name: "quote_1", unique: true, partialFilterExpression: { quote: { $exists: true } } }
  );
  console.log("Created partial unique quote_1");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
