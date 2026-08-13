import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { describe, expect, test } from "vitest";

import { registerRoute, type RoutePolicyVariables } from "../src/http/route-policy";

const protectedRoute = createRoute({
  method: "get",
  path: "/protected",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
      description: "Protected test route",
    },
  },
});

function createPolicyApp() {
  const app = new OpenAPIHono<{ Variables: RoutePolicyVariables }>();
  app.use("*", async (context, next) => {
    context.set("correlationId", "00000000-0000-7000-8000-000000000001");
    context.set("corsOrigins", ["https://app.example.test"]);
    await next();
  });
  registerRoute(app, protectedRoute, { access: "crm_session" }, (context) =>
    context.json({ ok: true }, 200),
  );
  return app;
}

describe("route policy boundary", () => {
  test("does not let a protected route reach its handler before auth middleware exists", async () => {
    const response = await createPolicyApp().request("https://api.example.test/protected");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});
