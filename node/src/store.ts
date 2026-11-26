/** Keeps the last 200 investigations for the dashboard: in memory, and in the database if one is set. */

import type { Database } from "./db.js";
import type { Investigation } from "./models.js";

export const MAX_ITEMS = 200;

export class InvestigationStore {
  readonly items = new Map<string, Investigation>(); // Maps keep insertion order

  constructor(readonly db: Database | null = null) {}

  async load(): Promise<this> {
    if (this.db) for (const inv of await this.db.loadInvestigations(MAX_ITEMS)) this.items.set(inv.id, inv);
    return this;
  }

  async add(investigation: Investigation): Promise<void> {
    this.items.set(investigation.id, investigation);
    await this.save(investigation);
    if (this.items.size > MAX_ITEMS) {
      const oldest = this.items.keys().next().value as string;
      this.items.delete(oldest);
      if (this.db) await this.db.deleteInvestigation(oldest);
    }
  }

  /** Call after changing an investigation (repeat count, status, verdict) so the change is kept. */
  async save(investigation: Investigation): Promise<void> {
    if (this.db) await this.db.saveInvestigation(investigation);
  }

  get(id: string): Investigation | undefined {
    return this.items.get(id);
  }

  newestFirst(): Investigation[] {
    return [...this.items.values()].reverse();
  }
}
