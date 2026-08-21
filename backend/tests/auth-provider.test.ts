import { afterEach, describe, expect, test, vi } from "vitest";

import { SupabaseAuthProvider } from "../src/auth/provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Supabase Auth provider", () => {
  test("revokes only the redundant provider session", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SupabaseAuthProvider({
      url: "https://provider.example.test",
      anonKey: "synthetic-anon-key",
      serviceRoleKey: "synthetic-service-key",
    });

    await expect(provider.revokeSession("synthetic-access-token")).resolves.toBe("revoked");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.test/auth/v1/logout?scope=local",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer synthetic-access-token" }),
      }),
    );
  });
});
