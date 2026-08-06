import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  SystemHealthResponseSchema,
  type AppEnvironment,
  type ClientCompatibility,
} from "@inmotion-crm/contracts";

type AppVariables = {
  correlationId: string;
};

export type RuntimeConfig = {
  appEnvironment: AppEnvironment;
  appBuildVersion: string;
  supportedClientVersions: readonly string[];
  corsOrigins: readonly string[];
};

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/system/health",
  request: {
    headers: z.object({
      "x-client-version": z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SystemHealthResponseSchema,
        },
      },
      description: "Состояние API и совместимость клиента",
    },
  },
});

function getClientCompatibility(
  clientVersion: string | undefined,
  config: RuntimeConfig,
): ClientCompatibility {
  if (clientVersion === config.appBuildVersion) {
    return "current";
  }

  if (clientVersion !== undefined && config.supportedClientVersions.includes(clientVersion)) {
    return "update_available";
  }

  return "update_required";
}

function setCorsHeaders(
  headers: Headers,
  request: Request,
  configuredOrigins: readonly string[],
): boolean {
  const origin = request.headers.get("Origin");

  if (origin === null || !configuredOrigins.includes(origin)) {
    return false;
  }

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Client-Version");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return true;
}

export function createApp(config: RuntimeConfig) {
  const app = new OpenAPIHono<{ Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    const correlationId = crypto.randomUUID();
    context.set("correlationId", correlationId);

    setCorsHeaders(context.res.headers, context.req.raw, config.corsOrigins);

    if (context.req.method === "OPTIONS") {
      return context.body(null, 204);
    }

    await next();
    context.header("X-Correlation-ID", correlationId);
  });

  app.openapi(healthRoute, (context) => {
    const clientVersion = context.req.valid("header")["x-client-version"];
    const response = {
      status: "ok" as const,
      apiVersion: "v1" as const,
      environment: config.appEnvironment,
      apiBuild: config.appBuildVersion,
      compatibility: getClientCompatibility(clientVersion, config),
    };

    return context.json(response, 200);
  });

  app.doc("/api/v1/openapi.json", {
    openapi: "3.0.0",
    info: {
      title: "InMotion Sport Clinic CRM API",
      version: "v1",
    },
  });

  app.notFound((context) =>
    context.json(
      {
        code: "NOT_FOUND",
        message: "Запрашиваемый ресурс не найден",
        correlationId: context.get("correlationId"),
        retryable: false,
      },
      404,
    ),
  );

  app.onError((error, context) => {
    console.error(
      JSON.stringify({
        message: "Unhandled API error",
        correlationId: context.get("correlationId"),
        name: error instanceof Error ? error.name : "UnknownError",
      }),
    );

    return context.json(
      {
        code: "INTERNAL_ERROR",
        message: "Не удалось обработать запрос. Повторите попытку.",
        correlationId: context.get("correlationId"),
        retryable: true,
      },
      500,
    );
  });

  return app;
}

export { ApiErrorResponseSchema };
