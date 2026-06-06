import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "public", "assets");

const jobs = [
  ["bachat-indore-market-hero.png", "bachat-indore-market-hero-fast.webp", 1500, 0.72],
  ["bachat-chappan-night-hero.png", "bachat-chappan-night-hero-fast.webp", 1500, 0.72],
  ["bachat-actions-hero.png", "bachat-actions-hero-fast.webp", 1200, 0.74],
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const [input, output, maxWidth, quality] of jobs) {
  const inputPath = path.join(assets, input);
  const outputPath = path.join(assets, output);
  const bytes = await fs.readFile(inputPath);
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const webp = await page.evaluate(
    async ({ dataUrl, maxWidth, quality }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const width = Math.round(img.naturalWidth * scale);
      const height = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const url = canvas.toDataURL("image/webp", quality);
      return url.split(",", 2)[1];
    },
    { dataUrl, maxWidth, quality }
  );
  await fs.writeFile(outputPath, Buffer.from(webp, "base64"));
  const oldKb = Math.round(bytes.length / 1024);
  const nextKb = Math.round((await fs.stat(outputPath)).size / 1024);
  console.log(`${input} -> ${output}: ${oldKb}KB to ${nextKb}KB`);
}

await browser.close();
