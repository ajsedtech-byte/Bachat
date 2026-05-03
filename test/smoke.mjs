import test from "node:test";
import assert from "node:assert/strict";

const base = (process.env.TEST_API_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const skip = String(process.env.SKIP_API_TESTS || "").toLowerCase() === "1" || process.env.SKIP_API_TESTS === "true";

test("health (optional — set SKIP_API_TESTS=1 to skip)", { skip }, async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.ok, true, `GET /health expected 2xx, got ${res.status}`);
  const body = await res.json().catch(() => ({}));
  assert.ok(body && typeof body === "object");
});

test("geo states list shape (optional)", { skip }, async () => {
  const res = await fetch(`${base}/api/geo/india-states-cities`);
  assert.equal(res.ok, true, `geo endpoint ${res.status}`);
  const data = await res.json();
  assert.ok(Array.isArray(data) || (data && typeof data === "object"), "geo response should be JSON array or object");
});

test("digilocker status JSON (optional)", { skip }, async () => {
  const res = await fetch(`${base}/api/digilocker/status`);
  assert.equal(res.ok, true);
  const j = await res.json();
  assert.equal(typeof j.enabled, "boolean");
  assert.equal(typeof j.issued_list_supported, "boolean");
  assert.equal(typeof j.file_fetch_enabled, "boolean");
  assert.equal(j.partner_registration_required, true);
  assert.equal(j.legal_review_required, true);
});
