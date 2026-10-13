import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../inspect-full-preservation-bundle.py", import.meta.url));
describe("read-only authenticated preparation size inventory", () => {
  it("refuses an unpinned manifest before visiting chunk paths", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "radar-inventory-"));
    try {
      await writeFile(join(root, "manifest.json"), "{}", { mode: 0o600 });
      expect(() => execFileSync("python3", [script, "--root", root], { timeout: 3000, stdio: "pipe" })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses ambiguous locations and symlink roots without connecting or changing source", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "radar-inventory-"));
    try {
      expect(() => execFileSync("python3", [script, "--root", root], { timeout: 3000, stdio: "pipe" })).toThrow();
      const link = root + "-link"; await symlink(root, link);
      try { expect(() => execFileSync("python3", [script, "--root", link], { timeout: 3000, stdio: "pipe" })).toThrow(); }
      finally { await rm(link); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
