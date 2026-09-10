import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump, load } from "js-yaml";
import { validateSnapshots } from "../scripts/metrics";
import { snapshot } from "./fixtures/snapshot";

test("the committed metrics history satisfies the shared schema", () => {
  const history: unknown = load(readFileSync("data/metrics.yaml", "utf8"));
  validateSnapshots(history);
  assert.ok(history.length > 0);
});

test("allows fresh history, gaps, historical optional dependents and changing metric names", () => {
  validateSnapshots([]);
  const first = snapshot("2024-02-29");
  delete first.dependents;
  const second = snapshot("2024-03-03");
  second.github.repos = { "new-repo": { stars: 0, forks: 2, open_issues: 0 } };
  second.npm = {};
  second.crates = { "new-crate": { recent: 0, total: 0 } };
  second.dependents = { "new-crate": { rust: 0, npm: 0 } };
  validateSnapshots([first, second]);
});

test("rejects non-array history and non-mapping snapshots", () => {
  for (const value of [null, undefined, {}, "history", 1]) {
    assert.throws(() => validateSnapshots(value), /must be an array/);
  }
  for (const value of [null, [], "snapshot", new Date()]) {
    assert.throws(() => validateSnapshots([value]), /snapshots\[0\] must be a mapping/);
  }
});

test("requires calendar-valid YYYY-MM-DD strings and rejects Date objects", () => {
  for (const date of [
    "2026-02-29", "2024-02-30", "2026-04-31", "2026-13-01", "2026-00-10",
    "2026-01-00", "2026-1-01", "26-01-01", "2026-01-01T00:00:00Z", "", null,
    new Date("2026-01-01"),
  ]) {
    assert.throws(() => validateSnapshots([{ ...snapshot(), date }]), /valid YYYY-MM-DD string/);
  }
});

test("accepts quoted and unquoted YAML dates as strings", () => {
  for (const date of ["2026-01-01", "'2026-01-01'", '"2026-01-01"']) {
    const source = dump([snapshot()]).replace(/date: [^\n]+/, `date: ${date}`);
    const parsed = load(source);
    validateSnapshots(parsed);
    assert.deepEqual(parsed, [snapshot()]);
  }
});

test("rejects duplicate and out-of-order dates", () => {
  for (const date of ["2026-01-02", "2026-01-01"]) {
    assert.throws(
      () => validateSnapshots([snapshot("2026-01-02"), snapshot(date)]),
      /snapshots\[1\]\.date must be strictly later/,
    );
  }
});

test("requires all structural mappings and validates each named metric entry", () => {
  for (const section of ["github", "npm", "crates", "manual"]) {
    for (const value of [undefined, null, [], "invalid"]) {
      assert.throws(() => validateSnapshots([{ ...snapshot(), [section]: value }]), /must be a mapping/);
    }
  }
  for (const section of ["npm", "crates", "dependents"]) {
    assert.throws(() => validateSnapshots([{ ...snapshot(), [section]: { bad: [] } }]), /must be a mapping/);
  }
  assert.throws(() => validateSnapshots([{ ...snapshot(), dependents: null }]), /dependents must be a mapping/);
  assert.throws(() => validateSnapshots([{ ...snapshot(), github: { org_followers: 0 } }]), /repos must be a mapping/);
  assert.throws(
    () => validateSnapshots([{ ...snapshot(), github: { org_followers: 0, repos: { bad: null } } }]),
    /must be a mapping/,
  );
});

test("requires nonnegative finite integer counts in every API field", () => {
  for (const field of [
    "github.org_followers",
    "github.repos.example.stars",
    "github.repos.example.forks",
    "github.repos.example.open_issues",
    "npm.@example/package.weekly",
    "crates.example.recent",
    "crates.example.total",
    "dependents.example.rust",
    "dependents.example.npm",
  ]) {
    for (const value of [undefined, null, -1, 0.5, NaN, Infinity, "1", true]) {
      const entry = snapshot();
      const segments = field.split(".");
      let target = entry as unknown as Record<string, unknown>;
      for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
      target[segments.at(-1)!] = value;
      assert.throws(() => validateSnapshots([entry]), /must be a nonnegative finite integer/, field);
    }
  }
});

test("requires all seven manual fields and permits null, zero and fractional values", () => {
  for (const field of Object.keys(snapshot().manual)) {
    for (const value of [null, 0, 1.5, 150]) {
      const entry = snapshot();
      Object.assign(entry.manual, { [field]: value });
      validateSnapshots([entry]);
    }
    for (const value of [undefined, -1, NaN, Infinity, "0", false]) {
      const entry = snapshot();
      Object.assign(entry.manual, { [field]: value });
      assert.throws(() => validateSnapshots([entry]), /must be null or a nonnegative finite number/, field);
    }
  }
});
