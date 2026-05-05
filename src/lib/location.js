function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inIndiaBounds(lat, lng) {
  const la = num(lat);
  const ln = num(lng);
  if (la == null || ln == null) return false;
  // Broad India bounding box (mainland + islands).
  return la >= 6 && la <= 38.5 && ln >= 68 && ln <= 97.5;
}

function normalizePincode(v) {
  const s = String(v || "").trim();
  return s.slice(0, 12);
}

function normalizePreciseLocation(raw) {
  const x = raw && typeof raw === "object" ? raw : {};
  const out = {
    addressText: String(x.address_text || x.addressText || x.address || "").trim().slice(0, 300),
    landmark: String(x.landmark || "").trim().slice(0, 160),
    pincode: normalizePincode(x.pincode),
    lat: num(x.lat),
    lng: num(x.lng),
    accuracyM: num(x.accuracy_m != null ? x.accuracy_m : x.accuracyM),
    capturedAt: x.captured_at || x.capturedAt ? new Date(x.captured_at || x.capturedAt) : null,
    consentAcceptedAt:
      x.consent_accepted_at || x.consentAcceptedAt ? new Date(x.consent_accepted_at || x.consentAcceptedAt) : null,
  };
  if (!Number.isFinite(out.accuracyM)) out.accuracyM = null;
  if (!(out.capturedAt instanceof Date) || Number.isNaN(out.capturedAt.getTime())) out.capturedAt = null;
  if (!(out.consentAcceptedAt instanceof Date) || Number.isNaN(out.consentAcceptedAt.getTime())) out.consentAcceptedAt = null;
  return out;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const aa =
    s1 * s1 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

function etaMinutes(distanceKm, avgKmph) {
  const speed = Number(avgKmph) > 0 ? Number(avgKmph) : 22;
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  return Math.max(1, Math.round((distanceKm / speed) * 60));
}

function areaToken(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function reverseGeocodeCoords(lat, lng) {
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
    throw new Error("reverse_geocode_failed");
  }
  const a = j.address || {};
  return {
    city: a.city || a.town || a.village || a.county || "",
    region: a.state || a.region || "",
    pincode: a.postcode || "",
    displayName: j.display_name || "",
  };
}

function areaMatches(expectedCity, expectedRegion, actual) {
  const cExp = areaToken(expectedCity);
  const rExp = areaToken(expectedRegion);
  const cAct = areaToken(actual && actual.city);
  const rAct = areaToken(actual && actual.region);
  const cityOk = !cExp || !cAct ? true : cAct.includes(cExp) || cExp.includes(cAct);
  const regionOk = !rExp || !rAct ? true : rAct.includes(rExp) || rExp.includes(rAct);
  return cityOk && regionOk;
}

module.exports = {
  inIndiaBounds,
  normalizePreciseLocation,
  haversineKm,
  etaMinutes,
  reverseGeocodeCoords,
  areaMatches,
};

