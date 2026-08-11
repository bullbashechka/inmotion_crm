import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const drizzleDirectory = join(root, "drizzle");
const journal = JSON.parse(await readFile(join(drizzleDirectory, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
const numberedFiles = (await readdir(drizzleDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const tags = journal.entries.map((entry) => entry.tag);
if (new Set(tags).size !== tags.length || tags.length !== numberedFiles.length || tags.some((tag, index) => tag !== numberedFiles[index]?.replace(/\.sql$/, "") || Number(tag.slice(0, 4)) !== index)) {
  throw new Error("Drizzle journal and numbered migration files must match exactly with strict ordinals.");
}

const temporaryDirectory = await mkdtemp(join(root, ".schema-check-"));
try {
  await cp(drizzleDirectory, temporaryDirectory, { recursive: true });
  const configPath = join(temporaryDirectory, "drizzle.config.ts");
  await writeFile(configPath, `import { defineConfig } from 'drizzle-kit'; export default defineConfig({ dialect: 'postgresql', schema: '${join(root, "src", "db", "schema.ts").replaceAll("\\", "/")}', out: '${temporaryDirectory.replaceAll("\\", "/")}', strict: true });`);
  const child = Bun.spawn([process.execPath, "x", "drizzle-kit", "generate", "--config", configPath], { stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error("Drizzle schema generation failed during drift check.");
  const after = (await readdir(temporaryDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  if (after.length !== numberedFiles.length) throw new Error("schema.ts differs from the committed Drizzle migration snapshot.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
console.log("Drizzle journal, migration catalog, and schema snapshot are aligned.");
