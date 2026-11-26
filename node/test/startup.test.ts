/** The app refuses to start with bad configuration, and settings come from the environment. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { RegistryError } from "../src/registry.js";
import { loadSettings, PROJECT_ROOT } from "../src/settings.js";

function writeSources(secretEnv: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-")), "sources.yaml");
  const source = { id: "s", type: "generic", service: "x", owner_team: "t", secret_env: secretEnv, scenario: "demo" };
  fs.writeFileSync(file, YAML.stringify({ sources: [source] }));
  return file;
}

it("a missing secret stops startup", async () => {
  delete process.env.SRC_TEST_NOT_SET;
  const settings = loadSettings({ database_url: "", sources_path: writeSources("SRC_TEST_NOT_SET") }, {});
  await expect(createApp({ settings })).rejects.toThrow(RegistryError);
  await expect(createApp({ settings })).rejects.toThrow(/SRC_TEST_NOT_SET/);
});

it("starts with the registry from settings", async () => {
  process.env.SRC_TEST_SET = "secret";
  const app = await createApp({ settings: loadSettings({ database_url: "", sources_path: writeSources("SRC_TEST_SET") }, {}) });
  expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
  expect(app.state.registry.get("s")).toBeDefined();
  await app.close();
});

it("a broken playbook stops startup", async () => {
  process.env.SRC_TEST_SET = "secret";
  const playbook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-")), "playbook.yaml");
  fs.writeFileSync(playbook, "rules:\n  - {match: '([', cause: c, fix: f}\n");
  const settings = loadSettings({ database_url: "", sources_path: writeSources("SRC_TEST_SET"), playbook_path: playbook }, {});
  await expect(createApp({ settings })).rejects.toThrow();
});

it("settings defaults", () => {
  const s = loadSettings({}, {});
  expect([s.max_tool_calls, s.max_investigation_sec, s.dedup_ttl_min]).toEqual([10, 180, 15]);
  expect(s.sources_path).toBe(path.join(PROJECT_ROOT, "config", "sources.yaml"));
  expect(s.database_url).toBe("sqlite:///data/triage.db");
  expect(s.demo_mode).toBe(false);
});

it("settings read from the environment (same names as the Python app)", () => {
  const s = loadSettings({}, { DEDUP_TTL_MIN: "3", MAX_TOOL_CALLS: "2", DEMO_MODE: "true", DATABASE_URL: "" });
  expect([s.dedup_ttl_min, s.max_tool_calls, s.demo_mode, s.database_url]).toEqual([3, 2, true, ""]);
});

it("the project root is the repository root (shared config)", () => {
  expect(fs.existsSync(path.join(PROJECT_ROOT, "config", "sources.yaml"))).toBe(true);
  expect(fs.existsSync(path.join(PROJECT_ROOT, "sample_app", "shop.py"))).toBe(true);
});
