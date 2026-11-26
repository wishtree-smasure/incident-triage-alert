/** Settings read from environment variables / the .env file (same names as the Python app). */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The node/ folder: source runs from node/src, compiled code from node/dist/src. */
export const NODE_ROOT = path.resolve(HERE, HERE.split(path.sep).includes("dist") ? "../.." : "..");
/** The repository root: config/, fixtures/ and sample_app/ are shared with the Python app. */
export const PROJECT_ROOT = path.dirname(NODE_ROOT);

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().int());

const SettingsSchema = z.object({
  anthropic_api_key: z.string().default(""),
  llm_model: z.string().default("claude-sonnet-4-5"),
  max_tool_calls: int.default(10),
  max_investigation_sec: int.default(180),
  dedup_ttl_min: int.default(15),
  teams_webhook_url: z.string().default(""),
  app_base_url: z.string().default("http://localhost:8000"),
  // Where alerts and API calls are saved (see db.ts). Empty = memory only.
  database_url: z.string().default("sqlite:///data/triage.db"),
  demo_mode: bool.default(false), // run the sample shop + log watcher with the app (for a deployed demo)
  sources_path: z.string().default(path.join(PROJECT_ROOT, "config", "sources.yaml")),
  playbook_path: z.string().default(path.join(PROJECT_ROOT, "config", "playbook.yaml")),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Settings from the environment (after loading .env), with explicit overrides on top. */
export function loadSettings(overrides: Partial<Settings> = {}, env: NodeJS.ProcessEnv = process.env): Settings {
  const fromEnv: Record<string, string> = {};
  for (const key of Object.keys(SettingsSchema.shape)) {
    const value = env[key.toUpperCase()];
    if (value !== undefined) fromEnv[key] = value;
  }
  return SettingsSchema.parse({ ...fromEnv, ...overrides });
}

/** Makes SRC_*_SECRET etc. from the repository's .env available (never overrides real env vars). */
export function loadDotenv(): void {
  dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true } as dotenv.DotenvConfigOptions);
}
