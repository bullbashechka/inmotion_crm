import { describe, expect, test } from "vitest";

import {
  canonicalizeEmail,
  canonicalizeLogin,
  canonicalizeUsername,
  createAuthTokenCipher,
  createOpaqueToken,
  hashSecret,
  secretsEqual,
} from "../src/auth/crypto";

describe("auth secret primitives", () => {
  test("creates opaque high-entropy tokens and compares their digests", async () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
    expect(secretsEqual(await hashSecret(first), await hashSecret(first))).toBe(true);
    expect(secretsEqual(await hashSecret(first), await hashSecret(second))).toBe(false);
  });

  test("encrypts provider refresh tokens with authenticated encryption", async () => {
    const cipher = await createAuthTokenCipher("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const encrypted = await cipher.encrypt("provider-refresh-token");

    expect(encrypted).not.toContain("provider-refresh-token");
    await expect(cipher.decrypt(encrypted)).resolves.toBe("provider-refresh-token");
    await expect(cipher.decrypt(`${encrypted}x`)).rejects.toThrow();
  });

  test("keeps provider email canonicalization separate from CRM usernames", () => {
    expect(canonicalizeEmail("  First.Last+test@Example.COM ")).toBe("first.last+test@example.com");
    expect(canonicalizeLogin("doctor@example")).toBeNull();
    expect(canonicalizeUsername("  Nurpeisova.A  ")).toBe("nurpeisova.a");
    expect(canonicalizeUsername("doctor@example.com")).toBeNull();
    expect(canonicalizeUsername("доктор")).toBeNull();
    expect(canonicalizeUsername("ab")).toBeNull();
  });
});
