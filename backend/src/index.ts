import { createApp, type RuntimeConfig } from "./app";
import { EmployeeService } from "./access/employees";
import { RoleService } from "./access/roles";
import { createAuthTokenCipher } from "./auth/crypto";
import { SupabaseAuthProvider } from "./auth/provider";
import { AuthService } from "./auth/service";
import { parseRuntimeConfig } from "./config";
import type { RequestDatabase } from "./db/integrity";

// Keep the Worker bundle coupled to the adapter without opening a connection for health checks.
export async function loadRequestDatabaseAdapter() {
  return import("./db/client");
}

function optionalStringBinding(env: Env, name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
}

type DatabaseRunner = <T>(callback: (database: RequestDatabase) => Promise<T>) => Promise<T>;
type SecurityServices = { authService: AuthService; employeeService: EmployeeService; withDatabase: DatabaseRunner };

function runtimeConfig(env: Env): RuntimeConfig {
  return parseRuntimeConfig({
    APP_ENV: env.APP_ENV,
    APP_BUILD_VERSION: env.APP_BUILD_VERSION,
    SUPPORTED_CLIENT_VERSIONS: env.SUPPORTED_CLIENT_VERSIONS,
    CORS_ORIGINS: env.CORS_ORIGINS,
    SUPABASE_URL: optionalStringBinding(env, "SUPABASE_URL"),
    SUPABASE_ANON_KEY: optionalStringBinding(env, "SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: optionalStringBinding(env, "SUPABASE_SERVICE_ROLE_KEY"),
    AUTH_PROVIDER_NAMESPACE: optionalStringBinding(env, "AUTH_PROVIDER_NAMESPACE"),
    AUTH_TOKEN_ENCRYPTION_KEY: optionalStringBinding(env, "AUTH_TOKEN_ENCRYPTION_KEY"),
    API_PUBLIC_ORIGIN: optionalStringBinding(env, "API_PUBLIC_ORIGIN"),
    AUTH_RECOVERY_CALLBACK_URL: optionalStringBinding(env, "AUTH_RECOVERY_CALLBACK_URL"),
    AUTH_RECOVERY_COMPLETE_URL: optionalStringBinding(env, "AUTH_RECOVERY_COMPLETE_URL"),
  });
}

async function securityServices(env: Env, executionContext: ExecutionContext, auth: NonNullable<RuntimeConfig["auth"]>): Promise<SecurityServices> {
  const { withRequestDatabase } = await loadRequestDatabaseAdapter();
  const tokenCipher = await createAuthTokenCipher(auth.tokenEncryptionKey);
  const provider = new SupabaseAuthProvider({
    url: auth.providerUrl,
    anonKey: auth.providerAnonKey,
    serviceRoleKey: auth.providerServiceRoleKey,
  });
  const withDatabase: DatabaseRunner = (callback) => withRequestDatabase(env.HYPERDRIVE_FRESH, callback);
  const authService = new AuthService({
    withDatabase,
    provider,
    tokenCipher,
    providerNamespace: auth.providerNamespace,
    recoveryCallbackUrl: auth.recoveryCallbackUrl,
    recoveryCompleteUrl: auth.recoveryCompleteUrl,
    defer: (task) => executionContext.waitUntil(task),
  });
  const employeeService = new EmployeeService({
    withDatabase,
    provider,
    tokenCipher,
    providerNamespace: auth.providerNamespace,
  });
  return { authService, employeeService, withDatabase };
}

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const config = runtimeConfig(env);
    if (config.auth === undefined) return createApp(config).fetch(request, env, executionContext);
    const { authService, employeeService, withDatabase } = await securityServices(env, executionContext, config.auth);
    executionContext.waitUntil(Promise.all([
      authService.reconcileProviderEffects(),
      employeeService.reconcileProviderEffects(),
    ]));
    const roleService = new RoleService(withDatabase);
    return createApp(config, {
      authService,
      authRateLimiters: {
        identity: env.AUTH_IDENTITY_RATE_LIMITER,
        source: env.AUTH_SOURCE_RATE_LIMITER,
      },
      employeeService,
      roleService,
    }).fetch(request, env, executionContext);
  },
  async scheduled(_controller: ScheduledController, env: Env, executionContext: ExecutionContext): Promise<void> {
    const config = runtimeConfig(env);
    if (config.auth === undefined) return;
    const { authService, employeeService } = await securityServices(env, executionContext, config.auth);
    executionContext.waitUntil(Promise.all([
      authService.reconcileProviderEffects(),
      employeeService.reconcileProviderEffects(),
    ]));
  },
} satisfies ExportedHandler<Env>;
