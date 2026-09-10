# dx-stats-data

Daily DX metrics for the [Pubky](https://github.com/pubky) org, collected from GitHub, npm, and crates.io and published as JSON via GitHub Pages.

## Endpoint

```
https://its-gaib.github.io/dx-stats-data/metrics.json
```

JSON array of daily snapshots. See [`site/index.html`](site/index.html) for the full shape, or [`scripts/metrics.ts`](scripts/metrics.ts) for the source-of-truth types and validation rules.

## How it works

- [`scripts/collect-metrics.ts`](scripts/collect-metrics.ts) appends one snapshot per day to [`data/metrics.yaml`](data/metrics.yaml). Later runs that day refresh only the dependents and their provenance, preserving all other metrics and manual edits.
- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) runs the collector at 00:00 and 12:00 UTC and commits the YAML if it changed. GitHub Actions may delay scheduled starts.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) converts the YAML to JSON via [`scripts/build-site.ts`](scripts/build-site.ts) and deploys `dist/` to Pages.

YAML is the in-repo source of truth (human-readable diffs); JSON is the published wire format.

## Dependents reliability and freshness

The dependents collector reads the four configured JSON files from
[pubky-dependents-analysis](https://github.com/its-gaib/pubky-dependents-analysis).
It accepts a publication only when all four declare `collection.status: complete`
and the same `collection.run_id`. Crate identities, required source counts,
summary/list totals, numeric counts, and UTC timestamps must validate. A cached
publication cannot move a previously verified observation backward. Each request
has a 30-second timeout and does not receive the GitHub token.

Each new `dependents[crate]` value includes additive `source` metadata:

```json
{
  "rust": 613,
  "npm": 28,
  "source": {
    "status": "current",
    "observed_at": "2026-09-07T07:00:00+00:00",
    "run_id": "2026-09-07T06:00:00+00:00",
    "checked_at": "2026-09-10T12:00:00.000Z"
  }
}
```

`observed_at` is the original upstream measurement time; `checked_at` is this
collector's attempt time. Rechecking or carrying forward a value never changes
its observation time or run ID. Status is:

| Status | Meaning |
| --- | --- |
| `current` | A verified publication observed no more than eight days ago. |
| `stale` | A verified observation is older than eight days, or the latest fetch/publication failed validation and the previous verified counts were preserved. |
| `unverified` | Only archived legacy counts exist, without proof of a complete analysis. Their original observation time is unknown unless previously recorded. |
| `unavailable` | No archived observation is available. Both `rust` and `npm`, and their observation metadata, are `null`. |

The eight-day window allows the weekly analysis cadence plus a day of recovery.
A `reason` code explains failures (`fetch_failed`, `invalid_source`,
`incomplete_source`, `mixed_runs`, `source_regressed`, `unverified_source`) or an
expired observation (`source_too_old`). A valid complete count of zero remains
zero; a missing count is never converted to zero. Failed or mixed publications
preserve the last verified observation for each crate, falling back to archived
legacy counts only if none is verified. New legacy publications cannot replace
those archived values or supply an unrelated timestamp.

Daily records reflect the last known values and their status on that date; they
are not independent daily upstream measurements. A newer valid analysis or a
recovered fetch can correct **today's** dependents during the next collection,
including manual runs. Earlier records are preserved without interpolation or
automatic repair of historical bad counts. Consumers should use `observed_at`
and `run_id` to identify actual observations and show missing counts as gaps.

For rollout, deploy consumer support for nullable counts and provenance first,
then the upstream complete-publication contract, then this collector. Existing
history without `source` remains valid and should be treated as unverified.

## Local

Use Node.js 24 LTS, selected by [`.nvmrc`](.nvmrc), and npm 12.0.2, selected by
`packageManager` in [`package.json`](package.json). Node 22.22.2+ and 24.15.0+ are
supported; CI tests the latest release in both major versions. Collection and
publishing use the latest Node 24 release.

With [nvm](https://github.com/nvm-sh/nvm), set up the toolchain with:

```bash
nvm install
nvm use
npm install --global "$(node -p 'require("./package.json").packageManager')"
```

```bash
npm ci
GITHUB_TOKEN=<token> npm run collect   # adds today or refreshes today's dependents
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

History validation requires real `YYYY-MM-DD` strings in strictly increasing
order, nonnegative integer API counts, and nonnegative finite manual values or
`null`. js-yaml 5 uses the YAML 1.2 core schema: quoted and unquoted dates both
remain strings. Repository and package names can change over time, and older snapshots
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

## Updating dependencies and tooling

Run `npm outdated` to compare installed, compatible, and latest dependency
versions. Review major-version migration notes, then update the direct dependency
ranges in `package.json` and regenerate `package-lock.json` with `npm install`.
Use `npm update` for updates within the existing ranges. js-yaml includes its own
TypeScript declarations; the Node types track the oldest supported runtime (22).

npm 12 blocks dependency install scripts by default. `allowScripts` approves the
installed esbuild version so it can set up its native binary. After an update,
inspect `npm install-scripts ls`; review any required scripts before approving
specific packages with `npm install-scripts approve <package>` and running
`npm rebuild`. Keep approvals pinned to reviewed versions.

To update npm, change `packageManager` and its compatible `engines.npm` range,
then repeat the toolchain setup above. Keep `.nvmrc`, the supported Node engine
ranges, and the CI matrix consistent. Review the GitHub-owned actions in all
three workflows; update the actionlint Docker tag in `ci.yml` and its documented
local version together when a new release is available.

Validate updates with a clean `npm ci`, `npm run check`,
`npm audit --audit-level=high`, and `actionlint`. Commit the manifest, lockfile,
and any necessary code or configuration changes together.

## Consumers

- Dashboard: [its-gaib/dx-stats](https://github.com/its-gaib/dx-stats) ([live](https://its-gaib.github.io/dx-stats/))
