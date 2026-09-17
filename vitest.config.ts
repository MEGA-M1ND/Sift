import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Parser tests need a DOM; the client tests do not care.
    environment: "happy-dom",
  },
});
