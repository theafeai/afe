/**
 * Regenerates the data embedded in the AFE-15 prototypes from the synthetic
 * dataset and the correlation prototype:
 *
 *   pnpm exec tsx docs/research/prototypes/generate.ts
 *
 * Each prototype HTML file holds its data in
 * <script id="afe-data" type="application/json">...</script>; this script
 * replaces that block in place, so the HTML files stay self-contained.
 * To try real data, replace `loadSyntheticEvents()` with events exported
 * from Afe (same fields) and re-run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJourneys,
  buildLinks,
  deriveEnvironmentStates,
} from "../../../packages/core/src/correlation/index.ts";
import { C, loadSyntheticEvents } from "./synthetic-dataset.ts";

const here = dirname(fileURLToPath(import.meta.url));
const events = loadSyntheticEvents();
const { links, conflicts } = buildLinks(events);
const environments = deriveEnvironmentStates(events, links);
const journeys = buildJourneys(events, links, environments);

// Short labels for commits so the prototypes read like the doc ("A", "M1"...).
const commitLabels = Object.fromEntries(
  Object.entries(C).map(([label, sha]) => [sha, `${label} ${sha.slice(0, 7)}`]),
);

const payload = {
  synthetic: true,
  note: "SYNTHETIC data (AFE-15). Not recorded from real systems.",
  events,
  links,
  conflicts,
  environments,
  journeys,
  commitLabels,
};
// Escape "<" so the JSON cannot close the script element.
const json = JSON.stringify(payload).replace(/</g, "\\u003c");

for (const file of ["timeline.html", "journey.html", "environments.html"]) {
  const path = join(here, file);
  const html = readFileSync(path, "utf8");
  const re = /(<script id="afe-data" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (!re.test(html)) throw new Error(`${file}: no afe-data block`);
  writeFileSync(
    path,
    html.replace(re, (_m, open: string, close: string) => `${open}${json}${close}`),
  );
  console.warn(`updated ${file}`);
}
