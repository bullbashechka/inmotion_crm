import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  AssignRoleRequestSchema,
  ChangePasswordRequestSchema,
  ContinueSessionResponseSchema,
  CreateEmployeeRequestSchema,
  CreateEmployeeResponseSchema,
  IssueTemporaryPasswordRequestSchema,
  IssueTemporaryPasswordResponseSchema,
  OffboardEmployeeRequestSchema,
  PasswordRecoveryRequestSchema,
  PasswordRecoveryResetRequestSchema,
  PublishRoleRevisionRequestSchema,
  RehireEmployeeRequestSchema,
  RevokeRoleRequestSchema,
  SetPermissionOverrideRequestSchema,
  SignInRequestSchema,
  SignInResponseSchema,
  SystemHealthResponseSchema,
  UnlockEmployeeRequestSchema,
  type AppEnvironment,
  type ClientCompatibility,
} from "@inmotion-crm/contracts";

import { registerRoute, type RoutePolicyVariables } from "./http/route-policy";
import { AuthServiceError, type AuthService } from "./auth/service";
import { AuthorizationError, EmployeeServiceError, type EmployeeService } from "./access/employees";
import { RoleServiceError, type RoleService } from "./access/roles";

type AppVariables = RoutePolicyVariables;

export type RuntimeConfig = {
  appEnvironment: AppEnvironment;
  appBuildVersion: string;
  supportedClientVersions: readonly string[];
  corsOrigins: readonly string[];
  auth?: {
    providerUrl: string;
    providerAnonKey: string;
    providerServiceRoleKey: string;
    providerNamespace: string;
    tokenEncryptionKey: string;
    recoveryCallbackUrl: string;
    recoveryCompleteUrl: string;
  };
};

export type AppDependencies = {
  authService?: Pick<AuthService, "authenticate" | "signIn" | "refreshSession" | "continueSession" | "revokeSession" | "changePassword" | "requestPasswordRecovery" | "completePasswordRecovery" | "resetPasswordWithRecoveryGrant">;
  employeeService?: Pick<EmployeeService, "createEmployee" | "unlockAccount" | "issueTemporaryPassword" | "offboardEmployee" | "rehireEmployee">;
  roleService?: Pick<RoleService, "assignRole" | "revokeRole" | "setEmployeePermissionOverride" | "publishRoleRevision">;
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

const signInRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/sign-in",
  request: { body: { content: { "application/json": { schema: SignInRequestSchema } } } },
  responses: {
    200: { content: { "application/json": { schema: SignInResponseSchema } }, description: "Сессия CRM создана" },
    401: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Неверные данные" },
    423: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Вход временно заблокирован" },
    503: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Провайдер недоступен" },
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/refresh",
  responses: {
    200: { content: { "application/json": { schema: SignInResponseSchema } }, description: "Сессия CRM обновлена" },
    401: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Refresh-сессия недействительна" },
    503: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Провайдер недоступен" },
  },
});

const sessionRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/session",
  responses: {
    200: { content: { "application/json": { schema: ContinueSessionResponseSchema } }, description: "Текущее состояние сессии" },
    401: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Сессия недействительна" },
  },
});

const continueRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/session/continue",
  responses: {
    200: { content: { "application/json": { schema: ContinueSessionResponseSchema } }, description: "Сессия продлена" },
    409: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Окно продления ещё не открыто" },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/logout",
  responses: { 204: { description: "Сессия завершена" } },
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/password/change",
  request: { body: { content: { "application/json": { schema: ChangePasswordRequestSchema } } } },
  responses: {
    204: { description: "Пароль изменён; требуется новый вход" },
    401: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Пароль не подтверждён" },
    503: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Провайдер недоступен" },
  },
});

const passwordRecoveryRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/password/recovery",
  request: { body: { content: { "application/json": { schema: PasswordRecoveryRequestSchema } } } },
  responses: { 202: { description: "Ответ не раскрывает наличие учётной записи" } },
});

const passwordRecoveryCallbackRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/recovery/callback",
  request: { query: z.object({ challenge: z.string().uuid(), state: z.string().min(32), code: z.string().min(8) }) },
  responses: { 303: { description: "Одноразовый recovery grant выдан только в HttpOnly cookie" } },
});

const passwordRecoveryResetRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/recovery/reset",
  request: { body: { content: { "application/json": { schema: PasswordRecoveryResetRequestSchema } } } },
  responses: { 204: { description: "Пароль восстановлен; требуется обычный вход" } },
});

const createEmployeeRoute = createRoute({
  method: "post",
  path: "/api/v1/employees",
  request: { body: { content: { "application/json": { schema: CreateEmployeeRequestSchema } } } },
  responses: {
    201: { content: { "application/json": { schema: CreateEmployeeResponseSchema } }, description: "Сотрудник создан, временный пароль выдан один раз" },
    403: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Недостаточно прав" },
    409: { content: { "application/json": { schema: ApiErrorResponseSchema } }, description: "Конфликт учётной записи" },
  },
});

const unlockEmployeeRoute = createRoute({
  method: "post",
  path: "/api/v1/employees/{employeeId}/unlock",
  request: {
    params: z.object({ employeeId: z.string().uuid() }),
    body: { content: { "application/json": { schema: UnlockEmployeeRequestSchema } } },
  },
  responses: { 204: { description: "Временная блокировка снята" } },
});

const issueTemporaryPasswordRoute = createRoute({
  method: "post",
  path: "/api/v1/employees/{employeeId}/password/temporary",
  request: {
    params: z.object({ employeeId: z.string().uuid() }),
    body: { content: { "application/json": { schema: IssueTemporaryPasswordRequestSchema } } },
  },
  responses: { 200: { content: { "application/json": { schema: IssueTemporaryPasswordResponseSchema } }, description: "Одноразовый временный пароль" } },
});

const offboardEmployeeRoute = createRoute({
  method: "post",
  path: "/api/v1/employees/{employeeId}/offboard",
  request: {
    params: z.object({ employeeId: z.string().uuid() }),
    body: { content: { "application/json": { schema: OffboardEmployeeRequestSchema } } },
  },
  responses: { 204: { description: "Сотрудник уволен" } },
});

const rehireEmployeeRoute = createRoute({
  method: "post",
  path: "/api/v1/employees/{employeeId}/rehire",
  request: {
    params: z.object({ employeeId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RehireEmployeeRequestSchema } } },
  },
  responses: { 201: { content: { "application/json": { schema: CreateEmployeeResponseSchema } }, description: "Новая employment identity создана" } },
});

const assignRoleRoute = createRoute({
  method: "post",
  path: "/api/v1/employees/{employeeId}/roles",
  request: {
    params: z.object({ employeeId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AssignRoleRequestSchema } } },
  },
  responses: { 204: { description: "Роль назначена" } },
});

const revokeRoleRoute = createRoute({
  method: "post",
  path: "/api/v1/employees/{employeeId}/roles/{roleId}/revoke",
  request: {
    params: z.object({ employeeId: z.string().uuid(), roleId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RevokeRoleRequestSchema } } },
  },
  responses: { 204: { description: "Роль отозвана" } },
});

const setPermissionOverrideRoute = createRoute({
  method: "put",
  path: "/api/v1/employees/{employeeId}/permissions/{permissionCode}",
  request: {
    params: z.object({ employeeId: z.string().uuid(), permissionCode: z.string().min(1).max(120) }),
    body: { content: { "application/json": { schema: SetPermissionOverrideRequestSchema } } },
  },
  responses: { 204: { description: "Индивидуальное исключение сохранено" } },
});

