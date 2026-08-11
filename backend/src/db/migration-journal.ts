export type MigrationJournalEntry = { filename: string; checksum: string; state: "running" | "applied" };

export function validateMigrationCatalog<T extends { filename: string }>(migrations: readonly T[]): void {
  const names = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    if (!/^\d{4}_.+\.sql$/.test(migration.filename) || Number(migration.filename.slice(0, 4)) !== index || names.has(migration.filename)) {
      throw new Error("Migration catalog must have unique contiguous ordinals from 0000 in filename order.");
    }
    names.add(migration.filename);
  }
}

export function validateMigrationJournal<T extends { filename: string }>(migrations: readonly T[], journal: readonly MigrationJournalEntry[]): Map<string, string> {
  validateMigrationCatalog(migrations);
  const applied = new Map<string, string>();
  for (const [index, entry] of journal.entries()) {
    const expected = migrations[index];
    if (expected?.filename !== entry.filename) throw new Error(`Applied migration ${entry.filename} is missing, out of order, or was renamed.`);
    if (entry.state === "running") throw new Error(`Migration ${entry.filename} is running and requires manual reconciliation before retry.`);
    applied.set(entry.filename, entry.checksum);
  }
  return applied;
}
