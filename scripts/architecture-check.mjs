import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const webappSource = join(root, "webapp", "src");
const backendSource = join(root, "backend", "src");
const sourceFiles = [];
const backendFiles = [];
const webappApiAdapters = new Set([
  "webapp/src/lib/api.ts",
  "webapp/src/lib/auth.ts",
]);

async function collectFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      sourceFiles.push(path);
    }
  }
}

await collectFiles(webappSource);

async function collectBackendFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectBackendFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      backendFiles.push(path);
    }
  }
}

await collectBackendFiles(backendSource);

const violations = [];
for (const file of sourceFiles) {
  const contents = await readFile(file, "utf8");
  const displayPath = relative(root, file).replaceAll("\\", "/");

  if (/@supabase\/|from ["'](?:pg|postgres|@cloudflare\/workers)/.test(contents)) {
    violations.push(`${displayPath}: браузер не может обращаться к инфраструктуре данных.`);
  }

  if (/VITE_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/.test(contents)) {
    violations.push(`${displayPath}: секрет нельзя включать в клиентскую сборку.`);
  }

  if (!webappApiAdapters.has(displayPath) && /\bfetch\s*\(/.test(contents)) {
    violations.push(`${displayPath}: запросы к API должны проходить через выделенный lib API-адаптер.`);
  }
}

for (const file of backendFiles) {
  const contents = await readFile(file, "utf8");
  const displayPath = relative(root, file).replaceAll("\\", "/");
  if (displayPath !== "backend/src/http/route-policy.ts" && /\b(?:app|router)\.openapi\s*\(/.test(contents)) {
    violations.push(`${displayPath}: OpenAPI routes must be registered through http/route-policy.ts.`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries are valid.");
}
