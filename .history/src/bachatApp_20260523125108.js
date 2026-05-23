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
const { CATEGORIES } = require(".                                                                                         /lib/categories");
const geoRoutes = require("./routes/geo");
const digilockerRoutes = require("./routes/digilocker");
const disputesRoutes = require("./routes/disputes");
const leadsRoutes = require("./routes/leads");
const oidcTeamRoutes = require("./routes/oidcTeam");

const app = express();
const publicDir = path.join(__dirname, "..", "public");

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
      if (allowList.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(async (_req, _res, next) => {
  try {
    await connectDb();
    next();
  } catch (e) {
    next(e);
  }
});

app.post(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json" }),
  handleRazorpayWebhook
);

app.use("/api/products", express.json({ limit: "8mb" }), productRoutes);
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "UserDashboard.html"));
});

app.get("/api", (_req, res) => {
  res.json({ ok: true, service: "bachat-api", version: "0.1.0" });
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

app.use("/api/auth", authRoutes);
app.use("/api/auth/oidc", oidcTeamRoutes);
app.use("/api/disputes", disputesRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/saved", savedRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api", paymentApiRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);
/* /api/products mounted above with larger JSON limit for image payloads */

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
