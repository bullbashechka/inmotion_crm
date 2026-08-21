import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { RouteAccessClass } from "@inmotion-crm/contracts";
import type { AuthenticatedRequest } from "../auth/service";

export type RoutePolicy = {
  access: RouteAccessClass;
  /** Browser mutations require an exact configured Origin before reaching a handler. */
  requiresOrigin?: boolean;
};

export type RoutePolicyVariables = {
  correlationId: string;
  corsOrigins: readonly string[];
  routeAccess: RouteAccessClass;
  authService?: RouteAuthenticator;
  authenticated?: AuthenticatedRequest;
};

export type RouteAuthenticator = {
  authenticate(accessToken: string, route: "crm_session" | "password_change"): Promise<AuthenticatedRequest>;
};

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Registers a route with an explicit access class. The guard is intentionally
 * fail-closed: every non-public route must authenticate through the BFF.
 */
export function registerRoute<
  Route extends RouteConfig,
>(
  app: OpenAPIHono<{ Variables: RoutePolicyVariables }>,
  route: Route,
  policy: RoutePolicy,
  handler: RouteHandler<Route, { Variables: RoutePolicyVariables }>,
): void {
  const method = route.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // OpenAPI paths use `{employeeId}`, while Hono's middleware matcher uses
  // `:employeeId`. Without this conversion parameterized routes would skip
  // the guard and reach the handler without an authenticated context.
  const middlewarePath = route.path.replace(/\{([^}]+)\}/gu, ":$1");
  app.on(method, middlewarePath, async (context, next) => {
    context.set("routeAccess", policy.access);

    if ((policy.requiresOrigin ?? unsafeMethods.has(context.req.method)) && unsafeMethods.has(context.req.method)) {
      const origin = context.req.raw.headers.get("Origin");
      if (origin === null || context.get("corsOrigins").includes(origin) !== true) {
        return context.json({
          code: "ORIGIN_FORBIDDEN",
          message: "Запрос из этого источника не разрешён.",
          correlationId: context.get("correlationId"),
          retryable: false,
        }, 403);
      }
    }

    if (policy.access === "crm_session" || policy.access === "password_change") {
      const accessToken = parseBearerToken(context.req.raw.headers.get("Authorization"));
      const authService = context.get("authService");
      if (accessToken === null || authService === undefined) {
        return context.json({
          code: "AUTHENTICATION_REQUIRED",
          message: "Требуется действующая сессия CRM.",
          correlationId: context.get("correlationId"),
          retryable: false,
        }, 401);
      }
      try {
        context.set("authenticated", await authService.authenticate(accessToken, policy.access));
      } catch (error) {
        if (isRouteAuthError(error)) {
          return context.json({
            code: error.code,
            message: error.message,
            correlationId: context.get("correlationId"),
            retryable: error.retryable,
          }, error.status);
        }
        throw error;
      }
    } else if (policy.access === "service_admin") {
      return context.json({
        code: "SERVICE_AUTHENTICATION_REQUIRED",
        message: "Требуется служебная аутентификация.",
        correlationId: context.get("correlationId"),
        retryable: false,
      }, 401);
    }

    await next();
  });
  // @ts-expect-error @hono/zod-openapi 1.5.1 cannot preserve its conditional
  // RouteHandler identity through this generic policy wrapper under TypeScript 6.
  // Every concrete handler is still checked at the registerRoute call site.
  app.openapi(route, handler);
}

function parseBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/u.exec(header);
  return match?.[1] ?? null;
}

function isRouteAuthError(error: unknown): error is { code: string; status: 401 | 403 | 409 | 423 | 503; retryable: boolean; message: string } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && "status" in error
    && "retryable" in error
    && "message" in error
    && typeof error.code === "string"
    && (error.status === 401 || error.status === 403 || error.status === 409 || error.status === 423 || error.status === 503)
    && typeof error.retryable === "boolean"
    && typeof error.message === "string";
}

export const publicRoutePolicies = new Map<string, RoutePolicy>([
  ["GET /api/v1/system/health", { access: "public" }],
  ["GET /api/v1/openapi.json", { access: "public" }],
]);

export function routePolicyKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
