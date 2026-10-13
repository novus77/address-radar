import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findRepositoryBoundaryViolations } from "../../scripts/check-boundaries.js";

describe("repository boundaries", () => {
  it("does not depend on browser extension, licensing, or customer gateway code", async () => {
    await expect(findRepositoryBoundaryViolations()).resolves.toEqual([]);
  });
});

async function withRepository(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "address-radar-boundaries-"));
  try { await operation(root); } finally { await rm(root, { recursive: true, force: true }); }
}

it("excludes only root migration artifact mkdtemp directories while preserving real violations", async () => {
  await withRepository(async root => {
    await mkdir(join(root, ".migration-artifact-test-Ab12Cd"));
    await writeFile(join(root, ".migration-artifact-test-Ab12Cd/source-catalog.json"), JSON.stringify({ source: "src/licensing/private.ts" }));
    await mkdir(join(root, "apps/scanner/src"), { recursive: true });
    await writeFile(join(root, "apps/scanner/src/real.ts"), 'import "src/licensing/private.js";');
    expect(await findRepositoryBoundaryViolations(root)).toEqual([
      { path: "apps/scanner/src/real.ts", reason: "forbidden dependency reference: src/licensing/" },
    ]);
  });
});

it("does not exempt lookalike directories, nested source directories, or ordinary files", async () => {
  await withRepository(async root => {
    const paths = [".migration-artifact-test-Ab12Cd-source/real.ts", "apps/scanner/.migration-artifact-test-Ab12Cd/real.ts",
      ".migration-artifact-test-Ab12Cd.json"];
    for (const path of paths) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), '"src/licensing/private.ts"');
    }
    const violations = await findRepositoryBoundaryViolations(root);
    expect(violations.map(item => item.path).sort()).toEqual([...paths].sort());
    expect(violations.every(item => item.reason === "forbidden dependency reference: src/licensing/")).toBe(true);
  });
});
