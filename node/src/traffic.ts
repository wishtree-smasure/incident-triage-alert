/** Keeps the most recent API calls for the API analysis tab: in memory, and in the database if one is set. */

import type { Database } from "./db.js";
import type { ApiCall } from "./models.js";

export const MAX_CALLS = 200_000; // oldest calls are dropped first

export class TrafficStore {
  calls: ApiCall[] = [];
  /** Bumped on every change, so cached analysis knows when to recompute. */
  version = 0;

  constructor(
    readonly maxCalls: number = MAX_CALLS,
    readonly db: Database | null = null,
  ) {}

  async load(): Promise<this> {
    if (this.db) this.calls = await this.db.loadCalls(this.maxCalls);
    this.version++;
    return this;
  }

  async add(calls: ApiCall[]): Promise<void> {
    this.calls.push(...calls);
    if (this.calls.length > this.maxCalls) this.calls.splice(0, this.calls.length - this.maxCalls);
    this.version++;
    if (this.db) await this.db.addCalls(calls, this.maxCalls);
  }

  forApp(app: string): ApiCall[] {
    return this.calls.filter((c) => c.app === app);
  }

  apps(): string[] {
    return [...new Set(this.calls.map((c) => c.app))].sort();
  }
}
