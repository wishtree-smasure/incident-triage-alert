/** Source Registry: reads config/sources.yaml and checks it at startup. */

import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";

export class RegistryError extends Error {
  name = "RegistryError";
}

export const SourceSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""), // shown on the dashboard, e.g. "Azure prod"; defaults to the id
    type: z.enum(["azure_monitor", "cloudwatch", "datadog", "generic"]),
    service: z.string(),
    owner_team: z.string(),
    secret_env: z.string(),
    connector: z.enum(["mock", "real"]).default("mock"),
    scenario: z.string().nullable().default(null),
  })
  .strict()
  .refine((s) => s.connector !== "mock" || !!s.scenario, "'scenario' is required when connector is 'mock'");
export type Source = z.infer<typeof SourceSchema>;

export class Registry {
  readonly sources: Map<string, Source>;
  private readonly secrets: Map<string, string>;

  constructor(sources: Source[], env: Record<string, string | undefined> = process.env) {
    this.sources = new Map(sources.map((s) => [s.id, s]));
    if (this.sources.size !== sources.length) throw new RegistryError("sources.yaml has duplicate source ids");
    const missing = sources.filter((s) => !env[s.secret_env]).map((s) => s.secret_env);
    if (missing.length) throw new RegistryError(`missing secret env vars: ${missing.join(", ")}`);
    this.secrets = new Map(sources.map((s) => [s.id, env[s.secret_env] as string]));
  }

  get(sourceId: string): Source | undefined {
    return this.sources.get(sourceId);
  }

  nameOf(sourceId: string): string {
    const source = this.sources.get(sourceId);
    return source ? source.name || source.id : sourceId;
  }

  secretFor(sourceId: string): string {
    const secret = this.secrets.get(sourceId);
    if (secret === undefined) throw new RegistryError(`unknown source ${sourceId}`);
    return secret;
  }
}

export function loadRegistry(file: string, env: Record<string, string | undefined> = process.env): Registry {
  let sources: Source[];
  try {
    const data = YAML.parse(fs.readFileSync(file, "utf8"));
    sources = z.array(SourceSchema).parse(data.sources);
  } catch (e) {
    throw new RegistryError(`invalid source registry ${file}: ${(e as Error).message}`);
  }
  return new Registry(sources, env);
}
