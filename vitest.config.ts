import { defineConfig } from "vitest/config";

/**
 * Vitest config for JuneClaw.
 *
 * Conventions:
 * - Colocated tests: `foo.test.ts` lives next to `foo.ts`.
 * - Unit tests must not touch the network, filesystem (except fixtures),
 *   or subprocess APIs. Use `globalThis.fetch = vi.fn()` to stub HTTP.
 * - Integration tests (future) go under `src/**\/*.int.test.ts` and are
 *   opt-in via `INTEGRATION=1`.
 * - No test should rely on wall-clock time. Use `vi.useFakeTimers()`.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts", "node_modules", "dist"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Scope coverage to areas that actually have tests. Add more globs
      // here as you add tests to new modules — don't broaden prematurely
      // and drown the signal in zeros.
      include: ["src/bridge/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.int.test.ts",
        "src/**/types.ts",
        "dist/**",
      ],
      // Thresholds are pinned slightly below current levels so the bar goes
      // up over time. Raise these when you add tests; don't lower them to
      // unblock a regression.
      thresholds: {
        lines: 85,
        functions: 80,
        branches: 60,
        statements: 80,
      },
    },
  },
});
