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

/** Reverse geocode helper for client map pin confirmation. */
router.get("/reverse", async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat and lng are required numbers" });
    }
    // Keep within India bounds to reduce abuse.
    if (lat < 6 || lat > 38.5 || lng < 68 || lng > 97.5) {
      return res.status(400).json({ error: "Coordinates out of supported bounds" });
    }
    const u = new URL("https://nominatim.openstreetmap.org/reverse");
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lng));
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("addressdetails", "1");
    const r = await fetch(u, {
      headers: {
        "User-Agent": "Bachat/1.0 (team@bachat.local)",
        Accept: "application/json",
      },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: "Reverse geocode failed" });
    }
    const a = j.address || {};
    return res.json({
      display_name: j.display_name || "",
      address_text: j.display_name || "",
      city: a.city || a.town || a.village || a.county || "",
      region: a.state || a.region || "",
      pincode: a.postcode || "",
      country: a.country || "",
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
