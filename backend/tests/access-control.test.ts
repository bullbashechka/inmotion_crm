import { describe, expect, test } from "vitest";

import { includesScope, resolveEffectivePermissions } from "../src/access/control";

describe("effective permissions", () => {
  test("unions role scopes but lets explicit DENY remove a permission", () => {
    const effective = resolveEffectivePermissions([
      { permissionCode: "medical.read", scope: { records: "assigned" } },
      { permissionCode: "medical.read", scope: { records: "all" } },
      { permissionCode: "schedule.read", scope: { records: "own" } },
    ], [
      { permissionCode: "medical.read", mode: "deny", scope: null },
    ]);

    expect(effective.has("medical.read")).toBe(false);
    expect(effective.get("schedule.read")).toBe("own");
  });

  test("REPLACE narrows role scope and malformed scopes never grant access", () => {
    const effective = resolveEffectivePermissions([
      { permissionCode: "medical.read", scope: { records: "all" } },
      { permissionCode: "financial.read", scope: { records: "everything" } },
    ], [
      { permissionCode: "medical.read", mode: "replace", scope: { records: "assigned" } },
    ]);

    expect(effective.get("medical.read")).toBe("assigned");
    expect(effective.has("financial.read")).toBe(false);
    expect(includesScope("assigned", "own")).toBe(true);
    expect(includesScope("assigned", "all")).toBe(false);
  });
});
