import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync("site/index.html", "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, "expected the site's single inline relative-time script");
const source = scripts[0][1];
const NOW = Date.parse("2026-05-02T12:00:00Z");

function run(el: { textContent: string; getAttribute: (name: string) => string } | null): void {
  runInNewContext(source, {
    document: {
      getElementById(id: string) {
        assert.equal(id, "last-collected");
        return el;
      },
    },
    Date: class extends Date {
      static now() { return NOW; }
    },
  }, { timeout: 1_000 });
}

test("the page adds relative collection time at minute, hour and day boundaries", () => {
  for (const [seconds, expected] of [
    [-30, "just now"],
    [0, "just now"],
    [59, "just now"],
    [60, "1 min ago"],
    [90, "2 min ago"],
    [3599, "60 min ago"],
    [3600, "1 h ago"],
    [86399, "24 h ago"],
    [86400, "1 d ago"],
    [172800, "2 d ago"],
  ] as const) {
    const el = {
      textContent: "2026-05-02 12:00 UTC",
      getAttribute(name: string) {
        assert.equal(name, "datetime");
        return new Date(NOW - seconds * 1000).toISOString();
      },
    };
    run(el);
    assert.equal(el.textContent, `2026-05-02 12:00 UTC (${expected})`);
  }
});

test("the page tolerates a missing timestamp element or invalid date", () => {
  assert.doesNotThrow(() => run(null));
  for (const date of ["invalid", "{{LAST_COLLECTED_ISO}}", ""]) {
    const el = { textContent: "Original timestamp", getAttribute: () => date };
    run(el);
    assert.equal(el.textContent, "Original timestamp");
  }
});
