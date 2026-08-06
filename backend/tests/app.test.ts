import { describe, expect, test } from "vitest";

import { createApp } from "../src/app";
import worker from "../src/index";

const runtime = {
  appEnvironment: "local" as const,
  appBuildVersion: "dev",
  supportedClientVersions: ["dev", "previous-build"],
  corsOrigins: ["http://localhost:5173"],
};

describe("system API", () => {
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

  test("exposes the documented route through the Worker entry point", async () => {
    const response = await worker.fetch(
      new Request("http://api.test/api/v1/system/health", {
        headers: { "X-Client-Version": "dev" },
      }) as never,
      {
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
});
