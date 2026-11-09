import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The obsidian package has no runtime code; a suite that needs more than `Platform` mocks it itself.
  resolve: { alias: { obsidian: fileURLToPath(new URL("./tests/support/obsidian-stub.ts", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: true,
  },
});
