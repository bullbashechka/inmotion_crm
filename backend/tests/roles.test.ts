import { describe, expect, test } from "vitest";

import { parseRecordScope } from "../src/access/control";

describe("role revision input", () => {
  test("accepts only the closed record-scope vocabulary", () => {
    expect(parseRecordScope({ records: "all" })).toBe("all");
    expect(parseRecordScope({ records: "assigned" })).toBe("assigned");
    expect(parseRecordScope({ records: "patient" })).toBeNull();
    expect(parseRecordScope(null)).toBeNull();
  });
});
