import { describe, expect, test } from "vitest";

import { createUuidV7, createUuidV7Generator } from "../src/db/uuidv7";

describe("UUIDv7", () => {
  test("creates RFC-compatible UUIDv7 values", () => {
    const value = createUuidV7();
    const bytes = value.replaceAll("-", "");

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(bytes.slice(12, 13), 16)).toBe(7);
    expect(Number.parseInt(bytes.slice(16, 17), 16) & 0b1100).toBe(0b1000);
  });

  test("is unique and lexically monotonic within a process", () => {
    const values = Array.from({ length: 10_000 }, () => createUuidV7());

    expect(new Set(values)).toHaveLength(values.length);
    expect(values).toEqual([...values].sort());
  });

  test("encodes the maximum 48-bit timestamp exactly", () => {
    const create = createUuidV7Generator({ now: () => 0xffff_ffff_ffff, randomBytes: (length) => new Uint8Array(length) });
    expect(create().slice(0, 13)).toBe("ffffffff-ffff");
  });

  test("remains monotonic when the clock moves backwards", () => {
    const values = [100, 99, 99];
    const create = createUuidV7Generator({ now: () => values.shift() ?? 99, randomBytes: (length) => new Uint8Array(length) });
    const generated = [create(), create(), create()];
    expect(generated).toEqual([...generated].sort());
    expect(generated[0]?.slice(0, 13)).toBe("00000000-0064");
  });

  test("advances to the next millisecond after 12-bit sequence overflow", () => {
    const create = createUuidV7Generator({ now: () => 1_000, randomBytes: (length) => new Uint8Array(length).fill(0xff) });
    const first = create();
    const values = Array.from({ length: 4096 }, () => create());
    const overflow = values.at(-1);
    expect(first < overflow!).toBe(true);
    expect(overflow?.slice(0, 13)).toBe("00000000-03e9");
  });
});
