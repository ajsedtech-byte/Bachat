/**
 * Optional live GST registry call — you supply HTTPS URL + optional bearer.
 * GST_REGISTRY_LOOKUP_URL must include literal `{gstin}` (GET).
 * Response parsing supports common shapes (MasterGST-style, generic).
 */

const TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.GST_REGISTRY_LOOKUP_TIMEOUT_MS || "12000", 10) || 12000, 3000),
  30000
);

function interpretBody(json) {
  const root = json && typeof json === "object" && json.data && typeof json.data === "object" ? json.data : json;
  if (!root || typeof root !== "object") {
    return { active: false, legal_name: "" };
  }
  const sts = String(root.sts || root.status || root.gstinStatus || "").toLowerCase();
  const active =
    root.active === true ||
    root.valid === true ||
    sts === "active" ||
    sts === "act" ||
    (root.taxpayerInfo && String(root.taxpayerInfo.sts || "").toLowerCase() === "active");
  const legal =
    root.lgnm ||
    root.legal_name ||
    root.tradeNam ||
    root.tradeName ||
    root.legalName ||
    (root.taxpayerInfo && root.taxpayerInfo.lgnm) ||
    "";
  return { active: !!active, legal_name: String(legal || "").trim().slice(0, 200) };
}

/**
 * @returns {Promise<{ skipped?: true } | { active: boolean, legal_name: string } | { error: string }>}
 */
async function gstRegistryLookupHttp(gstin) {
  const urlTpl = String(process.env.GST_REGISTRY_LOOKUP_URL || "").trim();
  if (!urlTpl) {
    return { skipped: true };
  }
  if (!urlTpl.includes("{gstin}")) {
    return { error: "GST_REGISTRY_LOOKUP_URL must include {gstin} (e.g. https://proxy.example.com/gst/{gstin})" };
  }
  const bearer = String(process.env.GST_REGISTRY_LOOKUP_BEARER || "").trim();
  const url = urlTpl.split("{gstin}").join(encodeURIComponent(gstin));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(bearer ? { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` } : {}),
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return { error: `Registry returned non-JSON (HTTP ${res.status})` };
    }
    if (!res.ok) {
      const msg = json.message || json.error || json.error_description || `HTTP ${res.status}`;
      return { error: String(msg).slice(0, 500) };
    }
    return interpretBody(json);
  } catch (e) {
    const name = e && e.name;
    return { error: name === "AbortError" ? "Registry request timed out" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { gstRegistryLookupHttp };
