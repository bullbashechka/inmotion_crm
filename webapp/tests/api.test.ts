import { describe, expect, it, vi } from "vitest";

import { ApiRequestError, getSystemHealth } from "../src/lib/api";

describe("getSystemHealth", () => {
  it("sends the client version and parses the shared health contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          apiVersion: "v1",
          environment: "local",
          apiBuild: "dev",
          compatibility: "current",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSystemHealth("http://localhost:8787/", "dev")).resolves.toMatchObject({
      environment: "local",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/api/v1/system/health", {
      credentials: "include",
      headers: { "X-Client-Version": "dev" },
    });
  });

  it("exposes only the safe error returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "RATE_LIMITED",
            message: "Повторите попытку позже.",
            correlationId: "c2e680a4-2f50-4b04-96d1-30b2c33704ae",
            retryable: true,
          }),
          { status: 429 },
        ),
      ),
    );

    await expect(getSystemHealth("http://localhost:8787", "dev")).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });
});
