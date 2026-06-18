const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { connectDb } = require("./db/connection");
const app = require("./bachatApp");
const { startDeliveryRouteCleanupJob } = require("./jobs/deliveryRouteCleanup");
const { startNotificationDispatcherJob } = require("./services/notificationDispatcher");

const port = Number(process.env.PORT) || 3000;

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err && err.stack ? err.stack : err);
});

const startServer = (initialPort) => {
  const server = app.listen(initialPort, () => {
    console.log(`API listening on http://localhost:${initialPort}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const nextPort = initialPort + 1;
      console.warn(`Port ${initialPort} is in use. Retrying on ${nextPort}...`);
      startServer(nextPort);
      return;
    }

    console.error("Server failed to start:", err.message);
    process.exit(1);
  });
};

startServer(port);

connectDb()
  .then(() => {
    startDeliveryRouteCleanupJob();
    startNotificationDispatcherJob();
  })
  .catch((err) => {
    console.warn("MongoDB is not connected yet:", err.message);
    console.warn("Static website pages will still run; DB-backed API routes will retry on request.");
  });
