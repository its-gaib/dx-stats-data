# dx-stats-data

Daily DX metrics for the [Pubky](https://github.com/pubky) org, collected from GitHub, npm, and crates.io and published as JSON via GitHub Pages.

## Endpoint

```
https://its-gaib.github.io/dx-stats-data/metrics.json
```

JSON array of daily snapshots. See [`site/index.html`](site/index.html) for the full shape, or [`scripts/metrics.ts`](scripts/metrics.ts) for the source-of-truth types and validation rules.

## How it works

- [`scripts/collect-metrics.ts`](scripts/collect-metrics.ts) appends one snapshot per day to [`data/metrics.yaml`](data/metrics.yaml).
- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) runs the collector every 12 hours and commits the YAML if it changed.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) converts the YAML to JSON via [`scripts/build-site.ts`](scripts/build-site.ts) and deploys `dist/` to Pages.

YAML is the in-repo source of truth (human-readable diffs); JSON is the published wire format.

## Local

Use Node.js 22 or 24 (the collection and publishing workflows use 24).

```bash
npm ci
GITHUB_TOKEN=<token> npm run collect   # adds today's snapshot to data/metrics.yaml
npm run build                          # writes dist/metrics.json + dist/index.html
```

A `GITHUB_TOKEN` is optional but recommended to avoid unauthenticated rate limits.

## Checks

```bash
npm ci
npm run check          # typecheck, offline tests, data validation, and Pages build
npm run typecheck      # strict TypeScript checks for scripts and tests
npm test               # collector, validator, build, and site regression tests
npm run validate:data  # validate the committed snapshot history
npm run build          # validate the history and write the Pages artifact
npm audit --audit-level=high
actionlint             # actionlint 1.7.12, with ShellCheck installed
```

The tests use Node's built-in test runner and tsx. Collector HTTP responses, time,
and delays are mocked; file writes and test Git history stay in temporary
directories. No API token or live collection is needed. Dependency installation
and the audit require access to the npm registry.

History validation requires real, quoted `YYYY-MM-DD` dates in strictly increasing
order, nonnegative integer API counts, and nonnegative finite manual values or
`null`. Repository and package names can change over time, and older snapshots
may omit `dependents`. The validator and Pages builder require a nonempty history;
the collector can start from an empty history and rejects malformed existing data
before making requests or writing changes.

[CI](.github/workflows/ci.yml) runs the project checks on Node 22 and 24 for every
pull request and push to `main`, plus workflow/shell linting and a dependency audit
that rejects high or critical advisories. PR jobs have read-only permissions.
Collection runs the project checks before fetching metrics and validates the new
history before committing it. Pages runs the same project checks on its checkout
before uploading the artifact; this also covers commits made by the collector's
`GITHUB_TOKEN`, which do not trigger ordinary push workflows. Only the deployment
job receives Pages write and OIDC permissions. Manual collection and publishing
are restricted to `main`.

## Consumers

- Dashboard: [its-gaib/dx-stats](https://github.com/its-gaib/dx-stats) ([live](https://its-gaib.github.io/dx-stats/))
