import { describe, expect, test } from "vitest";

import { parseRuntimeConfig } from "../src/config";

describe("runtime configuration", () => {
  test("accepts exact local browser origins", () => {
    expect(
      parseRuntimeConfig({
        APP_ENV: "local",
        APP_BUILD_VERSION: "dev",
        SUPPORTED_CLIENT_VERSIONS: "dev,previous-build",
        CORS_ORIGINS: "http://localhost:5173",
      }),
    ).toEqual({
      appEnvironment: "local",
      appBuildVersion: "dev",
      supportedClientVersions: ["dev", "previous-build"],
      corsOrigins: ["http://localhost:5173"],
    });
  });

  test("rejects a wildcard origin before the Worker accepts credentials", () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: "production",
        APP_BUILD_VERSION: "2026.08.06",
        SUPPORTED_CLIENT_VERSIONS: "2026.08.06",
        CORS_ORIGINS: "*",
      }),
    ).toThrow("точным origin");
  });

  test("rejects an insecure production origin", () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: "production",
        APP_BUILD_VERSION: "2026.08.06",
        SUPPORTED_CLIENT_VERSIONS: "2026.08.06",
        CORS_ORIGINS: "http://app.inmotion.test",
      }),
    ).toThrow("HTTPS");
  });
});
