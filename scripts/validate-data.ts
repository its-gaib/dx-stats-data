#!/usr/bin/env npx tsx
/** Validate the committed history without collecting metrics or writing files. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { validateSnapshots } from "./metrics";

const snapshots: unknown = load(
  readFileSync(path.join(process.cwd(), "data", "metrics.yaml"), "utf8"),
);
validateSnapshots(snapshots);
if (snapshots.length === 0) throw new Error("metrics.yaml must contain at least one snapshot");

console.log(`Validated ${snapshots.length} snapshots in data/metrics.yaml`);
