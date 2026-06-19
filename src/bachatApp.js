const path = require("path");
const express = require("express");
const cors = require("cors");
const { connectDb } = require("./db/connection");
const authRoutes = require("./routes/auth");
const requestRoutes = require("./routes/requests");
const quoteRoutes = require("./routes/quotes");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const productRoutes = require("./routes/products");
const cartRoutes = require("./routes/cart");
const savedRoutes = require("./routes/saved");
const sellerRoutes = require("./routes/seller");
const deliveryRoutes = require("./routes/delivery");
const { router: paymentRoutes, apiRouter: paymentApiRoutes, handleRazorpayWebhook } = require("./routes/payments");
const { CATEGORIES } = require("./lib/categories");
const geoRoutes = require("./routes/geo");
const digilockerRoutes = require("./routes/digilocker");
const disputesRoutes = require("./routes/disputes");
const leadsRoutes = require("./routes/leads");
const oidcTeamRoutes = require("./routes/oidcTeam");
const notificationRoutes = require("./routes/notifications");
const careersRoutes = require("./routes/careers");

const app = express();
const publicDir = path.join(__dirname, "..", "public");
const nativeAppOrigins = new Set([
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "ionic://localhost",
]);

app.use(
  cors({
    origin(origin, callback) {
      const allowList = (process.env.CORS_ORIGIN || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!allowList.length) {
        return callback(null, true);
      }
      if (!origin || origin === "null") {
        return callback(null, false);
      }
      if (allowList.includes(origin) || nativeAppOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

async function requireDb(_req, _res, next) {
  try {
    await connectDb();
    next();
  } catch (e) {
    next(e);
  }
}

app.post(
  "/api/payments/razorpay/webhook",
  requireDb,
  express.raw({ type: "application/json" }),
  handleRazorpayWebhook
);

app.use("/api/products", requireDb, express.json({ limit: "8mb" }), productRoutes);
app.use("/api/seller", requireDb, express.json({ limit: "8mb" }), sellerRoutes);
app.use("/api/admin", requireDb, express.json({ limit: "12mb" }), adminRoutes);
app.use("/api/careers", express.json({ limit: "8mb" }), careersRoutes);
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "UserDashboard.html"));
});
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Public list for signup, dashboards, and product category pickers */
app.get("/api/categories", (_req, res) => {
  res.json({ categories: CATEGORIES });
});

app.use("/api/geo", geoRoutes);
app.use("/api/digilocker", digilockerRoutes);
app.use("/api/notifications", requireDb, notificationRoutes);

app.use("/api/auth", requireDb, authRoutes);
app.use("/api/auth/oidc", requireDb, oidcTeamRoutes);
app.use("/api/disputes", requireDb, disputesRoutes);
app.use("/api/leads", requireDb, leadsRoutes);
app.use("/api/requests", requireDb, requestRoutes);
app.use("/api/quotes", requireDb, quoteRoutes);
app.use("/api/orders", requireDb, orderRoutes);
app.use("/api/delivery", requireDb, deliveryRoutes);
app.use("/api/cart", requireDb, cartRoutes);
app.use("/api/saved", requireDb, savedRoutes);
app.use("/api", requireDb, paymentApiRoutes);
app.use("/api/payments", requireDb, paymentRoutes);
/* Upload-heavy routes are mounted above with larger JSON limits for base64 file payloads. */

/** Static UI (local dev + any non-Vercel hosting). On Vercel, files under public/ are served by the CDN. */
app.use(express.static(publicDir));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  const isServerError = status >= 500;
  const message = isServerError
    ? err.publicMessage || "Internal Server Error"
    : err.publicMessage || err.message || "Request failed";
  res.status(status).json({ error: message });
});

module.exports = app;
