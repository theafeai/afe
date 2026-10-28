import { chromium } from "playwright";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const output = process.env.AFE_EVIDENCE_DIR;
const base = process.env.AFE_DEMO_URL;
const report = JSON.parse(await readFile(path.join(output, "results.json"), "utf8"));
await mkdir(path.join(output, "recordings"), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: path.join(output, "recordings"), size: { width: 1440, height: 1000 } },
});
let video;
try {
  const login = await context.request.post(`${base}/api/session`, {
    data: { token: process.env.AFE_BROWSER_TOKEN },
    maxRedirects: 0,
  });
  if (!login.ok()) throw new Error(`Afe login failed: ${login.status()}`);
  const page = await context.newPage();
  video = page.video();
  for (const [index, event] of report.reports.entries()) {
    await page.goto(`${base}/events/${event.eventId}`);
    await page
      .getByRole("heading", { name: `terraform.${event.operation}.completed`, exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(output, `${index + 1}-${event.operation}-${event.outcome}.png`),
      fullPage: true,
    });
    await page.waitForTimeout(1500);
  }
  await page.goto(`${base}/connections/${process.env.AFE_CONNECTION_ID}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.screenshot({ path: path.join(output, "connection.png"), fullPage: true });
  await page.waitForTimeout(1500);
} finally {
  await context.close();
  if (video)
    await rename(await video.path(), path.join(output, "recordings", "terraform-events.webm"));
  await browser.close();
}
