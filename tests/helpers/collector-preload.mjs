// Loaded only by collector tests, before the real CLI starts. Every request is
// handled here so regression tests cannot contact an API or consume a token.
import { appendFileSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.env.COLLECTOR_TEST_CONFIG, "utf8"));
const NativeDate = Date;

globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length === 0 ? [config.now] : args));
  }

  static now() {
    return new NativeDate(config.now).getTime();
  }
};

const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args);

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  appendFileSync(config.requestsFile, `${JSON.stringify({ url, headers, hasSignal: init?.signal instanceof AbortSignal })}\n`);

  const response = config.responses[url];
  if (!response) {
    throw new Error(`Unexpected mocked request: ${url}`);
  }
  if (response.failure === "network") {
    throw new TypeError("Simulated network failure");
  }
  const body = response.failure === "json" ? "{invalid json" : JSON.stringify(response.body ?? {});
  return new Response(body, {
    status: response.failure === "http" ? 503 : 200,
    headers: { "Content-Type": "application/json" },
  });
};
