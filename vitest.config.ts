import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Phase 20 - global Redis/QStash mocks shared by every integration
    // test file (see vitest.setup.ts's own header comment). The
    // integration suites themselves additionally require DATABASE_URL /
    // ENCRYPTION_KEY (a real Postgres) and skip themselves cleanly via
    // describe.skipIf when those aren't set - see docs/TESTING.md.
    setupFiles: ["./vitest.setup.ts"],
    // These are integration tests sharing one real Postgres database -
    // running test FILES in their own isolated processes (default) is
    // fine, but keep it explicit and bounded rather than relying on
    // whatever default pool size vitest picks, since a large number of
    // concurrent short-lived Postgres connections is exactly the kind of
    // thing worth capping deliberately for a local dev/test database.
    poolOptions: {
      threads: { maxThreads: 4 },
      forks: { maxForks: 4 },
    },
  },
});
