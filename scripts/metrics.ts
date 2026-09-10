/** Shared types and runtime validation for collected and published metrics. */

export interface RepoMetrics {
  stars: number;
  forks: number;
  open_issues: number;
}

export interface CrateDependents {
  rust: number | null;
  npm: number | null;
  source?: DependentsSource;
}

export const DEPENDENTS_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const SOURCE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const DEPENDENTS_REASONS = [
  "fetch_failed", "invalid_source", "incomplete_source", "mixed_runs",
  "source_too_old", "source_regressed", "unverified_source",
] as const;

export interface DependentsSource {
  status: "current" | "stale" | "unverified" | "unavailable";
  observed_at: string | null;
  run_id: string | null;
  checked_at: string;
  reason?: typeof DEPENDENTS_REASONS[number];
}

/** Accept UTC timestamps from JavaScript and Python without normalizing provenance. */
export function isUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
  ) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} must be a nonnegative finite integer`);
  }
}

function dependentsMap(value: unknown, location: string): void {
  for (const [name, entry] of Object.entries(record(value, location))) {
    const entryLocation = `${location}[${JSON.stringify(name)}]`;
    const metrics = record(entry, entryLocation);
    if (metrics.source === undefined) {
      count(metrics.rust, `${entryLocation}.rust`);
      count(metrics.npm, `${entryLocation}.npm`);
      continue;
    }

    const sourceLocation = `${entryLocation}.source`;
    const source = record(metrics.source, sourceLocation);
    if (typeof source.status !== "string" || !["current", "stale", "unverified", "unavailable"].includes(source.status)) {
      throw new Error(`${sourceLocation}.status is invalid`);
    }
    if (!isUtcTimestamp(source.checked_at)) throw new Error(`${sourceLocation}.checked_at must be a UTC timestamp`);
    for (const field of ["observed_at", "run_id"]) {
      if (source[field] !== null && !isUtcTimestamp(source[field])) {
        throw new Error(`${sourceLocation}.${field} must be null or a UTC timestamp`);
      }
      if (typeof source[field] === "string" && Date.parse(source[field]) > Date.parse(source.checked_at) + SOURCE_CLOCK_SKEW_MS) {
        throw new Error(`${sourceLocation}.${field} cannot be later than checked_at`);
      }
    }
    if (source.reason !== undefined && !DEPENDENTS_REASONS.some((reason) => reason === source.reason)) {
      throw new Error(`${sourceLocation}.reason is invalid`);
    }
    if (source.status === "unavailable") {
      if (metrics.rust !== null || metrics.npm !== null || source.observed_at !== null || source.run_id !== null) {
        throw new Error(`${sourceLocation}: unavailable counts and observation metadata must be null`);
      }
    } else {
      count(metrics.rust, `${entryLocation}.rust`);
      count(metrics.npm, `${entryLocation}.npm`);
      if (source.status === "unverified") {
        if (source.run_id !== null) throw new Error(`${sourceLocation}: unverified data cannot claim a complete run`);
      } else if (source.observed_at === null || source.run_id === null) {
        throw new Error(`${sourceLocation}: verified data requires observed_at and run_id`);
      }
      if (typeof source.run_id === "string" && typeof source.observed_at === "string" &&
        Date.parse(source.run_id) > Date.parse(source.observed_at) + SOURCE_CLOCK_SKEW_MS) {
        throw new Error(`${sourceLocation}: run_id cannot be later than observed_at`);
      }
      if (source.status === "current" && typeof source.observed_at === "string" &&
        Date.parse(source.checked_at) - Date.parse(source.observed_at) > DEPENDENTS_MAX_AGE_MS) {
        throw new Error(`${sourceLocation}: an observation older than eight days cannot be current`);
      }
    }
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
      dependentsMap(snapshot.dependents, `${location}.dependents`);
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
