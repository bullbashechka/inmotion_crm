import { describe, expect, test } from "vitest";

import { validateMigrationCatalog, validateMigrationJournal } from "../src/db/migration-journal";

const migration = { filename: "0000_example.sql" };

describe("migration journal state", () => {
  test("refuses to replay a non-transactional running migration", () => {
    expect(() => validateMigrationJournal([migration], [{ filename: migration.filename, checksum: "checksum", state: "running" }])).toThrow("manual reconciliation");
  });

  test("refuses an applied migration absent from the catalog", () => {
    expect(() => validateMigrationJournal([migration], [{ filename: "0000_removed.sql", checksum: "checksum", state: "applied" }])).toThrow("missing, out of order, or was renamed");
  });

  test("requires a continuous catalog prefix in catalog order", () => {
    const second = { filename: "0001_example.sql" };
    expect(() => validateMigrationJournal([migration, second], [{ filename: migration.filename, checksum: "a", state: "applied" }, { filename: second.filename, checksum: "b", state: "applied" }])).not.toThrow();
    const third = { filename: "0002_example.sql" };
    expect(() => validateMigrationJournal([migration, second, third], [{ filename: migration.filename, checksum: "a", state: "applied" }, { filename: third.filename, checksum: "b", state: "applied" }])).toThrow("out of order");
  });

  test("rejects duplicate, gapped, and incorrectly ordered catalog ordinals", () => {
    expect(() => validateMigrationCatalog([{ filename: "0000_a.sql" }, { filename: "0002_b.sql" }])).toThrow("contiguous");
    expect(() => validateMigrationCatalog([{ filename: "0001_a.sql" }, { filename: "0000_b.sql" }])).toThrow("contiguous");
    expect(() => validateMigrationCatalog([{ filename: "0000_a.sql" }, { filename: "0000_a.sql" }])).toThrow("contiguous");
  });
});
