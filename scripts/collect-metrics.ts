#!/usr/bin/env npx tsx
/**
 * Collects DX metrics from GitHub, npm, and crates.io APIs.
 * Run manually: GITHUB_TOKEN=<token> npx tsx scripts/collect-metrics.ts
 * Or via GitHub Actions on a cron schedule.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dump, load } from "js-yaml";
import {
  validateSnapshots,
  type RepoMetrics,
  type NpmPackageMetrics,
  type CrateMetrics,
  type ManualMetrics,
  type MetricSnapshot,
} from "./metrics";
import { fetchDependentsAnalysis } from "./dependents";

// --- Configuration ---

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_ORG = "pubky";
const MIN_STARS = 5;

const NPM_PACKAGES = [
  "@synonymdev/pubky",
  "@synonymdev/react-native-pubky",
  "@synonymdev/pkarr",
  "@synonymdev/pubky-app-specs",
];

const CRATES = ["pkarr", "pubky"];

const DATA_FILE = path.resolve(process.cwd(), "data", "metrics.yaml");

// --- API helpers ---

const ghHeaders: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "dx-stats-collector",
};
if (GITHUB_TOKEN) {
  ghHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[fetch] ${res.status} for ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[fetch] Error for ${url}:`, err);
    return null;
  }
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- GitHub ---

async function discoverOrgRepos(): Promise<string[]> {
  const repos: string[] = [];
  let page = 1;
  while (true) {
    const data = await fetchJson<Array<{ name: string; stargazers_count: number }>>(
      `https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=100&sort=stars&page=${page}`,
      ghHeaders,
    );
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.stargazers_count >= MIN_STARS) {
        repos.push(r.name);
      }
    }
    if (data.length < 100) break;
    page++;
    await delay(300);
  }
  return repos;
}

async function fetchRepoStats(repo: string): Promise<RepoMetrics> {
  const data = await fetchJson<{
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
  }>(`https://api.github.com/repos/${GITHUB_ORG}/${repo}`, ghHeaders);

  return {
    stars: data?.stargazers_count ?? 0,
    forks: data?.forks_count ?? 0,
    open_issues: data?.open_issues_count ?? 0,
  };
}

async function fetchOrgFollowers(): Promise<number> {
  const data = await fetchJson<{ followers: number }>(
    `https://api.github.com/orgs/${GITHUB_ORG}`,
    ghHeaders,
  );
  return data?.followers ?? 0;
}

// --- npm ---

async function fetchNpmWeeklyDownloads(pkg: string): Promise<number> {
  const data = await fetchJson<{ downloads: number }>(
    `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`,
  );
  return data?.downloads ?? 0;
}

// --- crates.io ---

async function fetchCrateStats(name: string): Promise<CrateMetrics> {
  const data = await fetchJson<{
    crate: { downloads: number; recent_downloads: number };
  }>(`https://crates.io/api/v1/crates/${name}`, {
    "User-Agent": "dx-stats-collector (github.com/pubky/dx-stats)",
  });
  return {
    recent: data?.crate?.recent_downloads ?? 0,
    total: data?.crate?.downloads ?? 0,
  };
}

// --- Main ---

function saveSnapshots(snapshots: MetricSnapshot[]): void {
  validateSnapshots(snapshots);
  const dir = path.dirname(DATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DATA_FILE, dump(snapshots, { lineWidth: -1, noRefs: true }), "utf8");
}

async function main() {
  const checkedAt = new Date().toISOString();
  const today = checkedAt.slice(0, 10);

  // Load existing data
  let existing: MetricSnapshot[] = [];
  if (existsSync(DATA_FILE)) {
    const content = readFileSync(DATA_FILE, "utf8");
    const parsed = load(content);
    validateSnapshots(parsed);
    existing = parsed;
  }

  // Later runs can pick up a newly published analysis or recover a failed fetch.
  // Keep the first daily collection of unrelated metrics and manual edits intact.
  const todayIndex = existing.findIndex((snapshot) => snapshot.date === today);
  if (todayIndex !== -1) {
    console.log(`Refreshing dependents for existing snapshot ${today}...`);
    const dependents = await fetchDependentsAnalysis(existing, checkedAt);
    if (JSON.stringify(existing[todayIndex].dependents) !== JSON.stringify(dependents)) {
      existing[todayIndex] = { ...existing[todayIndex], dependents };
      saveSnapshots(existing);
    }
    return;
  }

  console.log(`Collecting metrics for ${today}...`);

  // Discover repos
  const repos = await discoverOrgRepos();
  console.log(`Found ${repos.length} repos with >= ${MIN_STARS} stars: ${repos.join(", ")}`);

  // Fetch GitHub repo stats
  const repoStats: Record<string, RepoMetrics> = {};
  for (const repo of repos) {
    console.log(`  Fetching ${repo}...`);
    repoStats[repo] = await fetchRepoStats(repo);
    await delay(500);
  }

  // Fetch org followers
  const orgFollowers = await fetchOrgFollowers();
  console.log(`  Org followers: ${orgFollowers}`);

  // Fetch npm stats
  const npmStats: Record<string, NpmPackageMetrics> = {};
  for (const pkg of NPM_PACKAGES) {
    const weekly = await fetchNpmWeeklyDownloads(pkg);
    npmStats[pkg] = { weekly };
    console.log(`  npm ${pkg}: ${weekly}/week`);
    await delay(200);
  }

  // Fetch crates stats
  const crateStats: Record<string, CrateMetrics> = {};
  for (const crate of CRATES) {
    crateStats[crate] = await fetchCrateStats(crate);
    console.log(`  crate ${crate}: ${crateStats[crate].recent} recent, ${crateStats[crate].total} total`);
    await delay(200);
  }

  // Fetch dependents from pubky-dependents-analysis
  const dependents = await fetchDependentsAnalysis(existing, checkedAt);

  // Carry forward manual KPIs from previous entry, or null
  const prevManual = existing.at(-1)?.manual;
  const manual: ManualMetrics = {
    ttfhw_minutes: prevManual?.ttfhw_minutes ?? null,
    active_builders: prevManual?.active_builders ?? null,
    community_projects: prevManual?.community_projects ?? null,
    homeserver_nodes: prevManual?.homeserver_nodes ?? null,
    docs_monthly_visitors: prevManual?.docs_monthly_visitors ?? null,
    bounty_completion_rate: prevManual?.bounty_completion_rate ?? null,
    events_attended: prevManual?.events_attended ?? null,
  };

  // Build snapshot
  const snapshot: MetricSnapshot = {
    date: today,
    github: {
      org_followers: orgFollowers,
      repos: repoStats,
    },
    npm: npmStats,
    crates: crateStats,
    dependents,
    manual,
  };

  // Append and write
  existing.push(snapshot);
  saveSnapshots(existing);
  console.log(`Collected metrics for ${today}. Total entries: ${existing.length}`);
}

main().catch((err) => {
  console.error("Collection failed:", err);
  process.exit(1);
});
