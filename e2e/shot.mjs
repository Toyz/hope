// Screenshot helper for hope's UI so design work can be verified, not guessed.
//   node shot.mjs <path> <out.png> [width] [height]
//   node shot.mjs /host/local shots/host.png
// Base URL + creds via env (defaults for local dev).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = process.env.HOPE_URL || "http://localhost:8080";
const USER = process.env.HOPE_USER || "helba";
const PASS = process.env.HOPE_PASS || "changeme";

const path = process.argv[2] || "/";
const out = process.argv[3] || "shots/shot.png";
const width = Number(process.argv[4] || 1600);
const height = Number(process.argv[5] || 1000);

mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });

try {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  // Log in unless a session already redirected us off /login.
  if (new URL(page.url()).pathname.startsWith("/login")) {
    await page.locator("input[type=text]").first().fill(USER);
    await page.locator("input[type=password]").first().fill(PASS);
    await page.locator("button[type=submit]").first().click();
    await page.waitForTimeout(1500);
  }
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600); // let the fleet/queries settle
  if (process.env.CLICK) {
    await page.locator(process.env.CLICK).first().click();
    await page.waitForTimeout(Number(process.env.CLICKWAIT || 700));
  }
  if (process.env.CLICK2) {
    await page.locator(process.env.CLICK2).first().click();
    await page.waitForTimeout(900);
  }
  // animations:disabled + a generous timeout so a live-streaming page (logs) still
  // yields a stable frame instead of the capture spinning.
  await page.screenshot({ path: out, animations: "disabled", timeout: 25000 });
  console.log("shot", path, "->", out, `(${width}x${height})`, "url:", new URL(page.url()).pathname);
} catch (e) {
  console.error("shot failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
