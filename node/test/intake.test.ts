import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sign } from "../src/security.js";
import { loadPayload, makeApp, postSigned, TEST_SECRETS, type TestApp } from "./helpers.js";

let app: TestApp;
beforeEach(async () => (app = await makeApp()));
afterEach(() => app.close());

const postAlert = (sourceId: string, payload: unknown, secret: string) => postSigned(app, sourceId, payload, { secret });

it("health", async () => {
  expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
});

it("unknown source returns 404", async () => {
  expect((await postAlert("nope", loadPayload("datadog"), "x")).statusCode).toBe(404);
});

it("bad signature returns 401", async () => {
  expect((await postAlert("datadog-prod", loadPayload("datadog"), "wrong")).statusCode).toBe(401);
});

it("missing signature returns 401", async () => {
  expect((await postSigned(app, "datadog-prod", loadPayload("datadog"), { signature: null })).statusCode).toBe(401);
});

it("bad payload returns 422", async () => {
  expect((await postAlert("datadog-prod", { no: "title" }, TEST_SECRETS.SRC_DATADOG_SECRET)).statusCode).toBe(422);
});

it("signed alert returns 202", async () => {
  const r = await postAlert("azure-prod", loadPayload("azure_monitor"), TEST_SECRETS.SRC_AZURE_SECRET);
  expect(r.statusCode).toBe(202);
  expect(app.state.store.get(r.json().investigation_id)!.status).toBe("queued");
});

it("same alert three times is one investigation", async () => {
  const responses = [];
  for (let i = 0; i < 3; i++) responses.push((await postAlert("datadog-prod", loadPayload("datadog"), TEST_SECRETS.SRC_DATADOG_SECRET)).json());
  expect(new Set(responses.map((r) => r.investigation_id)).size).toBe(1);
  expect(responses[2].dedup_count).toBe(3);
  expect(app.state.store.items.size).toBe(1);
  expect(app.state.store.newestFirst()[0].dedup_count).toBe(3);
});

describe("bad requests", () => {
  const bodies = [Buffer.from("{not json"), Buffer.from("[1, 2, 3]"), Buffer.from(""), Buffer.from('"just a string"'),
    Buffer.from("null"), Buffer.concat([Buffer.from('{"title": "'), Buffer.from([0xff]), Buffer.from('"}')])];
  for (const body of bodies) {
    it(`unusable body with valid signature returns 422: ${JSON.stringify(body.toString("latin1"))}`, async () => {
      expect((await postSigned(app, "datadog-prod", body)).statusCode).toBe(422);
    });
  }

  it("signature must match exact bytes", async () => {
    // Re-formatting the JSON (same data, different bytes) breaks the signature.
    const payload = loadPayload("datadog");
    const signature = sign(TEST_SECRETS.SRC_DATADOG_SECRET, JSON.stringify(payload));
    expect((await postSigned(app, "datadog-prod", JSON.stringify(payload, null, 2), { signature })).statusCode).toBe(401);
  });

  it("unknown source checked before signature", async () => {
    expect((await app.inject({ method: "POST", url: "/hooks/nope", payload: "anything" })).statusCode).toBe(404);
  });

  it("GET on hook not allowed", async () => {
    expect((await app.inject("/hooks/datadog-prod")).statusCode).toBe(405);
  });

  it("rejected requests create nothing", async () => {
    await postAlert("datadog-prod", loadPayload("datadog"), "wrong");
    await postAlert("nope", loadPayload("datadog"), "x");
    expect(app.state.store.newestFirst()).toEqual([]);
  });
});

describe("dedup through the API", () => {
  it("same title from different sources is not deduplicated", async () => {
    const generic = { title: "checkout-api 5xx rate above 5%", fired_at: "2026-11-20T06:00:00Z" };
    const a = (await postAlert("inhouse-app", generic, TEST_SECRETS.SRC_GENERIC_SECRET)).json();
    const b = (await postAlert("datadog-prod", loadPayload("datadog"), TEST_SECRETS.SRC_DATADOG_SECRET)).json();
    expect(a.investigation_id).not.toBe(b.investigation_id);
  });

  it("dedup window comes from settings: it applies once closed; while open, repeats always merge", async () => {
    for (const [ttl, merged] of [[0, false], [15, true]] as const) {
      const c = await makeApp({ dedup_ttl_min: ttl });
      const send = async () => (await postSigned(c, "datadog-prod", loadPayload("datadog"))).json();
      const first = await send();
      expect((await send()).investigation_id).toBe(first.investigation_id); // open: merged
      c.state.store.get(first.investigation_id)!.status = "concluded";
      expect((await send()).investigation_id === first.investigation_id).toBe(merged);
      await c.close();
    }
  });

  it("in-house alert can name its application", async () => {
    const payload = { title: "Job failed", service: "billing-service", fired_at: "2026-11-20T06:00:00Z" };
    const id = (await postAlert("inhouse-app", payload, TEST_SECRETS.SRC_GENERIC_SECRET)).json().investigation_id;
    expect(app.state.store.get(id)!.service).toBe("billing-service");
  });
});
