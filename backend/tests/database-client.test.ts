import { describe, expect, test } from "vitest";

import { withClosableClient } from "../src/db/lifecycle";

describe("request-scoped database lifecycle", () => {
  test("closes a connected client after success", async () => {
    const calls: string[] = [];
    const client = { connect: async () => { calls.push("connect"); }, end: async () => { calls.push("end"); } };
    await expect(withClosableClient(client, async () => "done")).resolves.toBe("done");
    expect(calls).toEqual(["connect", "end"]);
  });

  test("closes a connected client after callback failure", async () => {
    const calls: string[] = [];
    const client = { connect: async () => { calls.push("connect"); }, end: async () => { calls.push("end"); } };
    await expect(withClosableClient(client, async () => { throw new Error("query failed"); })).rejects.toThrow("query failed");
    expect(calls).toEqual(["connect", "end"]);
  });
});
