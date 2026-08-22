import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;
const compiled = readFileSync(adapter, "utf8");
const retryDelaySource = compiled.match(/function retryDelayMs\([\s\S]*?\n\}/)?.[0];
assert.ok(retryDelaySource, "compiled adapter must contain retryDelayMs");
const retryDelayMs = new Function(`${retryDelaySource}; return retryDelayMs;`)();

function retryAfterResponse(value) {
  return { headers: { get: (name) => (name.toLowerCase() === "retry-after" ? value : null) } };
}

test("HTTP-date Retry-After computes a positive delay from one clock sample", () => {
  const nowCalls = [];
  const realNow = Date.now;
  Date.now = () => {
    nowCalls.push(nowCalls.length === 0 ? 1_000_000 : 1_000_002);
    return nowCalls[nowCalls.length - 1];
  };
  try {
    const delay = retryDelayMs(retryAfterResponse(new Date(1_000_001).toISOString()), 1);
    assert.equal(nowCalls.length, 1);
    assert.equal(delay, 1);
  } finally {
    Date.now = realNow;
  }
});

test("HTTP-date Retry-After at the sampled instant falls through to exponential backoff", () => {
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => 1_000_000;
  Math.random = () => 0;
  try {
    const delay = retryDelayMs(retryAfterResponse(new Date(1_000_000).toISOString()), 1);
    assert.equal(delay, 1000);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
});

test("past HTTP-date Retry-After falls through to exponential backoff", () => {
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const delay = retryDelayMs(retryAfterResponse("Thu, 01 Jan 1970 00:00:00 GMT"), 1);
    assert.equal(delay, 1000);
  } finally {
    Math.random = realRandom;
  }
});
