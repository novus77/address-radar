import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const protectedFiles = [
  "apps/console/src/application.ts",
  "apps/scanner/src/source-recovery-handlers.ts",
  "apps/wallet-analysis/src/history.ts",
  "packages/database/src/trader-automation-store.ts",
];

describe("shared database transaction boundaries", () => {
  it("prevents direct write transactions outside the shared wrapper", () => {
    const violations = protectedFiles.filter((file) =>
      readFileSync(resolve(process.cwd(), file), "utf8").includes('BEGIN IMMEDIATE'),
    );
    expect(violations).toEqual([]);
  });
});
