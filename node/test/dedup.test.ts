import { expect, it } from "vitest";
import { DedupCache, fingerprint } from "../src/dedup.js";
import { NormalizedAlertSchema } from "../src/models.js";

const makeAlert = (changes: Record<string, unknown> = {}) => NormalizedAlertSchema.parse({
  source_id: "datadog-prod", source_type: "datadog", service: "checkout-api", title: "5xx rate high",
  resource: "service:checkout-api", description: "first", fired_at: "2026-11-19T10:00:00Z", ...changes,
});

function fakeClock() {
  const clock = () => clock.now;
  clock.now = 0;
  return clock;
}

it("same alert, same fingerprint (description and time are not part of it)", () => {
  expect(fingerprint(makeAlert())).toBe(fingerprint(makeAlert({ description: "second", fired_at: "2026-11-19T11:00:00Z" })));
});

it("different alert, different fingerprint", () => {
  expect(fingerprint(makeAlert())).not.toBe(fingerprint(makeAlert({ title: "latency high" })));
  expect(fingerprint(makeAlert())).not.toBe(fingerprint(makeAlert({ resource: "host:web-1" })));
});

it("same fingerprint as the Python app", () => {
  // python -c "import hashlib;print(hashlib.sha256(b'datadog-prod|checkout-api|5xx rate high|service:checkout-api').hexdigest())"
  expect(fingerprint(makeAlert())).toBe("028596e584de3d625d5e0cb6c201a934be9b5e80e75a51e0f566dafe961b3a19");
});

it("repeats within the TTL are duplicates", async () => {
  const cache = new DedupCache(15);
  expect(await cache.check("fp", "inv-1")).toEqual(["inv-1", 1, false]);
  expect(await cache.check("fp", "inv-2")).toEqual(["inv-1", 2, true]);
  expect(await cache.check("fp", "inv-3")).toEqual(["inv-1", 3, true]);
});

it("after the TTL a new investigation starts", async () => {
  const clock = fakeClock();
  const cache = new DedupCache(15, clock);
  await cache.check("fp", "inv-1");
  clock.now = 15 * 60;
  expect(await cache.check("fp", "inv-2")).toEqual(["inv-2", 1, false]);
});

it("an open investigation keeps counting after the TTL", async () => {
  const clock = fakeClock();
  const cache = new DedupCache(15, clock);
  await cache.check("fp", "inv-1", () => "open");
  clock.now = 3 * 3600; // hours later, still open: same row, count goes up
  expect(await cache.check("fp", "inv-2", () => "open")).toEqual(["inv-1", 2, true]);
});

it("a closed investigation after the TTL starts a new one", async () => {
  const clock = fakeClock();
  const cache = new DedupCache(15, clock);
  await cache.check("fp", "inv-1", () => "open");
  clock.now = 15 * 60;
  expect(await cache.check("fp", "inv-2", () => "closed")).toEqual(["inv-2", 1, false]);
});

it("a closed investigation within the TTL is still a duplicate", async () => {
  const cache = new DedupCache(15);
  await cache.check("fp", "inv-1");
  expect(await cache.check("fp", "inv-2", () => "closed")).toEqual(["inv-1", 2, true]);
});

it("an investigation no longer kept starts a new one, even within the TTL", async () => {
  // Otherwise the repeat would be counted on an investigation nobody can see, and lost.
  const cache = new DedupCache(15);
  await cache.check("fp", "inv-1");
  expect(await cache.check("fp", "inv-2", () => null)).toEqual(["inv-2", 1, false]);
});
