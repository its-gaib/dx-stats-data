#!/usr/bin/env npx tsx
/**
 * Builds the Pages artifact: reads data/metrics.yaml, emits dist/metrics.json
 * and copies site/index.html.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
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

copyFileSync(path.join(SITE_DIR, "index.html"), path.join(DIST_DIR, "index.html"));

console.log(`Wrote ${snapshots.length} snapshots to dist/metrics.json`);
