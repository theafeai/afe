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
    data: { token: process.env.AFE_ADMIN_TOKEN },
    maxRedirects: 0,
  });
  if (!login.ok()) throw new Error(`Afe browser login failed: ${login.status()}`);
  const page = await context.newPage();
  video = page.video();
  for (const run of report.runs) {
    for (const event of run.events) {
      await page.goto(`${base}/events/${encodeURIComponent(event.id)}`);
      await page.getByRole("heading", { name: event.action, exact: true }).waitFor();
      await page.screenshot({
        path: path.join(output, `version-${run.version}-${event.action}.png`),
        fullPage: true,
      });
      await page.waitForTimeout(2000);
    }
  }
  await page.goto(`${base}/connections/${encodeURIComponent(process.env.AFE_CONNECTION_ID)}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.screenshot({ path: path.join(output, "afe-connection.png"), fullPage: true });
  await page.waitForTimeout(2000);
} finally {
  await context.close();
  if (video)
    await rename(await video.path(), path.join(output, "recordings", "github-events.webm"));
  await browser.close();
}
