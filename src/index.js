const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { connectDb } = require("./db/connection");
const app = require("./app");

const port = Number(process.env.PORT) || 3000;

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

connectDb()
  .then(() => {
    startServer(port);
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
