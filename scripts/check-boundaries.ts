import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", "test-results"]);
const ignoredFiles = new Set([
  "scripts/check-boundaries.ts",
  "tests/architecture/repository-boundaries.test.ts",
]);

const forbiddenPathFragments = [
  "entrypoints/",
  "src/licensing/",
  "src/sidepanel/",
  "tools/license-admin/",
  "tools/radar-server/customer-",
  "wxt.config",
] as const;

const inspectableExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export interface BoundaryViolation {
  path: string;
  reason: string;
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

export async function findRepositoryBoundaryViolations(
  rootDirectory = process.cwd(),
): Promise<BoundaryViolation[]> {
  const violations: BoundaryViolation[] = [];

  for (const file of await collectFiles(rootDirectory)) {
    const path = relative(rootDirectory, file).replaceAll("\\", "/");
    if (ignoredFiles.has(path)) {
      continue;
    }

    for (const fragment of forbiddenPathFragments) {
      if (path.includes(fragment)) {
        violations.push({ path, reason: `forbidden path fragment: ${fragment}` });
      }
    }

    if (!inspectableExtensions.has(extname(path))) {
      continue;
    }

    const content = await readFile(file, "utf8");
    for (const fragment of forbiddenPathFragments) {
      if (content.includes(fragment)) {
        violations.push({ path, reason: `forbidden dependency reference: ${fragment}` });
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const violations = await findRepositoryBoundaryViolations();
  if (violations.length === 0) {
    console.log("Repository boundaries are valid.");
    return;
  }

  for (const violation of violations) {
    console.error(`${violation.path}: ${violation.reason}`);
  }
  process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
