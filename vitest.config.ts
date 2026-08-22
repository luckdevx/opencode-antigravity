import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      // Ratchet thresholds: set just below current measured coverage
      // (lines 46.33, branches 81.15, functions 66.95) to prevent regression.
      // Interactive CLI modules (plugin/ui/*, cli.ts) are untestable unit-wise;
      // raise these as coverage improves.
      thresholds: {
        lines: 45,
        statements: 45,
        branches: 80,
        functions: 65,
      },
    },
  },
});
