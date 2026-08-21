import { describe, expect, test, vi } from "vitest";

import { createApp, type AppDependencies } from "../src/app";
import worker, { loadRequestDatabaseAdapter } from "../src/index";

const runtime = {
  appEnvironment: "local" as const,
  appBuildVersion: "dev",
  supportedClientVersions: ["dev", "previous-build"],
  corsOrigins: ["http://localhost:5173"],
};

const testSession = {
  id: "00000000-0000-7000-8000-000000000011",
  employeeId: "00000000-0000-7000-8000-000000000012",
  state: "active" as const,
  serverNow: "2026-08-13T00:00:00.000Z",
  warningAt: "2026-08-13T00:25:00.000Z",
  idleExpiresAt: "2026-08-13T00:30:00.000Z",
  absoluteExpiresAt: "2026-08-13T12:00:00.000Z",
  revision: 1,
};

const allowAuthRateLimiters = {
  identity: { async limit() { return { success: true }; } },
  source: { async limit() { return { success: true }; } },
};

const authDependencies: AppDependencies = {
  authRateLimiters: allowAuthRateLimiters,
  authService: {
    async authenticate() {
      return {
        employeeId: testSession.employeeId,
        employmentEpochId: "00000000-0000-7000-8000-000000000013",
        session: testSession,
        credentialState: "ready",
      };
    },
    async signIn() {
      return {
        accessToken: "a".repeat(43),
        accessTokenExpiresAt: testSession.idleExpiresAt,
        refreshToken: "b".repeat(43),
        session: testSession,
      };
    },
    async refreshSession() {
      return {
        accessToken: "c".repeat(43),
        accessTokenExpiresAt: testSession.idleExpiresAt,
        refreshToken: "d".repeat(43),
        session: testSession,
      };
    },
    async continueSession() {
      return testSession;
    },
    async revokeSession() {},
    async revokeSessionByRefreshToken() {},
    async changePassword() {},
    async requestPasswordRecovery() {},
    async completePasswordRecovery() {
      return { recoveryGrant: "e".repeat(43), redirectTo: "http://localhost:5173/recovery/reset" };
    },
    async resetPasswordWithRecoveryGrant() {},
  },
};

const employeeDependencies: AppDependencies = {
  ...authDependencies,
  employeeService: {
    async createEmployee() {
      return { employeeId: testSession.employeeId, employmentEpochId: "00000000-0000-7000-8000-000000000013", provisioningState: "pending_activation" as const };
    },
    async listEmployees() {
      return [{
        id: testSession.employeeId,
        fullName: "Алия Сарсенова",
        login: "aliya.sarsenova",
        roles: ["administrator"],
        accessState: "active" as const,
        credentialState: "ready",
        temporaryPasswordExpiresAt: null,
        lastSignInAt: "2026-08-13T00:00:00.000Z",
        version: 1,
      }];
    },
    async getEmployee() {
      return {
        id: testSession.employeeId,
        fullName: "Алия Сарсенова",
        login: "aliya.sarsenova",
        roles: ["administrator"],
        accessState: "active" as const,
        credentialState: "ready",
        temporaryPasswordExpiresAt: null,
        lastSignInAt: "2026-08-13T00:00:00.000Z",
        version: 1,
        recoveryEmail: "aliya@example.test",
        assignedRoles: [{ id: "00000000-0000-7000-8000-000000000401", code: "administrator", source: "Назначено руководителем" }],
        effectivePermissions: [],
        overrides: [],
      };
    },
    async unlockAccount() {},
    async issueTemporaryPassword() {
      return { temporaryPassword: "T-example" };
    },
    async offboardEmployee() {},
    async rehireEmployee() {
      return { employeeId: testSession.employeeId, employmentEpochId: "00000000-0000-7000-8000-000000000013", provisioningState: "pending_activation" as const };
    },
  },
};

