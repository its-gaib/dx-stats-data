/** Shared types and runtime validation for collected and published metrics. */

export interface RepoMetrics {
  stars: number;
  forks: number;
  open_issues: number;
}

export interface CrateDependents {
  rust: number;
  npm: number;
}

export interface NpmPackageMetrics {
  weekly: number;
}

export interface CrateMetrics {
  recent: number;
  total: number;
}

export interface ManualMetrics {
  ttfhw_minutes: number | null;
  active_builders: number | null;
  community_projects: number | null;
  homeserver_nodes: number | null;
  docs_monthly_visitors: number | null;
  bounty_completion_rate: number | null;
  events_attended: number | null;
}

export interface MetricSnapshot {
  date: string;
  github: {
    org_followers: number;
    repos: Record<string, RepoMetrics>;
  };
  npm: Record<string, NpmPackageMetrics>;
  crates: Record<string, CrateMetrics>;
  dependents?: Record<string, CrateDependents>;
  manual: ManualMetrics;
}

const MANUAL_FIELDS: ReadonlyArray<keyof ManualMetrics> = [
  "ttfhw_minutes",
  "active_builders",
  "community_projects",
  "homeserver_nodes",
  "docs_monthly_visitors",
  "bounty_completion_rate",
  "events_attended",
];

function record(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new Error(`${location} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function count(value: unknown, location: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${location} must be a nonnegative finite integer`);
  }
}

function metricMap(value: unknown, location: string, fields: string[]): void {
  for (const [name, entry] of Object.entries(record(value, location))) {
    const entryLocation = `${location}[${JSON.stringify(name)}]`;
    const metrics = record(entry, entryLocation);
    for (const field of fields) count(metrics[field], `${entryLocation}.${field}`);
  }
}

/**
 * Empty history is valid when starting the collector. Publishing and the data
 * validation command additionally require at least one snapshot.
 */
export function validateSnapshots(value: unknown): asserts value is MetricSnapshot[] {
  if (!Array.isArray(value)) throw new Error("metrics must be an array of snapshots");

  let previousDate: string | undefined;
  for (const [index, entry] of value.entries()) {
    const location = `snapshots[${index}]`;
    const snapshot = record(entry, location);
    const date = snapshot.date;
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
    ) {
      throw new Error(`${location}.date must be a valid YYYY-MM-DD string`);
    }
    if (previousDate !== undefined && date <= previousDate) {
      throw new Error(`${location}.date must be strictly later than ${previousDate}`);
    }
    previousDate = date;

    const github = record(snapshot.github, `${location}.github`);
    count(github.org_followers, `${location}.github.org_followers`);
    metricMap(github.repos, `${location}.github.repos`, ["stars", "forks", "open_issues"]);
    metricMap(snapshot.npm, `${location}.npm`, ["weekly"]);
    metricMap(snapshot.crates, `${location}.crates`, ["recent", "total"]);
    // Dependents were added after collection began; names also change over time.
    if (snapshot.dependents !== undefined) {
      metricMap(snapshot.dependents, `${location}.dependents`, ["rust", "npm"]);
    }

    const manual = record(snapshot.manual, `${location}.manual`);
    for (const field of MANUAL_FIELDS) {
      const metric = manual[field];
      if (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)) {
        throw new Error(`${location}.manual.${field} must be null or a nonnegative finite number`);
      }
    }
  }
}
