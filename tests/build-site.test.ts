import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { dump, load } from "js-yaml";
import { snapshot } from "./fixtures/snapshot";

const ROOT = process.cwd();
const TSX = createRequire(path.join(ROOT, "package.json")).resolve("tsx");
const TEST_ENV = {
  ...process.env,
  TZ: "Pacific/Honolulu",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: "Metrics CI Test",
  GIT_AUTHOR_EMAIL: "metrics-ci@example.invalid",
  GIT_COMMITTER_NAME: "Metrics CI Test",
  GIT_COMMITTER_EMAIL: "metrics-ci@example.invalid",
};

function fixture(t: TestContext, source = dump([snapshot()])): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dx-stats-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "data"));
  mkdirSync(path.join(dir, "site"));
  writeFileSync(path.join(dir, "data", "metrics.yaml"), source);
  copyFileSync(path.join(ROOT, "site", "index.html"), path.join(dir, "site", "index.html"));
  return dir;
}

function git(dir: string, args: string[], date = "2026-01-01T00:00:00+00:00"): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: { ...TEST_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: "pipe",
  });
}

function run(dir: string, script = "build-site.ts") {
  const result = spawnSync(process.execPath, ["--import", TSX, path.join(ROOT, "scripts", script)], {
    cwd: dir,
    env: TEST_ENV,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

test("build preserves the full committed history and uses the collector commit's UTC timestamp", (t) => {
  const source = readFileSync(path.join(ROOT, "data", "metrics.yaml"), "utf8");
  const dir = fixture(t, source);
  git(dir, ["init", "--quiet"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "chore: collect dx metrics (2026-05-01)"], "2026-05-01T18:47:59-07:00");

  // A newer human edit must not change the advertised collection time.
  writeFileSync(path.join(dir, "data", "metrics.yaml"), `${source}\n# Manual formatting update.\n`);
  git(dir, ["add", "data/metrics.yaml"]);
  git(dir, ["commit", "--quiet", "-m", "docs: clarify metric history"], "2026-05-03T12:00:00+00:00");

  // The collector message only counts when the commit touched the history.
  writeFileSync(path.join(dir, "README.md"), "Unrelated update\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "--quiet", "-m", "chore: collect dx metrics documentation"], "2026-05-04T12:00:00+00:00");

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(readFileSync(path.join(dir, "dist", "metrics.json"), "utf8"));
  assert.deepEqual(json, load(source));
  assert.ok(Array.isArray(json));
  const html = readFileSync(path.join(dir, "dist", "index.html"), "utf8");
  assert.doesNotMatch(html, /\{\{[^}]+\}\}/);
  assert.match(html, /<a\b[^>]*href="\.\/metrics\.json"[^>]*>/);
  assert.match(html, /<time\b[^>]*datetime="2026-05-02T01:47:59\.000Z">2026-05-02 01:47 UTC<\/time>/);
  assert.match(result.stdout, new RegExp(`Wrote ${json.length} snapshots`));
});

test("build falls back to its current time when no collector commit exists", (t) => {
  const dir = fixture(t);
  git(dir, ["init", "--quiet"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "Initial manual import"]);
  const before = Date.now();
  const result = run(dir);
  const after = Date.now();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /falling back to now/);
  const html = readFileSync(path.join(dir, "dist", "index.html"), "utf8");
  const iso = html.match(/<time\b[^>]*datetime="([^"]+)"/)?.[1];
  assert.ok(iso);
  const timestamp = Date.parse(iso);
  assert.ok(timestamp >= before && timestamp <= after, `fallback ${iso} must be within the build`);
  assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/time>/);
});

test("build and validation CLI reject malformed or empty history before writing artifacts", (t) => {
  const invalidSnapshot = snapshot();
  invalidSnapshot.github.repos.example.stars = -1;
  for (const source of [
    "", "# No snapshots yet.\n", "not: a history\n", "[]\n", "[unterminated\n", dump([invalidSnapshot]),
  ]) {
    const dir = fixture(t, source);
    for (const script of ["build-site.ts", "validate-data.ts"]) {
      const result = run(dir, script);
      assert.equal(result.status, 1, `${script}: ${result.stderr}`);
      assert.ok(result.stderr.trim(), "validation should explain why it failed");
      assert.equal(existsSync(path.join(dir, "dist")), false);
      assert.equal(readFileSync(path.join(dir, "data", "metrics.yaml"), "utf8"), source);
    }
  }
});

test("validation CLI accepts valid history without writing artifacts", (t) => {
  const dir = fixture(t);
  const result = run(dir, "validate-data.ts");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated 1 snapshots/);
  assert.equal(existsSync(path.join(dir, "dist")), false);
});