describe("system API", () => {
  test("loads the request-scoped database adapter without opening a connection", async () => {
    await expect(loadRequestDatabaseAdapter()).resolves.toMatchObject({ withRequestDatabase: expect.any(Function) });
  });

  test("returns the shared health contract for the current client", async () => {
    const response = await createApp(runtime).request("http://api.test/api/v1/system/health", {
      headers: { "X-Client-Version": "dev" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Correlation-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      apiVersion: "v1",
      environment: "local",
      apiBuild: "dev",
      compatibility: "current",
    });
  });

  test("marks a supported old client for a non-blocking update", async () => {
    const response = await createApp(runtime).request("http://api.test/api/v1/system/health", {
      headers: { "X-Client-Version": "previous-build" },
    });

    await expect(response.json()).resolves.toMatchObject({
      compatibility: "update_available",
    });
  });

  test("allows credentials only for an exact configured origin", async () => {
    const response = await createApp(runtime).request("http://api.test/api/v1/system/health", {
      headers: {
        Origin: "http://localhost:5173",
        "X-Client-Version": "dev",
      },
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  test("does not reflect an origin outside the configured allow-list", async () => {
    const response = await createApp(runtime).request("http://api.test/api/v1/system/health", {
      headers: { Origin: "https://untrusted.example" },
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("rejects a CORS preflight from an untrusted origin", async () => {
    const response = await createApp(runtime).request("http://api.test/api/v1/system/health", {
      method: "OPTIONS",
      headers: { Origin: "https://untrusted.example" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ORIGIN_FORBIDDEN" });
  });

  test("exposes the documented route through the Worker entry point", async () => {
    const response = await worker.fetch(
      new Request("http://api.test/api/v1/system/health", {
        headers: { "X-Client-Version": "dev" },
      }) as never,
      {
        HYPERDRIVE_FRESH: {} as Hyperdrive,
        AUTH_IDENTITY_RATE_LIMITER: allowAuthRateLimiters.identity,
        AUTH_SOURCE_RATE_LIMITER: allowAuthRateLimiters.source,
        APP_ENV: "local",
        APP_BUILD_VERSION: "dev",
        SUPPORTED_CLIENT_VERSIONS: "dev",
        CORS_ORIGINS: "http://localhost:5173",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ apiVersion: "v1" });
  });

  test("keeps refresh credentials in a host-only HttpOnly cookie and out of the JSON response", async () => {
    const response = await createApp(runtime, authDependencies).request("https://api.test/api/v1/auth/sign-in", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ login: "doctor.sarsenov", password: "password", attemptId: "00000000-0000-7000-8000-000000000014" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toBe("__Host-inmotion-refresh=" + "b".repeat(43) + "; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict");
    await expect(response.json()).resolves.toEqual({
      accessToken: "a".repeat(43),
      accessTokenExpiresAt: testSession.idleExpiresAt,
      session: testSession,
    });
  });

  test("revokes the cookie session even when a stale access token is also present", async () => {
    const revokeSession = vi.fn(async () => {});
    const revokeSessionByRefreshToken = vi.fn(async () => {});
    const dependencies: AppDependencies = {
      authRateLimiters: allowAuthRateLimiters,
      authService: {
        ...authDependencies.authService!,
        revokeSession,
        revokeSessionByRefreshToken,
      },
    };
    const response = await createApp(runtime, dependencies).request("https://api.test/api/v1/auth/logout", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        Authorization: "Bearer " + "z".repeat(43),
        Cookie: "__Host-inmotion-refresh=" + "b".repeat(43),
      },
    });

    expect(response.status).toBe(204);
    expect(revokeSessionByRefreshToken).toHaveBeenCalledWith("b".repeat(43));
    expect(revokeSession).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBe("__Host-inmotion-refresh=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
  });

  test("retains the refresh capability when server-side logout was not confirmed", async () => {
    const dependencies: AppDependencies = {
      authRateLimiters: allowAuthRateLimiters,
      authService: {
        ...authDependencies.authService!,
        revokeSessionByRefreshToken: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    };
    const response = await createApp(runtime, dependencies).request("https://api.test/api/v1/auth/logout", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        Cookie: "__Host-inmotion-refresh=" + "b".repeat(43),
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("rejects browser mutations without an exact Origin before they reach Auth", async () => {
    const response = await createApp(runtime, authDependencies).request("https://api.test/api/v1/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "doctor.sarsenov", password: "password", attemptId: "00000000-0000-7000-8000-000000000015" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ORIGIN_FORBIDDEN" });
  });

  test("rejects oversized auth bodies before validation or provider access", async () => {
    const response = await createApp(runtime, authDependencies).request("https://api.test/api/v1/auth/sign-in", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: "x".repeat(16_385),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("X-Correlation-ID")).toMatch(/^[0-9a-f-]{36}$/iu);
    await expect(response.json()).resolves.toMatchObject({ code: "REQUEST_BODY_TOO_LARGE" });
  });

  test("rate limits sign-in by canonical identity before provider access", async () => {
    const signIn = vi.fn(authDependencies.authService!.signIn);
    const response = await createApp(runtime, {
      authService: { ...authDependencies.authService!, signIn },
      authRateLimiters: {
        identity: { async limit() { return { success: false }; } },
        source: allowAuthRateLimiters.source,
      },
    }).request("https://api.test/api/v1/auth/sign-in", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ login: "Doctor.Sarsenov", password: "password", attemptId: "00000000-0000-7000-8000-000000000019" }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(signIn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  test("exposes only BFF-owned Auth routes and no generic provider proxy", async () => {
    const response = await createApp(runtime, authDependencies).request("https://api.test/auth/v1/signup", {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });

    expect(response.status).toBe(404);
  });

  test("returns only the authenticated user's permitted employee list and details", async () => {
    const app = createApp(runtime, employeeDependencies);
    const list = await app.request("https://api.test/api/v1/employees", {
      headers: { Authorization: "Bearer " + "a".repeat(43) },
    });
    const detail = await app.request(`https://api.test/api/v1/employees/${testSession.employeeId}`, {
      headers: { Authorization: "Bearer " + "a".repeat(43) },
    });

    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    const listPayload = await list.json() as { employees: Array<Record<string, unknown>> };
    expect(listPayload).toMatchObject({ employees: [{ login: "aliya.sarsenova" }] });
    expect(listPayload.employees[0]).not.toHaveProperty("recoveryEmail");
    expect(detail.status).toBe(200);
    expect(detail.headers.get("Cache-Control")).toBe("no-store");
    await expect(detail.json()).resolves.toMatchObject({ login: "aliya.sarsenova", recoveryEmail: "aliya@example.test" });
  });

  test("completes recovery server-side and keeps the one-time grant in an HttpOnly cookie", async () => {
    const response = await createApp(runtime, authDependencies).request("https://api.test/api/v1/auth/recovery/callback?challenge=00000000-0000-7000-8000-000000000016&state=" + "s".repeat(32) + "&code=" + "c".repeat(8));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://localhost:5173/recovery/reset");
    expect(response.headers.get("Set-Cookie")).toBe("__Host-inmotion-recovery=" + "e".repeat(43) + "; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Strict");
  });

  test("requires an exact browser Origin to consume a recovery grant", async () => {
    const response = await createApp(runtime, authDependencies).request("https://api.test/api/v1/auth/recovery/reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "__Host-inmotion-recovery=" + "e".repeat(43),
      },
      body: JSON.stringify({ newPassword: "correct horse battery staple" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ORIGIN_FORBIDDEN" });
  });
});
