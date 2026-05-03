const express = require("express");
const { getIndiaStatesCities } = require("../lib/indiaLocations");

const router = express.Router();

/** Public: India states and cities for delivery signup (and other UIs). */
router.get("/india-states-cities", (_req, res, next) => {
  try {
    return res.json(getIndiaStatesCities());
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
