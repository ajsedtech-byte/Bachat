import { chromium } from "@playwright/test";

const base = (process.env.QA_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const authRequired = process.env.QA_AUTH_REQUIRED === "1";
const pages = [
  "/UserDashboard.html",
  "/ShopkeeperDashboard.html",
  "/admin-sales.html",
  "/admin-delivery.html",
  "/admin-notifications.html",
  "/admin-city-ops.html",
  "/admin-finance.html",
];
const rolePages = {
  buyer: ["/UserDashboard.html#shopping-home", "/UserDashboard.html#orders-section"],
  seller: ["/ShopkeeperDashboard.html"],
  sales: ["/admin-sales.html"],
  admin: ["/admin-delivery.html", "/admin-notifications.html", "/admin-city-ops.html", "/admin-finance.html"],
  delivery: ["/DeliveryDashboard.html"],
};
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

function fail(message) {
  throw new Error(message);
}

function envName(role, suffix) {
  return `QA_${role.toUpperCase()}_${suffix}`;
}

function roleCreds(role) {
  const email = process.env[envName(role, "EMAIL")];
  const password = process.env[envName(role, "PASSWORD")] || process.env.QA_COMMON_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

async function loginRole(role) {
  const creds = roleCreds(role);
  if (!creds) {
    if (authRequired) fail(`missing ${role} QA credentials`);
    console.log(`skip auth ${role}: credentials not set`);
    return null;
  }
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`auth ${role}: ${data.error || res.statusText}`);
  if (data.mfa_required) {
    if (authRequired) fail(`auth ${role}: MFA credentials are not supported by browser QA`);
    console.log(`skip auth ${role}: MFA required`);
    return null;
  }
  if (!data.token || !data.user) fail(`auth ${role}: missing token/user response`);
  if (data.user.role !== role) fail(`auth ${role}: expected ${role}, got ${data.user.role}`);
  return {
    token: data.token,
    user: data.user,
    seller: data.seller || null,
  };
}

async function installSession(context, session) {
  await context.addInitScript((s) => {
    localStorage.setItem("ajs_token", s.token);
    localStorage.setItem("ajs_user", JSON.stringify(s.user || null));
    if (s.seller) localStorage.setItem("ajs_seller", JSON.stringify(s.seller));
    else localStorage.removeItem("ajs_seller");
  }, session);
}

async function checkPage(page, viewportName, path, options = {}) {
  const url = base + path;
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(options.waitMs || 500);
  if (errors.length) fail(`${viewportName} ${path}: page errors: ${errors.join("; ")}`);
  const metrics = await page.evaluate(() => {
    const visible = [...document.querySelectorAll("body *")].filter((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
    });
    const tiny = visible
      .filter((el) => {
        const txt = (el.textContent || "").trim();
        if (!txt) return false;
        return parseFloat(getComputedStyle(el).fontSize) < 12;
      })
      .slice(0, 8)
      .map((el) => ({ text: (el.textContent || "").trim().slice(0, 60), font: getComputedStyle(el).fontSize }));
    return {
      title: document.title,
      bodyText: document.body.innerText.trim().length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      tiny,
    };
  });
  if (!metrics.bodyText) fail(`${viewportName} ${path}: body is blank`);
  if (metrics.tiny.length) fail(`${viewportName} ${path}: unreadably small text ${JSON.stringify(metrics.tiny)}`);
  if (metrics.scrollWidth > metrics.clientWidth + 24) {
    fail(`${viewportName} ${path}: horizontal overflow ${metrics.scrollWidth} > ${metrics.clientWidth}`);
  }
  console.log(`ok ${viewportName} ${path} (${metrics.title})`);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    for (const path of pages) {
      await checkPage(page, viewport.name, path);
    }
    await context.close();
  }

  for (const [role, paths] of Object.entries(rolePages)) {
    const session = await loginRole(role);
    if (!session) continue;
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport });
      await installSession(context, session);
      const page = await context.newPage();
      for (const path of paths) {
        await checkPage(page, `${viewport.name} auth:${role}`, path, { waitMs: 800 });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
