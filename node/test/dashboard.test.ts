import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VerdictSchema } from "../src/models.js";
import { loadSamples, makeApp, postSigned, type TestApp } from "./helpers.js";

/** Alert titles in the alert list, in display order. */
function titles(page: string): string[] {
  const list = page.split('id="alert-list"')[1] ?? "";
  return [...list.matchAll(/class="item-title">([^<]+)<\/span>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
async function sendGeneric(app: TestApp, payload: Record<string, unknown>): Promise<string> {
  return (await postSigned(app, "inhouse-app", { fired_at: "2026-11-20T06:00:00Z", ...payload })).json().investigation_id;
}
const get = async (app: TestApp, url: string) => (await app.inject(url)).body;

describe("with all the sample alerts (several apps, all four sources)", () => {
  let client: TestApp;
  beforeAll(async () => {
    client = await makeApp();
    for (const s of loadSamples()) await postSigned(client, s.source_id, s.payload);
  });
  afterAll(() => client.close());

  it("show stoppers on top with the immediate action", async () => {
    const stoppers = (await get(client, "/")).split("Show stoppers ·")[1].split('class="filter-row"')[0];
    expect(stoppers).toContain("auth-gateway 401/403 rate high");
    expect(stoppers).toContain("NullPointerException");
    expect(stoppers).toContain("Immediate action:");
    expect(stoppers).toContain("Restore the removed role assignment");
    expect(stoppers).not.toContain("5xx rate"); // SEV2 is not a show stopper
  });

  it("applications listed", async () => {
    const apps = (await get(client, "/")).split('name="app"')[1].split("</select>")[0];
    for (const name of ["checkout-api", "orders-service", "auth-gateway", "billing-service", "reporting-service"]) expect(apps).toContain(name);
  });

  it("sources use display names", async () => {
    const page = await get(client, "/");
    for (const name of ["Azure prod", "AWS prod", "Datadog prod", "In-house logs"]) expect(page).toContain(name);
  });

  it("alerts sorted by priority", async () => {
    const page = await get(client, "/");
    const labels = [...page.matchAll(/<h3 class="group[^"]*">([^<]+?) <span/g)].map((m) => m[1]);
    expect(labels).toEqual(["SEV1 · Show stopper", "SEV2 · High", "Unrated · needs triage", "SEV3 · Medium", "SEV4 · Low"]);
    const t = titles(page);
    expect(t.indexOf("auth-gateway 401/403 rate high")).toBeLessThan(t.indexOf("Disk usage above 85% on report-worker"));
  });

  it("filter by application", async () => {
    const t = titles(await get(client, "/?app=auth-gateway"));
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.includes("auth-gateway"))).toBe(true);
  });

  it("filter by source", async () => {
    expect(new Set(titles(await get(client, "/?source=cloudwatch-prod")))).toEqual(new Set(["orders-service-p99-latency", "orders-db-connections-max"]));
  });

  it("filter by level keeps the other filters", async () => {
    const page = await get(client, "/?app=auth-gateway&level=warning");
    const t = titles(page);
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toContain("auth-gateway 401/403 rate high");
    expect(page).toContain('<option value="auth-gateway" selected>');
    expect(page).toMatch(/name="level" value="warning" form="filters" checked/);
  });

  it("unknown filters show the empty state", async () => {
    expect(await get(client, "/?app=no-such-app")).toContain("No alerts match these filters");
    expect(await get(client, "/?source=no-such-source")).toContain("No alerts match these filters");
  });

  it("an invalid level is ignored", async () => {
    expect(titles(await get(client, "/?level=bogus"))).toEqual(titles(await get(client, "/")));
  });

  it("show stoppers stay visible when filtering another app", async () => {
    const page = await get(client, "/?app=reporting-service");
    expect(page).toContain("Show stoppers ·");
    expect(page).toContain("auth-gateway 401/403 rate high");
  });

  it("counts follow the selected app", async () => {
    const page = await get(client, "/?app=orders-service");
    expect(page).toContain("Showing 2 alerts");
    expect(page).toMatch(/<span>All <b>2<\/b><\/span>/);
  });

  it("search matches title, app and file", async () => {
    expect(titles(await get(client, "/?q=401/403"))).toEqual(["auth-gateway 401/403 rate high"]);
    const t = new Set(titles(await get(client, "/?q=ORDERS-SERVICE"))); // case-insensitive, matches the app
    expect(t.has("orders-service-p99-latency") && t.has("orders-db-connections-max")).toBe(true);
    expect(await get(client, "/?q=zzz-nothing")).toContain("No alerts match these filters");
  });

  it("partial returns only the live part", async () => {
    const page = await get(client, "/?app=auth-gateway&partial=1");
    expect(page.replace(/^\s*\{#[\s\S]*?#\}/, "").trimStart().startsWith('<div id="alerts-live"')).toBe(true);
    expect(page).not.toContain("<html");
    expect(page).toContain("Show stoppers ·");
    expect(titles(page).every((t) => t.includes("auth-gateway"))).toBe(true);
  });

  it("the Alerts view updates itself without a meta refresh", async () => {
    const page = await get(client, "/");
    expect(page).toContain('id="live-region"');
    expect(page).toContain("refresh(false)");
    expect(page).toContain('<noscript><meta http-equiv="refresh" content="10"></noscript>');
  });

  it("the detail page auto-refreshes while queued", async () => {
    const inv = client.state.store.newestFirst()[0];
    expect(await get(client, `/investigations/${inv.id}`)).toContain('http-equiv="refresh" content="5"');
  });

  it("the detail page shows the AI verdict instead of the playbook", async () => {
    const inv = client.state.store.newestFirst()[0];
    inv.status = "concluded";
    inv.verdict = VerdictSchema.parse({
      investigation_id: inv.id, status: "concluded", severity: "SEV2", category: "deployment",
      summary: "Deploy broke checkout.", root_cause: "Deploy v2.14.0 introduced a null pointer.", confidence: "high",
      evidence: [{ claim: "NPE starts at deploy time", tool_call_id: "tc_3" }],
      next_checks: ["Roll back to v2.13.2"], ruled_out: ["Database is healthy"],
    });
    const page = await get(client, `/investigations/${inv.id}`);
    for (const text of ["Deploy v2.14.0 introduced a null pointer.", "tc_3", "Roll back to v2.13.2", "Database is healthy"]) expect(page).toContain(text);
    expect(page).not.toContain("Proper fix:"); // the verdict replaces the playbook suggestion
    expect(page).not.toContain('http-equiv="refresh"'); // finished: no more auto-refresh
  });

  it("an unknown investigation shows a friendly page", async () => {
    const r = await client.inject("/investigations/doesnotexist");
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain("This alert is no longer here");
    expect(r.body).toContain('href="/"');
    expect(r.body).toContain("set <code>DATABASE_URL</code>"); // memory only: explains how to keep alerts
  });
});

it("empty dashboard", async () => {
  const app = await makeApp();
  const page = await get(app, "/");
  expect(page).toContain("Nothing here yet");
  expect(page).not.toContain("Show stoppers ·");
  await app.close();
});

describe("safety and edge cases", () => {
  it("HTML in an alert is escaped (it comes from outside, so it must never run)", async () => {
    const app = await makeApp();
    const id = await sendGeneric(app, { title: "<script>alert(1)</script>", severity: "SEV1", description: "<img src=x onerror=alert(2)>", service: "<b>app</b>" });
    for (const page of [await get(app, "/"), await get(app, `/investigations/${id}`)]) {
      expect(page).not.toContain("<script>alert(1)</script>");
      expect(page).toContain("&lt;script&gt;");
      expect(page).not.toContain("<img src=x");
      expect(page).not.toContain("<b>app</b>");
    }
    await app.close();
  });

  it("app names are escaped in the filters", async () => {
    const app = await makeApp();
    await sendGeneric(app, { title: "x", service: "team a&b" });
    expect(await get(app, "/")).toContain('<option value="team a&amp;b"');
    expect(titles(await get(app, "/?app=team%20a%26b"))).toEqual(["x"]);
    await app.close();
  });

  it("an alert without a playbook match", async () => {
    const app = await makeApp();
    const id = await sendGeneric(app, { title: "Something nobody has seen before" });
    expect(await get(app, "/")).toContain("No suggestion");
    expect(await get(app, `/investigations/${id}`)).toContain("No playbook rule matches");
    await app.close();
  });

  it("a show stopper without a playbook match says to page the owner", async () => {
    const app = await makeApp();
    await sendGeneric(app, { title: "Mystery outage", severity: "SEV1", service: "mystery-app" });
    expect(await get(app, "/")).toContain("page the mystery-app on-call owner");
    await app.close();
  });

  it("the Where line shows the code location with a Copy button", async () => {
    const app = await makeApp();
    await postSigned(app, "datadog-prod", loadSamples().find((s) => JSON.stringify(s.payload).includes("PaymentClient.java"))!.payload);
    const page = await get(app, "/");
    expect(page).toContain("<code>com/shop/payment/PaymentClient.java:88</code>");
    expect(page).toContain('data-copy="com/shop/payment/PaymentClient.java:88"');
    const id = app.state.store.newestFirst()[0].id;
    const detail = await get(app, `/investigations/${id}`);
    expect(detail).toContain("PaymentClient.authorize()");
    expect(detail).toContain("src/main/java/");
    await app.close();
  });
});
