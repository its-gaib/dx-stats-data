#!/usr/bin/env npx tsx
/**
 * Builds the Pages artifact: reads data/metrics.yaml, emits dist/metrics.json
 * and renders site/index.html with the last collection timestamp injected.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";

const ROOT = process.cwd();
const SRC_YAML = path.join(ROOT, "data", "metrics.yaml");
const SITE_DIR = path.join(ROOT, "site");
const DIST_DIR = path.join(ROOT, "dist");

mkdirSync(DIST_DIR, { recursive: true });

const yamlText = readFileSync(SRC_YAML, "utf8");
const snapshots = yaml.load(yamlText);
if (!Array.isArray(snapshots)) {
  throw new Error("metrics.yaml is not an array");
}

writeFileSync(path.join(DIST_DIR, "metrics.json"), JSON.stringify(snapshots), "utf8");

// Derive "last collection" from the most recent commit whose message marks a
// collector run. Filtering by `--grep` avoids attributing manual YAML edits
// (e.g. schema cleanups) to the collector. Requires fetch-depth: 0 in CI.
const COLLECTOR_COMMIT_PREFIX = "^chore: collect dx metrics";
let lastCollectedIso: string;
try {
  lastCollectedIso = execFileSync(
    "git",
    [
      "log",
      "-1",
      "--format=%cI",
      `--grep=${COLLECTOR_COMMIT_PREFIX}`,
      "--",
      "data/metrics.yaml",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!lastCollectedIso) throw new Error("no collector commit found yet");
} catch (err) {
  console.warn("Could not derive last-collection timestamp; falling back to now.", err);
  lastCollectedIso = new Date().toISOString();
}

const d = new Date(lastCollectedIso);
const display =
  d.getUTCFullYear() +
  "-" +
  String(d.getUTCMonth() + 1).padStart(2, "0") +
  "-" +
  String(d.getUTCDate()).padStart(2, "0") +
  " " +
  String(d.getUTCHours()).padStart(2, "0") +
  ":" +
  String(d.getUTCMinutes()).padStart(2, "0") +
  " UTC";

const html = readFileSync(path.join(SITE_DIR, "index.html"), "utf8")
  .replace("{{LAST_COLLECTED_ISO}}", d.toISOString())
  .replace("{{LAST_COLLECTED_DISPLAY}}", display);

writeFileSync(path.join(DIST_DIR, "index.html"), html, "utf8");

console.log(`Wrote ${snapshots.length} snapshots to dist/metrics.json`);
console.log(`Last collection: ${display}`);
