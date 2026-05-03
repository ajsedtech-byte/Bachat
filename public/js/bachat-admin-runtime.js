/**
 * Shared fetch + admin gate for ops pages under /public/admin-*.html
 */
(function (global) {
  function authHeaders() {
    var t = localStorage.getItem("ajs_token");
    return { "Content-Type": "application/json", Authorization: "Bearer " + (t || "") };
  }

  async function adminFetch(path, options) {
    var clean = String(path || "").indexOf("/") === 0 ? String(path) : "/" + String(path);
    var proto = location.protocol;
    var host = location.hostname;
    var stored = (localStorage.getItem("bachat_api_base") || "").replace(/\/+$/, "");
    var ports = {};
    if (location.port) ports[location.port] = 1;
    ports["3000"] = 1;
    ports["3001"] = 1;
    var attempts = [];
    if (proto !== "file:") attempts.push(clean);
    if (stored) attempts.push(stored + clean);
    Object.keys(ports).forEach(function (p) {
      attempts.push(proto + "//" + host + ":" + p + clean);
    });
    var seen = {};
    var lastErr;
    var init = options || {};
    var headers = Object.assign({}, authHeaders(), init.headers || {});
    for (var i = 0; i < attempts.length; i++) {
      var url = attempts[i];
      if (seen[url]) continue;
      seen[url] = 1;
      try {
        var res = await fetch(url, Object.assign({}, init, { headers: headers }));
        if (res.ok && url.indexOf("http") === 0) {
          try {
            localStorage.setItem("bachat_api_base", new URL(url).origin);
          } catch (_) {}
        }
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Failed to fetch");
  }

  async function guardAdminPage() {
    var t = localStorage.getItem("ajs_token");
    if (!t) {
      location.href = "/team-login.html";
      return false;
    }
    var res = await adminFetch("/api/auth/me", { headers: authHeaders() });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok || !data.user || data.user.role !== "admin") {
      location.href = "/team-login.html";
      return false;
    }
    return true;
  }

  global.BachatAdminRuntime = { adminFetch, authHeaders, guardAdminPage };
})(window);
