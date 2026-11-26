/** Suggested fixes from config/playbook.yaml: the first rule whose pattern matches the alert wins. */

import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import type { NormalizedAlert, Suggestion } from "./models.js";

const RuleSchema = z.object({ match: z.string(), cause: z.string(), immediate: z.string().default(""), fix: z.string() });
export type Rule = z.infer<typeof RuleSchema> & { pattern: RegExp };

export function loadPlaybook(file: string): Rule[] {
  const data = YAML.parse(fs.readFileSync(file, "utf8"));
  // A broken pattern fails at startup, not on the first alert.
  return z.array(RuleSchema).parse(data.rules).map((r) => ({ ...r, pattern: new RegExp(r.match, "i") }));
}

export function suggest(alert: NormalizedAlert, rules: Rule[]): Suggestion | null {
  const text = [alert.title, alert.labels.error ?? "", alert.description].join("\n");
  for (const rule of rules) {
    if (rule.pattern.test(text)) return { cause: rule.cause, immediate: rule.immediate || rule.fix, fix: rule.fix };
  }
  return null;
}
