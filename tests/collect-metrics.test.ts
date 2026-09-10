import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dump, load } from "js-yaml";
import type { CrateDependents, ManualMetrics, MetricSnapshot } from "../scripts/metrics";

const COLLECTOR = path.resolve(__dirname, "../scripts/collect-metrics.ts");
const PRELOAD = path.resolve(__dirname, "helpers/collector-preload.mjs");
const TSX = require.resolve("tsx");
const TODAY = "2026-09-10";
const CHECKED_AT = `${TODAY}T00:30:00.000Z`;
const OBSERVED_AT = "2026-09-07T07:00:00.000Z";
const RUN_ID = "2026-09-07T06:00:00.000Z";
const TEST_TOKEN = "collector-test-token";
const DISCOVERY = "https://api.github.com/orgs/pubky/repos?per_page=100&sort=stars&page=1";
const PAGE_TWO = "https://api.github.com/orgs/pubky/repos?per_page=100&sort=stars&page=2";
const FOLLOWERS = "https://api.github.com/orgs/pubky";
const NPM = {
  "@synonymdev/pubky": "https://api.npmjs.org/downloads/point/last-week/%40synonymdev%2Fpubky",
  "@synonymdev/react-native-pubky": "https://api.npmjs.org/downloads/point/last-week/%40synonymdev%2Freact-native-pubky",
  "@synonymdev/pkarr": "https://api.npmjs.org/downloads/point/last-week/%40synonymdev%2Fpkarr",
  "@synonymdev/pubky-app-specs": "https://api.npmjs.org/downloads/point/last-week/%40synonymdev%2Fpubky-app-specs",
};
const CRATES = {
  pkarr: "https://crates.io/api/v1/crates/pkarr",
  pubky: "https://crates.io/api/v1/crates/pubky",
};
const DEPENDENTS = {
  pkarr: "https://its-gaib.github.io/pubky-dependents-analysis/pkarr.json",
  pubky: "https://its-gaib.github.io/pubky-dependents-analysis/pubky.json",
  "pubky-app-specs": "https://its-gaib.github.io/pubky-dependents-analysis/pubky-app-specs.json",
  mainline: "https://its-gaib.github.io/pubky-dependents-analysis/mainline.json",
};

interface MockResponse {
  body?: unknown;
  failure?: "http" | "network" | "json";
}

interface MockRequest {
  url: string;
  headers: Record<string, string>;
  hasSignal: boolean;
}

function emptyManual(): ManualMetrics {
  return {
    ttfhw_minutes: null,
    active_builders: null,
    community_projects: null,
    homeserver_nodes: null,
    docs_monthly_visitors: null,
    bounty_completion_rate: null,
    events_attended: null,
  };
}

function previousSnapshot(date = "2026-09-09"): MetricSnapshot {
  return {
    date,
    github: { org_followers: 1, repos: { old: { stars: 8, forks: 2, open_issues: 1 } } },
    npm: { "@synonymdev/pubky": { weekly: 10 } },
    crates: { pubky: { recent: 3, total: 20 } },
    manual: emptyManual(),
  };
}

function publication(crate: string, rust: number, npm = 0) {
  return {
    crate,
    updated_at: OBSERVED_AT,
    total: rust,
    summary: { independent: rust },
    lists: { independent: Array.from({ length: rust }, (_, index) => ({ repo: `example/repo-${index}` })) },
    npm_dependents: Array.from({ length: npm }, (_, index) => ({ name: `npm-${index}` })),
    collection: {
      status: "complete",
      run_id: RUN_ID,
      sources: {
        crates_io: rust,
        github_cargo_toml: rust,
        github_cargo_lock: rust,
        github_dependents: rust,
        ...(crate === "mainline" ? {} : { npm_registry: npm, github_package_json: 0 }),
      },
    },
  };
}

function expectedDependents(rust: number, npm: number): CrateDependents {
  return {
    rust,
    npm,
    source: { status: "current", observed_at: OBSERVED_AT, run_id: RUN_ID, checked_at: CHECKED_AT },
  };
}

