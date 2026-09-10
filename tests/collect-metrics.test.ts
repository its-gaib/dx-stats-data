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
import yaml from "js-yaml";
import type { ManualMetrics, MetricSnapshot } from "../scripts/metrics";

const COLLECTOR = path.resolve(__dirname, "../scripts/collect-metrics.ts");
const PRELOAD = path.resolve(__dirname, "helpers/collector-preload.mjs");
const TSX = require.resolve("tsx");
const TODAY = "2026-09-10";
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
    [DEPENDENTS.pkarr]: { body: { total: 7, npm_dependents: ["one", "two"] } },
    [DEPENDENTS.pubky]: { body: { total: 8, npm_dependents: ["one"] } },
    [DEPENDENTS["pubky-app-specs"]]: { body: { total: 9 } },
    [DEPENDENTS.mainline]: { body: { total: 10, npm_dependents: "not an array" } },
  };
}

function runCollector(options: {
  history?: string;
  responses?: Record<string, MockResponse>;
  token?: string;
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
      now: `${TODAY}T00:30:00.000Z`,
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
  return yaml.load(result.content) as MetricSnapshot[];
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
      pkarr: { rust: 7, npm: 2 },
      pubky: { rust: 8, npm: 1 },
      "pubky-app-specs": { rust: 9, npm: 0 },
      mainline: { rust: 10, npm: 0 },
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
  for (const { url, headers } of result.requests) {
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
  const result = runCollector({ history: yaml.dump([oldest, latest]) });
  const snapshots = collected(result);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.slice(0, 2), [oldest, latest]);
  assert.equal(snapshots[2].date, TODAY);
  assert.deepEqual(snapshots[2].manual, latest.manual);
});

test("skips a duplicate day without requests or rewriting the file", () => {
  const history = `# Keep this file byte-for-byte.\n${yaml.dump([previousSnapshot(TODAY)])}`;
  const result = runCollector({ history, responses: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already exists, skipping/);
  assert.deepEqual(result.requests, []);
  assert.equal(result.content, history);
  assert.equal(result.afterModified, result.beforeModified);
});

test("supports requests without a GitHub token", () => {
  const result = runCollector({ token: "" });
  assert.equal(collected(result).length, 1);
  assert.ok(result.requests.some(({ url }) => new URL(url).hostname === "api.github.com"));
  for (const request of result.requests) {
    assert.equal(request.headers.authorization, undefined);
  }
});

test("uses zero fallbacks for HTTP, network, and JSON failures", async (t) => {
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
        dependents: Object.fromEntries(Object.keys(DEPENDENTS).map((name) => [name, { rust: 0, npm: 0 }])),
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
    "mapping root": "snapshots: []\n",
    "null root": "null\n",
    "malformed snapshot": yaml.dump([{ date: "2026-09-09" }]),
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
  const history = yaml.dump([previousSnapshot()]);
  const responses = defaultResponses();
  responses[NPM["@synonymdev/pubky"]] = { body: { downloads: "unexpected value" } };
  const result = runCollector({ history, responses });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Collection failed:/);
  assert.ok(result.requests.length > 0);
  assert.equal(result.content, history);
  assert.equal(result.afterModified, result.beforeModified);
});
