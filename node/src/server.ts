/** Starts the web server: PORT (default 8000) on all interfaces. */

import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8000);
const app = await createApp({ logger: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
await app.listen({ port, host: "0.0.0.0" });