function defaultResponses(): Record<string, MockResponse> {
  return {
    [DISCOVERY]: { body: [] },
    [FOLLOWERS]: { body: { followers: 19 } },
    [NPM["@synonymdev/pubky"]]: { body: { downloads: 101 } },
    [NPM["@synonymdev/react-native-pubky"]]: { body: { downloads: 202 } },
    [NPM["@synonymdev/pkarr"]]: { body: { downloads: 303 } },
    [NPM["@synonymdev/pubky-app-specs"]]: { body: { downloads: 404 } },
    [CRATES.pkarr]: { body: { crate: { recent_downloads: 51, downloads: 501 } } },
    [CRATES.pubky]: { body: { crate: { recent_downloads: 62, downloads: 602 } } },
    [DEPENDENTS.pkarr]: { body: publication("pkarr", 7, 2) },
    [DEPENDENTS.pubky]: { body: publication("pubky", 8, 1) },
    [DEPENDENTS["pubky-app-specs"]]: { body: publication("pubky-app-specs", 9) },
    [DEPENDENTS.mainline]: { body: publication("mainline", 10) },
  };
}

function runCollector(options: {
  history?: string;
  responses?: Record<string, MockResponse>;
  token?: string;
  now?: string;
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dx-stats-collector-"));
  const dataFile = path.join(directory, "data/metrics.yaml");
  const requestsFile = path.join(directory, "requests.jsonl");
  const configFile = path.join(directory, "mock-config.json");
  const responses = options.responses ?? defaultResponses();

  try {
    let beforeModified: bigint | undefined;
    if (options.history !== undefined) {
      mkdirSync(path.dirname(dataFile), { recursive: true });
      writeFileSync(dataFile, options.history);
      // A sentinel timestamp also detects rewriting identical bytes.
      utimesSync(dataFile, 1_000_000_000, 1_000_000_000);
      beforeModified = statSync(dataFile, { bigint: true }).mtimeNs;
    }
    writeFileSync(requestsFile, "");
    writeFileSync(configFile, JSON.stringify({
      now: options.now ?? CHECKED_AT,
      requestsFile,
      responses,
    }));

    const child = spawnSync(process.execPath, ["--import", TSX, "--import", PRELOAD, COLLECTOR], {
      cwd: directory,
      // Keep real credentials and NODE_OPTIONS out of the subprocess.
      env: {
        GITHUB_TOKEN: options.token ?? TEST_TOKEN,
        NODE_ENV: "test",
        TMPDIR: os.tmpdir(),
        TZ: "UTC",
        COLLECTOR_TEST_CONFIG: configFile,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(child.error);
    const requests: MockRequest[] = readFileSync(requestsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MockRequest);
    assert.deepEqual(
      requests.filter((request) => !Object.hasOwn(responses, request.url)),
      [],
      "the collector made an unexpected request",
    );
    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      requests,
      content: existsSync(dataFile) ? readFileSync(dataFile, "utf8") : undefined,
      beforeModified,
      afterModified: existsSync(dataFile) ? statSync(dataFile, { bigint: true }).mtimeNs : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function collected(result: ReturnType<typeof runCollector>): MetricSnapshot[] {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.content, "collector should create data/metrics.yaml");
  return load(result.content) as MetricSnapshot[];
}

test("collects configured metrics, paginates repositories, and applies the five-star threshold", () => {
  const responses = defaultResponses();
  responses[DISCOVERY] = {
    body: [
      { name: "popular", stargazers_count: 40 },
      { name: "threshold", stargazers_count: 5 },
      ...Array.from({ length: 98 }, (_, index) => ({ name: `below-${index}`, stargazers_count: 4 })),
    ],
  };
  responses[PAGE_TWO] = {
    body: [
      { name: "page-two", stargazers_count: 6 },
      { name: "too-small", stargazers_count: 4 },
    ],
  };
  responses["https://api.github.com/repos/pubky/popular"] = {
    body: { stargazers_count: 41, forks_count: 11, open_issues_count: 3 },
  };
  responses["https://api.github.com/repos/pubky/threshold"] = {
    body: { stargazers_count: 5, forks_count: 1, open_issues_count: 0 },
  };
  responses["https://api.github.com/repos/pubky/page-two"] = {
    body: { stargazers_count: 7, forks_count: 2, open_issues_count: 1 },
  };

  const result = runCollector({ responses });
  assert.deepEqual(collected(result), [{
    date: TODAY,
    github: {
      org_followers: 19,
      repos: {
        popular: { stars: 41, forks: 11, open_issues: 3 },
        threshold: { stars: 5, forks: 1, open_issues: 0 },
        "page-two": { stars: 7, forks: 2, open_issues: 1 },
      },
    },
    npm: {
      "@synonymdev/pubky": { weekly: 101 },
      "@synonymdev/react-native-pubky": { weekly: 202 },
      "@synonymdev/pkarr": { weekly: 303 },
      "@synonymdev/pubky-app-specs": { weekly: 404 },
    },
    crates: {
      pkarr: { recent: 51, total: 501 },
      pubky: { recent: 62, total: 602 },
    },
    dependents: {
      pkarr: expectedDependents(7, 2),
      pubky: expectedDependents(8, 1),
      "pubky-app-specs": expectedDependents(9, 0),
      mainline: expectedDependents(10, 0),
    },
    manual: emptyManual(),
  }]);
  assert.deepEqual(result.requests.map(({ url }) => url), [
    DISCOVERY,
    PAGE_TWO,
    "https://api.github.com/repos/pubky/popular",
    "https://api.github.com/repos/pubky/threshold",
    "https://api.github.com/repos/pubky/page-two",
    FOLLOWERS,
    ...Object.values(NPM),
    ...Object.values(CRATES),
    ...Object.values(DEPENDENTS),
  ]);
  for (const { url, headers, hasSignal } of result.requests) {
    if (new URL(url).hostname === "api.github.com") {
      assert.equal(headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(headers.accept, "application/vnd.github.v3+json");
      assert.equal(headers["user-agent"], "dx-stats-collector");
    } else {
      assert.equal(headers.authorization, undefined, `${url} must not receive the GitHub token`);
    }
    if (new URL(url).hostname === "crates.io") {
      assert.equal(headers["user-agent"], "dx-stats-collector (github.com/pubky/dx-stats)");
    }
    if (new URL(url).hostname === "its-gaib.github.io") {
      assert.equal(hasSignal, true, "dependents requests must have a timeout signal");
    }
  }
});

test("appends history and preserves the latest manual values, including zero and null", () => {
  const oldest = previousSnapshot("2026-09-08");
  oldest.manual.active_builders = 99;
  const latest = previousSnapshot();
  latest.manual = {
    ttfhw_minutes: 0,
    active_builders: 7,
    community_projects: 0,
    homeserver_nodes: 3,
    docs_monthly_visitors: 0,
    bounty_completion_rate: 0.75,
    events_attended: null,
  };
  const result = runCollector({ history: dump([oldest, latest]) });
  const snapshots = collected(result);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.slice(0, 2), [oldest, latest]);
  assert.equal(snapshots[2].date, TODAY);
  assert.deepEqual(snapshots[2].manual, latest.manual);
});

test("refreshes dependents on the same day while preserving unrelated metrics and manual edits", () => {
  const earlier = previousSnapshot();
  const today = previousSnapshot(TODAY);
  today.manual.active_builders = 42;
  const result = runCollector({ history: dump([earlier, today]) });
  const snapshots = collected(result);
  assert.match(result.stdout, /Refreshing dependents/);
  assert.deepEqual(result.requests.map(({ url }) => url), Object.values(DEPENDENTS));
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], earlier);
  const { dependents, ...rest } = snapshots[1];
  assert.deepEqual(rest, today);
  assert.deepEqual(dependents?.pkarr, expectedDependents(7, 2));
});

test("supports requests without a GitHub token", () => {
  const result = runCollector({ token: "" });
  assert.equal(collected(result).length, 1);
  assert.ok(result.requests.some(({ url }) => new URL(url).hostname === "api.github.com"));
  for (const request of result.requests) {
    assert.equal(request.headers.authorization, undefined);
  }
});

test("reports unavailable dependents without inventing zero on HTTP, network, and JSON failures", async (t) => {
  for (const failure of ["http", "network", "json"] as const) {
    await t.test(failure, () => {
      const responses = Object.fromEntries(
        Object.keys(defaultResponses()).map((url) => [url, { failure } as MockResponse]),
      );
      responses[DISCOVERY] = { body: [{ name: "unavailable", stargazers_count: 5 }] };
      responses["https://api.github.com/repos/pubky/unavailable"] = { failure };
      const result = runCollector({ responses });
      const [snapshot] = collected(result);
      assert.deepEqual(snapshot, {
        date: TODAY,
        github: {
          org_followers: 0,
          repos: { unavailable: { stars: 0, forks: 0, open_issues: 0 } },
        },
        npm: Object.fromEntries(Object.keys(NPM).map((name) => [name, { weekly: 0 }])),
        crates: Object.fromEntries(Object.keys(CRATES).map((name) => [name, { recent: 0, total: 0 }])),
        dependents: Object.fromEntries(Object.keys(DEPENDENTS).map((name) => [name, {
          rust: null,
          npm: null,
          source: {
            status: "unavailable", observed_at: null, run_id: null, checked_at: CHECKED_AT,
            reason: failure === "json" ? "invalid_source" : "fetch_failed",
          },
        }])),
        manual: emptyManual(),
      });
      assert.match(result.stderr, /\[fetch\]/);
    });
  }
});

test("continues collecting other services if repository discovery fails", () => {
  const responses = defaultResponses();
  responses[DISCOVERY] = { failure: "http" };
  const result = runCollector({ responses });
  const [snapshot] = collected(result);
  assert.deepEqual(snapshot.github, { org_followers: 19, repos: {} });
  assert.equal(snapshot.npm["@synonymdev/pubky"].weekly, 101);
  assert.equal(snapshot.crates.pkarr.total, 501);
  assert.equal(snapshot.dependents?.mainline.rust, 10);
});

test("rejects invalid existing history before requests and preserves the original file", async (t) => {
  for (const [name, history] of Object.entries({
    "empty YAML": "",
    "comment-only YAML": "# No snapshots yet.\n",
    "mapping root": "snapshots: []\n",
    "null root": "null\n",
    "malformed snapshot": dump([{ date: "2026-09-09" }]),
    "invalid YAML": "[unterminated\n",
  })) {
    await t.test(name, () => {
      const result = runCollector({ history, responses: {} });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Collection failed:/);
      assert.deepEqual(result.requests, []);
      assert.equal(result.content, history);
      assert.equal(result.afterModified, result.beforeModified);
    });
  }
});

test("rejects a malformed API metric before overwriting valid history", () => {
  const history = dump([previousSnapshot()]);
  const responses = defaultResponses();
  responses[NPM["@synonymdev/pubky"]] = { body: { downloads: "unexpected value" } };
  const result = runCollector({ history, responses });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Collection failed:/);
  assert.ok(result.requests.length > 0);
  assert.equal(result.content, history);
  assert.equal(result.afterModified, result.beforeModified);
});

test("accepts verified zero counts and distinguishes them from missing observations", () => {
  const responses = defaultResponses();
  for (const [crate, url] of Object.entries(DEPENDENTS)) {
    responses[url] = { body: { ...publication(crate, 0), summary: {}, lists: {} } };
  }
  const [snapshot] = collected(runCollector({ responses }));
  for (const entry of Object.values(snapshot.dependents!)) {
    assert.deepEqual(entry, expectedDependents(0, 0));
  }
});

test("rejects incomplete or malformed publications as a whole batch", async (t) => {
  type Payload = ReturnType<typeof publication>;
  const cases: Array<[string, (payload: Payload) => void, string]> = [
    ["wrong crate", (p) => { p.crate = "another-crate"; }, "invalid_source"],
    ["partial collection", (p) => { p.collection.status = "partial"; }, "incomplete_source"],
    ["missing completeness", (p) => { Reflect.deleteProperty(p, "collection"); }, "unverified_source"],
    ["negative total", (p) => { p.total = -1; }, "invalid_source"],
    ["unsafe total", (p) => { p.total = Number.MAX_SAFE_INTEGER + 1; }, "invalid_source"],
    ["summary mismatch", (p) => { p.summary.independent += 1; }, "invalid_source"],
    ["empty repository", (p) => { p.lists.independent[0].repo = ""; }, "invalid_source"],
    ["extra list", (p) => { Object.assign(p.lists, { unknown: [] }); }, "invalid_source"],
    ["missing source", (p) => { Reflect.deleteProperty(p.collection.sources, "github_cargo_lock"); }, "invalid_source"],
    ["invalid source count", (p) => { p.collection.sources.github_dependents = -1; }, "invalid_source"],
    ["invalid npm list", (p) => { Object.assign(p, { npm_dependents: {} }); }, "invalid_source"],
    ["missing nonempty npm list", (p) => { Reflect.deleteProperty(p, "npm_dependents"); }, "invalid_source"],
    ["npm source/list mismatch", (p) => { p.collection.sources.npm_registry = 8; }, "invalid_source"],
    ["impossible observation date", (p) => { p.updated_at = "2026-02-30T12:00:00Z"; }, "invalid_source"],
    ["invalid run ID", (p) => { p.collection.run_id = "not-a-date"; }, "invalid_source"],
    ["future observation", (p) => { p.updated_at = "2026-09-10T00:36:00Z"; }, "invalid_source"],
    ["run after observation", (p) => { p.collection.run_id = "2026-09-08T06:00:00Z"; }, "invalid_source"],
    ["mixed publication", (p) => { p.collection.run_id = "2026-09-07T06:01:00Z"; }, "mixed_runs"],
  ];
  for (const [name, mutate, reason] of cases) {
    await t.test(name, () => {
      const responses = defaultResponses();
      mutate(responses[DEPENDENTS.pkarr].body as Payload);
      const [snapshot] = collected(runCollector({ responses }));
      for (const value of Object.values(snapshot.dependents!)) {
        assert.equal(value.rust, null, "no crate from a partially validated batch may be adopted");
        assert.equal(value.npm, null);
        assert.equal(value.source?.status, "unavailable");
        assert.equal(value.source?.reason, reason);
      }
    });
  }
});

test("requires explicit empty npm arrays for configured npm crates", () => {
  const responses = defaultResponses();
  Reflect.deleteProperty(responses[DEPENDENTS["pubky-app-specs"]].body as object, "npm_dependents");
  const [snapshot] = collected(runCollector({ responses }));
  assert.equal(snapshot.dependents?.pkarr.rust, null);
  assert.equal(snapshot.dependents?.pkarr.source?.reason, "invalid_source");
});

test("preserves archived legacy counts as unverified without borrowing a new payload's timestamp", () => {
  const previous = previousSnapshot();
  previous.dependents = { pkarr: { rust: 123, npm: 45 } };
  const responses = defaultResponses();
  for (const url of Object.values(DEPENDENTS)) {
    Reflect.deleteProperty(responses[url].body as object, "collection");
  }
  const snapshots = collected(runCollector({ history: dump([previous]), responses }));
  assert.deepEqual(snapshots[0], previous);
  assert.deepEqual(snapshots[1].dependents?.pkarr, {
    rust: 123,
    npm: 45,
    source: {
      status: "unverified", observed_at: null, run_id: null,
      checked_at: CHECKED_AT, reason: "unverified_source",
    },
  });
  assert.equal(snapshots[1].dependents?.pubky.rust, null);
});

test("fallback searches for the last verified observation before considering newer legacy counts", () => {
  const verified = previousSnapshot("2026-09-08");
  verified.dependents = { pkarr: expectedDependents(77, 5) };
  const legacy = previousSnapshot();
  legacy.dependents = { pkarr: { rust: 2, npm: 0 } };
  const responses = defaultResponses();
  responses[DEPENDENTS.pubky] = { failure: "http" };
  const snapshots = collected(runCollector({ history: dump([verified, legacy]), responses }));
  assert.deepEqual(snapshots.slice(0, 2), [verified, legacy]);
  assert.deepEqual(snapshots[2].dependents?.pkarr, {
    ...expectedDependents(77, 5),
    source: { ...expectedDependents(77, 5).source!, status: "stale", reason: "fetch_failed" },
  });
});

test("a failed same-day refresh preserves counts and a later verified publication corrects today's row", () => {
  const initial = collected(runCollector());
  initial[0].manual.active_builders = 42;
  const responses = defaultResponses();
  responses[DEPENDENTS.pkarr] = { failure: "network" };
  const failed = runCollector({ history: dump(initial), responses, now: `${TODAY}T12:00:00.000Z` });
  const retained = collected(failed);
  assert.equal(retained.length, 1);
  for (const [crate, value] of Object.entries(retained[0].dependents!)) {
    assert.equal(value.rust, initial[0].dependents![crate].rust);
    assert.equal(value.npm, initial[0].dependents![crate].npm);
    assert.equal(value.source?.status, "stale");
    assert.equal(value.source?.observed_at, OBSERVED_AT);
    assert.equal(value.source?.run_id, RUN_ID);
    assert.equal(value.source?.checked_at, `${TODAY}T12:00:00.000Z`);
  }
  const recoveredResponses = defaultResponses();
  for (const [crate, url] of Object.entries(DEPENDENTS)) {
    const payload = publication(crate, 70, crate === "mainline" ? 0 : 3);
    payload.updated_at = `${TODAY}T13:00:00.000Z`;
    payload.collection.run_id = `${TODAY}T12:45:00.000Z`;
    recoveredResponses[url] = { body: payload };
  }
  const recovered = runCollector({
    history: failed.content!, responses: recoveredResponses, now: `${TODAY}T14:00:00.000Z`,
  });
  const snapshots = collected(recovered);
  assert.equal(snapshots.length, 1);
  const { dependents, ...rest } = snapshots[0];
  const { dependents: _initialDependents, ...initialRest } = initial[0];
  assert.deepEqual(rest, initialRest);
  assert.deepEqual(dependents?.pkarr, {
    rust: 70, npm: 3,
    source: {
      status: "current", observed_at: `${TODAY}T13:00:00.000Z`,
      run_id: `${TODAY}T12:45:00.000Z`, checked_at: `${TODAY}T14:00:00.000Z`,
    },
  });
  assert.deepEqual(recovered.requests.map(({ url }) => url), Object.values(DEPENDENTS));
});

test("marks an unchanged successful observation stale after the eight-day freshness window", () => {
  const fresh = collected(runCollector({ now: "2026-09-15T07:00:00.000Z" }));
  assert.equal(fresh[0].dependents?.pkarr.source?.status, "current");
  const stale = collected(runCollector({ now: "2026-09-15T07:00:00.001Z" }));
  assert.equal(stale[0].dependents?.pkarr.source?.status, "stale");
  assert.equal(stale[0].dependents?.pkarr.source?.reason, "source_too_old");
  assert.equal(stale[0].dependents?.pkarr.source?.observed_at, OBSERVED_AT);
});

test("rejects a complete but older cached publication without moving observation time backward", () => {
  const previous = previousSnapshot();
  previous.dependents = { pkarr: expectedDependents(77, 5) };
  const responses = defaultResponses();
  for (const [crate, url] of Object.entries(DEPENDENTS)) {
    const payload = publication(crate, 1);
    payload.updated_at = "2026-08-31T07:00:00.000Z";
    payload.collection.run_id = "2026-08-31T06:00:00.000Z";
    responses[url] = { body: payload };
  }
  const snapshots = collected(runCollector({ history: dump([previous]), responses }));
  assert.equal(snapshots[1].dependents?.pkarr.rust, 77);
  assert.equal(snapshots[1].dependents?.pkarr.source?.observed_at, OBSERVED_AT);
  assert.equal(snapshots[1].dependents?.pkarr.source?.reason, "source_regressed");
  assert.equal(snapshots[1].dependents?.pubky.source?.status, "unavailable");
});
