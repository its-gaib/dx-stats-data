/** Validate one complete upstream publication before accepting any of its counts. */

import {
  DEPENDENTS_MAX_AGE_MS,
  SOURCE_CLOCK_SKEW_MS,
  isUtcTimestamp,
  type CrateDependents,
  type DependentsSource,
  type MetricSnapshot,
} from "./metrics";

const CRATES = ["pkarr", "pubky", "pubky-app-specs", "mainline"] as const;
const BASE_URL = "https://its-gaib.github.io/pubky-dependents-analysis";
const FETCH_TIMEOUT_MS = 30_000;
const RUST_SOURCES = ["crates_io", "github_cargo_toml", "github_cargo_lock", "github_dependents"];
type Reason = NonNullable<DependentsSource["reason"]>;
type VerifiedDependents = CrateDependents & { source: DependentsSource };

class InvalidPublication extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidPublication("invalid_source");
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidPublication("invalid_source");
  }
  return value;
}

function parsePublication(crate: string, raw: unknown, checkedAt: string): VerifiedDependents {
  const data = record(raw);
  if (data.crate !== crate) throw new InvalidPublication("invalid_source");
  if (data.collection === undefined) throw new InvalidPublication("unverified_source");
  const collection = record(data.collection);
  if (collection.status !== "complete") throw new InvalidPublication("incomplete_source");
  if (!isUtcTimestamp(data.updated_at) || !isUtcTimestamp(collection.run_id)) {
    throw new InvalidPublication("invalid_source");
  }
  const observedAt = Date.parse(data.updated_at);
  const runAt = Date.parse(collection.run_id);
  const checked = Date.parse(checkedAt);
  if (
    observedAt > checked + SOURCE_CLOCK_SKEW_MS ||
    runAt > checked + SOURCE_CLOCK_SKEW_MS ||
    runAt > observedAt + SOURCE_CLOCK_SKEW_MS
  ) throw new InvalidPublication("invalid_source");

  const sources = record(collection.sources);
  const requiredSources = crate === "mainline"
    ? RUST_SOURCES
    : [...RUST_SOURCES, "npm_registry", "github_package_json"];
  for (const source of requiredSources) count(sources[source]);
  for (const value of Object.values(sources)) count(value);

  const total = count(data.total);
  const summary = record(data.summary);
  const lists = record(data.lists);
  let summarized = 0;
  if (Object.keys(summary).length !== Object.keys(lists).length) {
    throw new InvalidPublication("invalid_source");
  }
  for (const [name, value] of Object.entries(summary)) {
    const entries = lists[name];
    if (!Array.isArray(entries) || count(value) !== entries.length) {
      throw new InvalidPublication("invalid_source");
    }
    for (const entry of entries) {
      const repo = record(entry).repo;
      if (typeof repo !== "string" || repo.trim() === "") throw new InvalidPublication("invalid_source");
    }
    summarized += value as number;
  }
  if (summarized !== total || !Number.isSafeInteger(summarized)) {
    throw new InvalidPublication("invalid_source");
  }
  if ((crate !== "mainline" || data.npm_dependents !== undefined) && !Array.isArray(data.npm_dependents)) {
    throw new InvalidPublication("invalid_source");
  }
  const npmTotal = Array.isArray(data.npm_dependents) ? data.npm_dependents.length : 0;
  const npmSummarized = crate === "mainline" ? 0 : count(sources.npm_registry) + count(sources.github_package_json);
  if (!Number.isSafeInteger(npmSummarized) || npmTotal !== npmSummarized) {
    throw new InvalidPublication("invalid_source");
  }

  const stale = checked - observedAt > DEPENDENTS_MAX_AGE_MS;
  return {
    rust: total,
    npm: npmTotal,
    source: {
      status: stale ? "stale" : "current",
      observed_at: data.updated_at,
      run_id: collection.run_id,
      checked_at: checkedAt,
      ...(stale ? { reason: "source_too_old" as const } : {}),
    },
  };
}

function previousValue(history: MetricSnapshot[], crate: string): CrateDependents | undefined {
  const candidates = history.slice().reverse()
    .map((snapshot) => snapshot.dependents?.[crate])
    .filter((entry): entry is CrateDependents => entry !== undefined && entry.rust !== null && entry.npm !== null);
  return candidates.find((entry) => entry.source?.status === "current" || entry.source?.status === "stale")
    ?? candidates.find((entry) => !entry.source || entry.source.status === "unverified");
}

function fallback(history: MetricSnapshot[], crate: string, checkedAt: string, reason: Reason): CrateDependents {
  const previous = previousValue(history, crate);
  if (!previous) {
    return {
      rust: null,
      npm: null,
      source: { status: "unavailable", observed_at: null, run_id: null, checked_at: checkedAt, reason },
    };
  }
  const verified = previous.source?.status === "current" || previous.source?.status === "stale";
  return {
    rust: previous.rust,
    npm: previous.npm,
    source: {
      status: verified ? "stale" : "unverified",
      observed_at: previous.source?.observed_at ?? null,
      run_id: verified ? previous.source!.run_id : null,
      checked_at: checkedAt,
      reason,
    },
  };
}

export async function fetchDependentsAnalysis(
  history: MetricSnapshot[],
  checkedAt: string,
): Promise<Record<string, CrateDependents>> {
  // These are public, fixed URLs. Never forward the collector's GitHub token.
  const responses = await Promise.all(CRATES.map(async (crate) => {
    try {
      const response = await fetch(`${BASE_URL}/${crate}.json`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new InvalidPublication("fetch_failed");
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new InvalidPublication("invalid_source");
      }
      return { crate, value: parsePublication(crate, raw, checkedAt) };
    } catch (error) {
      return { crate, reason: error instanceof InvalidPublication ? error.reason : "fetch_failed" as const };
    }
  }));

  let reason: Reason | undefined = responses.find((response) => response.reason)?.reason;
  const values = responses.flatMap((response) => response.value ? [response.value] : []);
  if (!reason && new Set(values.map((value) => value.source.run_id)).size !== 1) reason = "mixed_runs";
  if (!reason) {
    for (const { crate, value } of responses) {
      const previous = previousValue(history, crate);
      if (value && previous?.source?.run_id && previous.source.observed_at && (
        Date.parse(value.source.run_id!) < Date.parse(previous.source.run_id) ||
        Date.parse(value.source.observed_at!) < Date.parse(previous.source.observed_at)
      )) {
        reason = "source_regressed";
        break;
      }
    }
  }
  if (reason) console.warn(`[dependents] Publication not accepted: ${reason}; preserving prior observations.`);

  return Object.fromEntries(responses.map(({ crate, value }) => {
    const entry = reason ? fallback(history, crate, checkedAt, reason) : value!;
    console.log(`  dependents ${crate}: ${entry.rust ?? "unavailable"} Rust, ${entry.npm ?? "unavailable"} npm (${entry.source!.status})`);
    return [crate, entry];
  }));
}
