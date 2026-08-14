import { describe, expect, test } from "vitest";

import { createRequestFingerprint } from "../src/db/integrity";

describe("integrity command helpers", () => {
  test("fingerprints semantically equal request objects deterministically", async () => {
    await expect(createRequestFingerprint({ patientId: "patient-1", fields: { givenName: "Алия", familyName: "Сейтова" } })).resolves.toBe(
      await createRequestFingerprint({ fields: { familyName: "Сейтова", givenName: "Алия" }, patientId: "patient-1" }),
    );
  });

  test("fingerprints a different command payload differently", async () => {
    await expect(createRequestFingerprint({ amount: 1000 })).resolves.not.toBe(await createRequestFingerprint({ amount: 1001 }));
  });
});
