import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { expect, it } from "vitest";
import { loadRegistry, RegistryError } from "../src/registry.js";
import { TEST_SECRETS, testRegistry } from "./helpers.js";

const GOOD_SOURCE = {
  id: "datadog-prod", type: "datadog", service: "checkout-api", owner_team: "payments",
  secret_env: "SRC_DATADOG_SECRET", connector: "mock", scenario: "bad_deploy_datadog",
};

function writeRegistry(...sources: object[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reg-")), "sources.yaml");
  fs.writeFileSync(file, YAML.stringify({ sources }));
  return file;
}
function writeRaw(text: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reg-")), "sources.yaml");
  fs.writeFileSync(file, text);
  return file;
}

it("shipped sources.yaml loads", () => {
  const registry = testRegistry();
  expect(new Set(registry.sources.keys())).toEqual(new Set(["datadog-prod", "cloudwatch-prod", "azure-prod", "inhouse-app"]));
  expect(registry.get("datadog-prod")!.owner_team).toBe("payments");
  expect(registry.secretFor("datadog-prod")).toBe("dd-secret");
  expect(registry.get("unknown")).toBeUndefined();
});

it("unknown type fails", () => expect(() => loadRegistry(writeRegistry({ ...GOOD_SOURCE, type: "splunk" }), TEST_SECRETS)).toThrow(/type/));

it("missing field fails", () => {
  const { owner_team, ...source } = GOOD_SOURCE;
  expect(() => loadRegistry(writeRegistry(source), TEST_SECRETS)).toThrow(/owner_team/);
});

it("mock connector needs scenario", () => {
  expect(() => loadRegistry(writeRegistry({ ...GOOD_SOURCE, scenario: null }), TEST_SECRETS)).toThrow(/scenario/);
});

it("duplicate ids fail", () => expect(() => loadRegistry(writeRegistry(GOOD_SOURCE, GOOD_SOURCE), TEST_SECRETS)).toThrow(/duplicate/));

it("missing secret env var fails", () => {
  expect(() => loadRegistry(writeRegistry(GOOD_SOURCE), {})).toThrow(RegistryError);
  expect(() => loadRegistry(writeRegistry(GOOD_SOURCE), {})).toThrow(/SRC_DATADOG_SECRET/);
});

it("bad yaml fails", () => expect(() => loadRegistry(writeRaw("sources: [unclosed"), TEST_SECRETS)).toThrow(RegistryError));

it("display name falls back to id", () => {
  const reg = loadRegistry(writeRegistry(GOOD_SOURCE), TEST_SECRETS);
  expect(reg.nameOf("datadog-prod")).toBe("datadog-prod");
  expect(reg.nameOf("unknown")).toBe("unknown");
});

it("shipped sources have display names", () => {
  const registry = testRegistry();
  expect(new Set([...registry.sources.keys()].map((s) => registry.nameOf(s)))).toEqual(
    new Set(["Datadog prod", "AWS prod", "Azure prod", "In-house logs"]));
});

it("unknown field is rejected", () => {
  expect(() => loadRegistry(writeRegistry({ ...GOOD_SOURCE, secret: "inline secrets not allowed" }), TEST_SECRETS)).toThrow(/secret/);
});

it("real connector does not need scenario", () => {
  const reg = loadRegistry(writeRegistry({ ...GOOD_SOURCE, connector: "real", scenario: null }), TEST_SECRETS);
  expect(reg.get("datadog-prod")!.connector).toBe("real");
});

it("missing sources key fails", () => expect(() => loadRegistry(writeRaw("something_else: []\n"), TEST_SECRETS)).toThrow(RegistryError));
