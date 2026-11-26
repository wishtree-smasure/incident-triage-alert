import { describe, expect, it } from "vitest";
import { normalize, NormalizationError } from "../src/normalizers/index.js";
import { loadPayload, testRegistry } from "./helpers.js";

const registry = testRegistry();
const source = (id: string) => registry.get(id)!;

it("datadog", () => {
  const alert = normalize(source("datadog-prod"), loadPayload("datadog"));
  expect(alert.service).toBe("checkout-api");
  expect(alert.title).toContain("5xx rate above 5%");
  expect(alert.severity_hint).toBe("SEV2"); // P2
  expect(alert.fired_at).toEqual(new Date(1795082400 * 1000));
  expect(alert.labels.env).toBe("prod");
});

it("cloudwatch", () => {
  const alert = normalize(source("cloudwatch-prod"), loadPayload("cloudwatch_sns"));
  expect(alert.service).toBe("orders-service");
  expect(alert.title).toBe("orders-service-p99-latency");
  expect(alert.severity_hint).toBeNull(); // CloudWatch has no severity
  expect(alert.fired_at).toEqual(new Date(Date.UTC(2026, 10, 19, 10, 0)));
  expect(alert.resource).toBe("LoadBalancer=app/orders-alb/50dc6c495c0c9188");
});

it("azure monitor", () => {
  const alert = normalize(source("azure-prod"), loadPayload("azure_monitor"));
  expect(alert.service).toBe("auth-gateway");
  expect(alert.title).toBe("auth-gateway 401/403 rate high");
  expect(alert.severity_hint).toBe("SEV2"); // Azure Sev1
  expect(alert.fired_at).toEqual(new Date(Date.UTC(2026, 10, 19, 9, 30, 12, 345)));
  expect(alert.resource!.endsWith("/components/auth-gateway")).toBe(true);
});

it("generic", () => {
  const alert = normalize(source("inhouse-app"), loadPayload("generic"));
  expect(alert.title).toBe("Invoice job failures");
  expect(alert.severity_hint).toBe("SEV2");
  expect(alert.labels).toEqual({ env: "prod", region: "eu-west-1" });
});

it("raw payload is kept", () => {
  const payload = loadPayload("datadog");
  expect(normalize(source("datadog-prod"), payload).raw).toEqual(payload);
});

const ALL = ["datadog-prod", "cloudwatch-prod", "azure-prod", "inhouse-app"];
describe("wrong payload shape raises", () => {
  for (const id of ALL) it(id, () => expect(() => normalize(source(id), { unexpected: "shape" })).toThrow(NormalizationError));
});

it("azure without targets has no resource", () => {
  const payload = loadPayload("azure_monitor");
  payload.data.essentials.alertTargetIDs = [];
  expect(normalize(source("azure-prod"), payload).resource).toBeNull();
});

it("cloudwatch without dimensions uses the alarm ARN", () => {
  const payload = loadPayload("cloudwatch_sns");
  const alarm = JSON.parse(payload.Message);
  alarm.Trigger.Dimensions = [];
  payload.Message = JSON.stringify(alarm);
  expect(normalize(source("cloudwatch-prod"), payload).resource).toBe(alarm.AlarmArn);
});

it("cloudwatch message that is not JSON raises", () => {
  const payload = loadPayload("cloudwatch_sns");
  payload.Message = "{not json";
  expect(() => normalize(source("cloudwatch-prod"), payload)).toThrow(NormalizationError);
});

it("datadog without tags", () => {
  const payload = loadPayload("datadog");
  delete payload.tags;
  expect(normalize(source("datadog-prod"), payload).labels).toEqual({});
});

it("generic service defaults to the registry and can be overridden", () => {
  const base = { title: "x", fired_at: "2026-11-20T06:00:00Z" };
  expect(normalize(source("inhouse-app"), base).service).toBe("inhouse-app");
  expect(normalize(source("inhouse-app"), { ...base, service: "billing" }).service).toBe("billing");
});

it("generic rejects unknown severity", () => {
  expect(() => normalize(source("inhouse-app"), { title: "x", fired_at: "2026-11-20T06:00:00Z", severity: "urgent" })).toThrow(NormalizationError);
});

describe("non-object payload raises", () => {
  for (const id of ALL) {
    for (const payload of [[], "text", null, 42]) {
      it(`${id} ${JSON.stringify(payload)}`, () => expect(() => normalize(source(id), payload)).toThrow(NormalizationError));
    }
  }
});
