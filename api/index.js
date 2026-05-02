/**
 * Vercel serverless entry: mounts the Express app on /api/* → rewrites send /api/* here.
 * See https://vercel.com/docs/functions/serverless-functions/runtimes/node-js#using-express
 */
const app = require("../src/bachatApp");

module.exports = app;
