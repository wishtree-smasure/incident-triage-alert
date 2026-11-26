import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests never touch the real database: DATABASE_URL empty = memory only.
    env: { DATABASE_URL: "" },
    coverage: { include: ["src/**"] },
  },
});
