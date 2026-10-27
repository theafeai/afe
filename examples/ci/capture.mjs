import { chromium } from "playwright";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const output = process.env.AFE_EVIDENCE_DIR;
const stage = process.env.AFE_CAPTURE_STAGE;
await mkdir(path.join(output, "recordings"), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: path.join(output, "recordings"), size: { width: 1440, height: 1000 } },
});
let video;
try {
  const page = await context.newPage();
  video = page.video();
  const version = stage === "version-1" ? "1" : "2";
  const port = version === "1" ? 8090 : 8092;
  await page.goto(`http://127.0.0.1:${port}/`);
  await page
    .locator("#version")
    .filter({ hasText: `Version ${version}` })
    .waitFor();
  await page.screenshot({ path: path.join(output, `app-${stage}.png`), fullPage: true });
  await page.waitForTimeout(1500);
  const login = await context.request.post("http://127.0.0.1:8080/api/session", {
    data: { token: process.env.AFE_BROWSER_TOKEN },
  });
  if (!login.ok()) throw new Error(`Afe browser login failed: ${login.status()}`);
  await page.goto("http://127.0.0.1:8080/events?source=argocd");
  await page.getByText("argocd.sync.succeeded", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, `afe-events-${stage}.png`), fullPage: true });
  await page.waitForTimeout(1500);
  await page.goto(`http://127.0.0.1:8080/connections/${process.env.AFE_CONNECTION_ID}`);
  await page.getByRole("heading", { name: /Real ArgoCD CI demo/ }).waitFor();
  await page.screenshot({ path: path.join(output, `afe-connection-${stage}.png`), fullPage: true });
  await page.waitForTimeout(1500);
} finally {
  await context.close();
  if (video) await rename(await video.path(), path.join(output, "recordings", `${stage}.webm`));
  await browser.close();
}