const publishRoleRevisionRoute = createRoute({
  method: "post",
  path: "/api/v1/roles/{roleId}/revisions",
  request: {
    params: z.object({ roleId: z.string().uuid() }),
    body: { content: { "application/json": { schema: PublishRoleRevisionRequestSchema } } },
  },
  responses: { 204: { description: "Новая редакция роли опубликована" } },
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
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Client-Version");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return true;
}

function getRefreshToken(request: Request): string | null {
  return getHostCookie(request, "__Host-inmotion-refresh");
}

function getHostCookie(request: Request, cookieName: "__Host-inmotion-refresh" | "__Host-inmotion-recovery"): string | null {
  const value = request.headers.get("Cookie");
  if (value === null) return null;
  for (const part of value.split(";")) {
    const [receivedName, token] = part.trim().split("=", 2);
    if (receivedName === cookieName && token !== undefined && /^[A-Za-z0-9_-]{32,}$/.test(token)) return token;
  }
  return null;
}

function refreshCookie(value: string | null): string {
  if (value === null) return "__Host-inmotion-refresh=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
  return `__Host-inmotion-refresh=${value}; Path=/; Max-Age=${12 * 60 * 60}; HttpOnly; Secure; SameSite=Strict`;
}

function recoveryCookie(value: string | null): string {
  if (value === null) return "__Host-inmotion-recovery=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
  return `__Host-inmotion-recovery=${value}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Strict`;
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  const match = header === null ? null : /^Bearer ([A-Za-z0-9_-]{32,})$/u.exec(header);
  return match?.[1] ?? null;
}

export function createApp(config: RuntimeConfig, dependencies: AppDependencies = {}) {
  const app = new OpenAPIHono<{ Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    const correlationId = crypto.randomUUID();
    context.set("correlationId", correlationId);
    context.set("corsOrigins", config.corsOrigins);
    if (dependencies.authService !== undefined) context.set("authService", dependencies.authService);

    const isAllowedOrigin = setCorsHeaders(context.res.headers, context.req.raw, config.corsOrigins);

    if (context.req.method === "OPTIONS") {
      if (!isAllowedOrigin) {
        return context.json({
          code: "ORIGIN_FORBIDDEN",
          message: "Запрос из этого источника не разрешён.",
          correlationId,
          retryable: false,
        }, 403);
      }
      return context.body(null, 204);
    }

    await next();
    context.header("X-Correlation-ID", correlationId);
  });

  registerRoute(app, healthRoute, { access: "public" }, (context) => {
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

  registerRoute(app, signInRoute, { access: "public" }, async (context) => {
    const authService = dependencies.authService;
    if (authService === undefined) return authUnavailable(context);
    try {
      const issued = await authService.signIn(context.req.valid("json"));
      context.header("Set-Cookie", refreshCookie(issued.refreshToken), { append: true });
      context.header("Cache-Control", "no-store");
      return context.json({ accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessTokenExpiresAt, session: issued.session }, 200);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, refreshRoute, { access: "public" }, async (context) => {
    const authService = dependencies.authService;
    const refreshToken = getRefreshToken(context.req.raw);
    if (authService === undefined) return authUnavailable(context);
    if (refreshToken === null) return context.json(authErrorPayload(context, "AUTHENTICATION_REQUIRED", "Сессия завершена. Войдите снова.", false), 401);
    try {
      const issued = await authService.refreshSession(refreshToken);
      context.header("Set-Cookie", refreshCookie(issued.refreshToken), { append: true });
      context.header("Cache-Control", "no-store");
      return context.json({ accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessTokenExpiresAt, session: issued.session }, 200);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, sessionRoute, { access: "password_change", requiresOrigin: false }, (context) => {
    const authenticated = context.get("authenticated");
    if (authenticated === undefined) return context.json(authErrorPayload(context, "AUTHENTICATION_REQUIRED", "Требуется действующая сессия CRM.", false), 401);
    return context.json({ session: authenticated.session }, 200);
  });

  registerRoute(app, continueRoute, { access: "crm_session" }, async (context) => {
    const authService = dependencies.authService;
    const accessToken = getBearerToken(context.req.raw);
    if (authService === undefined || accessToken === null) return context.json(authErrorPayload(context, "AUTHENTICATION_REQUIRED", "Требуется действующая сессия CRM.", false), 401);
    try {
      return context.json({ session: await authService.continueSession(accessToken) }, 200);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, logoutRoute, { access: "crm_session" }, async (context) => {
    const authService = dependencies.authService;
    const accessToken = getBearerToken(context.req.raw);
    if (authService === undefined || accessToken === null) return context.json(authErrorPayload(context, "AUTHENTICATION_REQUIRED", "Требуется действующая сессия CRM.", false), 401);
    try {
      await authService.revokeSession(accessToken);
      context.header("Set-Cookie", refreshCookie(null), { append: true });
      context.header("Cache-Control", "no-store");
      return context.body(null, 204);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, changePasswordRoute, { access: "password_change" }, async (context) => {
    const authService = dependencies.authService;
    const accessToken = getBearerToken(context.req.raw);
    if (authService === undefined || accessToken === null) return context.json(authErrorPayload(context, "AUTHENTICATION_REQUIRED", "Требуется действующая сессия CRM.", false), 401);
    try {
      await authService.changePassword(accessToken, context.req.valid("json"));
      context.header("Set-Cookie", refreshCookie(null), { append: true });
      context.header("Cache-Control", "no-store");
      return context.body(null, 204);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, passwordRecoveryRoute, { access: "recovery" }, async (context) => {
    const authService = dependencies.authService;
    if (authService === undefined) return authUnavailable(context);
    try {
      await authService.requestPasswordRecovery(context.req.valid("json").login);
      return context.body(null, 202);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, passwordRecoveryCallbackRoute, { access: "recovery", requiresOrigin: false }, async (context) => {
    const authService = dependencies.authService;
    if (authService === undefined) return authUnavailable(context);
    try {
      const completed = await authService.completePasswordRecovery({
        challengeId: context.req.valid("query").challenge,
        stateVerifier: context.req.valid("query").state,
        code: context.req.valid("query").code,
      });
      context.header("Set-Cookie", recoveryCookie(completed.recoveryGrant), { append: true });
      context.header("Cache-Control", "no-store");
      return context.redirect(completed.redirectTo, 303);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, passwordRecoveryResetRoute, { access: "recovery" }, async (context) => {
    const authService = dependencies.authService;
    const recoveryGrant = getHostCookie(context.req.raw, "__Host-inmotion-recovery");
    if (authService === undefined) return authUnavailable(context);
    if (recoveryGrant === null) return context.json(authErrorPayload(context, "RECOVERY_GRANT_INVALID", "Восстановление необходимо начать заново.", false), 401);
    try {
      await authService.resetPasswordWithRecoveryGrant(recoveryGrant, context.req.valid("json").newPassword);
      context.header("Set-Cookie", recoveryCookie(null), { append: true });
      context.header("Cache-Control", "no-store");
      return context.body(null, 204);
    } catch (error) {
      return authError(context, error);
    }
  });

  registerRoute(app, createEmployeeRoute, { access: "crm_session" }, async (context) => {
    const employeeService = dependencies.employeeService;
    const authenticated = context.get("authenticated");
    if (employeeService === undefined || authenticated === undefined) return employeeServiceUnavailable(context);
    try {
      const created = await employeeService.createEmployee({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, context.req.valid("json"));
      context.header("Cache-Control", "no-store");
      return context.json(created, 201);
    } catch (error) {
      return employeeError(context, error);
    }
  });

  registerRoute(app, unlockEmployeeRoute, { access: "crm_session" }, async (context) => {
    const employeeService = dependencies.employeeService;
    const authenticated = context.get("authenticated");
    if (employeeService === undefined || authenticated === undefined) return employeeServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      await employeeService.unlockAccount({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, params.employeeId, context.req.valid("json").reason);
      return context.body(null, 204);
    } catch (error) {
      return employeeError(context, error);
    }
  });

  registerRoute(app, issueTemporaryPasswordRoute, { access: "crm_session" }, async (context) => {
    const employeeService = dependencies.employeeService;
    const authenticated = context.get("authenticated");
    if (employeeService === undefined || authenticated === undefined) return employeeServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      const issued = await employeeService.issueTemporaryPassword({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, params.employeeId, context.req.valid("json").reason);
      context.header("Cache-Control", "no-store");
      return context.json(issued, 200);
    } catch (error) {
      return employeeError(context, error);
    }
  });

  registerRoute(app, offboardEmployeeRoute, { access: "crm_session" }, async (context) => {
    const employeeService = dependencies.employeeService;
    const authenticated = context.get("authenticated");
    if (employeeService === undefined || authenticated === undefined) return employeeServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      await employeeService.offboardEmployee({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, { employeeId: params.employeeId, ...context.req.valid("json") });
      return context.body(null, 204);
    } catch (error) {
      return employeeError(context, error);
    }
  });

  registerRoute(app, rehireEmployeeRoute, { access: "crm_session" }, async (context) => {
    const employeeService = dependencies.employeeService;
    const authenticated = context.get("authenticated");
    if (employeeService === undefined || authenticated === undefined) return employeeServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      const created = await employeeService.rehireEmployee({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, { employeeId: params.employeeId, ...context.req.valid("json") });
      context.header("Cache-Control", "no-store");
      return context.json(created, 201);
    } catch (error) {
      return employeeError(context, error);
    }
  });

  registerRoute(app, assignRoleRoute, { access: "crm_session" }, async (context) => {
    const roleService = dependencies.roleService;
    const authenticated = context.get("authenticated");
    if (roleService === undefined || authenticated === undefined) return roleServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      await roleService.assignRole({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, { employeeId: params.employeeId, ...context.req.valid("json") });
      return context.body(null, 204);
    } catch (error) {
      return roleError(context, error);
    }
  });

  registerRoute(app, revokeRoleRoute, { access: "crm_session" }, async (context) => {
    const roleService = dependencies.roleService;
    const authenticated = context.get("authenticated");
    if (roleService === undefined || authenticated === undefined) return roleServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      await roleService.revokeRole({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, { employeeId: params.employeeId, roleId: params.roleId, ...context.req.valid("json") });
      return context.body(null, 204);
    } catch (error) {
      return roleError(context, error);
    }
  });

  registerRoute(app, setPermissionOverrideRoute, { access: "crm_session" }, async (context) => {
    const roleService = dependencies.roleService;
    const authenticated = context.get("authenticated");
    if (roleService === undefined || authenticated === undefined) return roleServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      await roleService.setEmployeePermissionOverride({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, { employeeId: params.employeeId, permissionCode: params.permissionCode, ...context.req.valid("json") });
      return context.body(null, 204);
    } catch (error) {
      return roleError(context, error);
    }
  });

  registerRoute(app, publishRoleRevisionRoute, { access: "crm_session" }, async (context) => {
    const roleService = dependencies.roleService;
    const authenticated = context.get("authenticated");
    if (roleService === undefined || authenticated === undefined) return roleServiceUnavailable(context);
    try {
      const params = context.req.valid("param");
      await roleService.publishRoleRevision({ employeeId: authenticated.employeeId, employmentEpochId: authenticated.employmentEpochId }, { roleId: params.roleId, ...context.req.valid("json") });
      return context.body(null, 204);
    } catch (error) {
      return roleError(context, error);
    }
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

function authErrorPayload(context: { get(key: "correlationId"): string }, code: string, message: string, retryable: boolean) {
  return { code, message, correlationId: context.get("correlationId"), retryable };
}

function authUnavailable(context: { get(key: "correlationId"): string }) {
  return new Response(JSON.stringify(authErrorPayload(context, "AUTH_NOT_CONFIGURED", "Служба входа не настроена.", false)), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function authError(context: { get(key: "correlationId"): string; json: (value: unknown, status: 401 | 403 | 409 | 423 | 503) => Response }, error: unknown): Response {
  if (error instanceof AuthServiceError) return context.json(authErrorPayload(context, error.code, error.message, error.retryable), error.status);
  throw error;
}

function employeeServiceUnavailable(context: { get(key: "correlationId"): string }) {
  return new Response(JSON.stringify(authErrorPayload(context, "EMPLOYEE_SERVICE_UNAVAILABLE", "Служба управления сотрудниками не настроена.", false)), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function employeeError(context: { get(key: "correlationId"): string; json: (value: unknown, status: 403 | 404 | 409 | 422 | 503) => Response }, error: unknown): Response {
  if (error instanceof AuthorizationError) return context.json(authErrorPayload(context, error.code, error.message, false), 403);
  if (error instanceof EmployeeServiceError) return context.json(authErrorPayload(context, error.code, error.message, error.retryable), error.status);
  throw error;
}

function roleServiceUnavailable(context: { get(key: "correlationId"): string }) {
  return new Response(JSON.stringify(authErrorPayload(context, "ROLE_SERVICE_UNAVAILABLE", "Служба управления ролями не настроена.", false)), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function roleError(context: { get(key: "correlationId"): string; json: (value: unknown, status: 403 | 404 | 409 | 422) => Response }, error: unknown): Response {
  if (error instanceof AuthorizationError) return context.json(authErrorPayload(context, error.code, error.message, false), 403);
  if (error instanceof RoleServiceError) return context.json(authErrorPayload(context, error.code, error.message, false), error.status);
  throw error;
}
