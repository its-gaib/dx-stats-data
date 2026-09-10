import type { MetricSnapshot } from "../../scripts/metrics";

export function snapshot(date = "2026-01-01"): MetricSnapshot {
  return {
    date,
    github: {
      org_followers: 20,
      repos: { example: { stars: 5, forks: 0, open_issues: 2 } },
    },
    npm: { "@example/package": { weekly: 100 } },
    crates: { example: { recent: 40, total: 200 } },
    dependents: { example: { rust: 3, npm: 1 } },
    manual: {
      ttfhw_minutes: 12.5,
      active_builders: 0,
      community_projects: null,
      homeserver_nodes: 1,
      docs_monthly_visitors: 200,
      bounty_completion_rate: 92.5,
      events_attended: null,
    },
  };
}
