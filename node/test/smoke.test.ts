import { expect, it } from "vitest";
import { loadSamples, makeApp, postSigned } from "./helpers.js";

it("renders every page", async () => {
  const app = await makeApp();
  for (const s of loadSamples()) expect((await postSigned(app, s.source_id, s.payload)).statusCode).toBe(202);
  for (const url of ["/", "/?partial=1", "/?view=analysis", "/?q=checkout&level=alert", "/investigations/x"]) {
    const r = await app.inject(url);
    expect(r.statusCode, url).toBeLessThan(500);
  }
  const id = app.state.store.newestFirst()[0].id;
  expect((await app.inject(`/investigations/${id}`)).statusCode).toBe(200);
});
