# dx-stats-data

Daily DX metrics for the [Pubky](https://github.com/pubky) org, collected from GitHub, npm, and crates.io and published as JSON via GitHub Pages.

## Endpoint

```
https://its-gaib.github.io/dx-stats-data/metrics.json
```

JSON array of daily snapshots. See [`site/index.html`](site/index.html) for the full shape, or [`scripts/collect-metrics.ts`](scripts/collect-metrics.ts) for the source-of-truth types.

## How it works

- [`scripts/collect-metrics.ts`](scripts/collect-metrics.ts) appends one snapshot per day to [`data/metrics.yaml`](data/metrics.yaml).
- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) runs the collector every 12 hours and commits the YAML if it changed.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) converts the YAML to JSON via [`scripts/build-site.ts`](scripts/build-site.ts) and deploys `dist/` to Pages.

YAML is the in-repo source of truth (human-readable diffs); JSON is the published wire format.

## Local

```bash
npm ci
GITHUB_TOKEN=<token> npm run collect   # adds today's snapshot to data/metrics.yaml
npm run build                          # writes dist/metrics.json + dist/index.html
```

A `GITHUB_TOKEN` is optional but recommended to avoid unauthenticated rate limits.

## Consumers

- Dashboard: [its-gaib/dx-stats](https://github.com/its-gaib/dx-stats) ([live](https://its-gaib.github.io/dx-stats/))
