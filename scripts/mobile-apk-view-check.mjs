import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const base = (process.env.QA_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const outDir = path.join(process.cwd(), "tmp", "mobile-apk-view");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ...devices["Pixel 5"],
  viewport: { width: 393, height: 873 },
  deviceScaleFactor: 2.75,
  isMobile: true,
  hasTouch: true,
});

const apiBase = (process.env.QA_API_BASE_URL || process.env.MOBILE_API_BASE_URL || "").replace(/\/+$/, "");
if (apiBase) {
  await context.addInitScript((baseUrl) => {
    window.__BACHAT_API_BASE__ = baseUrl;
    localStorage.setItem("bachat_api_base", baseUrl);
  }, apiBase);
}

const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));
page.on("console", (msg) => {
  if (["error", "warning"].includes(msg.type())) consoleErrors.push(`${msg.type()}: ${msg.text()}`);
});

await page.goto(`${base}/UserDashboard.html#shopping-home`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1200);

const checkpoints = [
  { name: "01-top", y: 0 },
  { name: "02-hero", y: 360 },
  { name: "03-panels", y: 1450 },
  { name: "04-footer", y: 2600 },
];

for (const point of checkpoints) {
  await page.evaluate((y) => window.scrollTo(0, y), point.y);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `${point.name}.png`), fullPage: false });
}

const report = await page.evaluate(() => {
  const viewport = document.documentElement.clientWidth;
  const overflow = [...document.querySelectorAll("body *")]
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 90),
        text: String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        display: style.display,
      };
    })
    .filter((x) => x.width > 0 && (x.right > viewport + 2 || x.left < -2))
    .slice(0, 20);

  return {
    title: document.title,
    viewport,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    bodyText: document.body.innerText.slice(0, 180),
    overflow,
  };
});

console.log(JSON.stringify({ base, apiBase, outDir, pageErrors, consoleErrors, report }, null, 2));

await context.close();
await browser.close();
