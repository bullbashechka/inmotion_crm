import { describe, expect, it } from "vitest";

import { parseClientRuntimeConfig } from "../src/lib/runtime";

describe("parseClientRuntimeConfig", () => {
  it("accepts only explicit public runtime configuration", () => {
    expect(
      parseClientRuntimeConfig({
        VITE_API_URL: "https://api.example.test/",
        VITE_APP_ENV: "preview",
        VITE_CLIENT_VERSION: "2026.08.06",
      }),
    ).toEqual({
      apiUrl: "https://api.example.test",
      environment: "preview",
      clientVersion: "2026.08.06",
    });
  });

  it("rejects an unsupported environment", () => {
    expect(() =>
      parseClientRuntimeConfig({
        VITE_API_URL: "https://api.example.test",
        VITE_APP_ENV: "staging",
        VITE_CLIENT_VERSION: "2026.08.06",
      }),
    ).toThrow("неподдерживаемое окружение");
  });

  it("rejects a production HTTP API and credential-bearing URLs", () => {
    expect(() => parseClientRuntimeConfig({
      VITE_API_URL: "http://api.example.test",
      VITE_APP_ENV: "production",
      VITE_CLIENT_VERSION: "2026.08.06",
    })).toThrow("HTTPS");
    expect(() => parseClientRuntimeConfig({
      VITE_API_URL: "https://token@api.example.test/path",
      VITE_APP_ENV: "preview",
      VITE_CLIENT_VERSION: "2026.08.06",
    })).toThrow("origin HTTP(S)");
  });
});
