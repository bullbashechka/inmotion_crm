import { createApp } from "./app";
import { EmployeeService } from "./access/employees";
import { RoleService } from "./access/roles";
import { createAuthTokenCipher } from "./auth/crypto";
import { SupabaseAuthProvider } from "./auth/provider";
import { AuthService } from "./auth/service";
import { parseRuntimeConfig } from "./config";

// Keep the Worker bundle coupled to the adapter without opening a connection for health checks.
export async function loadRequestDatabaseAdapter() {
  return import("./db/client");
}

export default {
  async fetch(request, env, executionContext) {
    const variables = env as unknown as Record<string, string | undefined>;
    const config = parseRuntimeConfig({
        APP_ENV: env.APP_ENV,
        APP_BUILD_VERSION: env.APP_BUILD_VERSION,
        SUPPORTED_CLIENT_VERSIONS: env.SUPPORTED_CLIENT_VERSIONS,
        CORS_ORIGINS: env.CORS_ORIGINS,
        SUPABASE_URL: variables.SUPABASE_URL,
        SUPABASE_ANON_KEY: variables.SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: variables.SUPABASE_SERVICE_ROLE_KEY,
        AUTH_PROVIDER_NAMESPACE: variables.AUTH_PROVIDER_NAMESPACE,
        AUTH_TOKEN_ENCRYPTION_KEY: variables.AUTH_TOKEN_ENCRYPTION_KEY,
        AUTH_RECOVERY_CALLBACK_URL: variables.AUTH_RECOVERY_CALLBACK_URL,
        AUTH_RECOVERY_COMPLETE_URL: variables.AUTH_RECOVERY_COMPLETE_URL,
      });
    if (config.auth === undefined) return createApp(config).fetch(request, env, executionContext);
    const { withRequestDatabase } = await loadRequestDatabaseAdapter();
    const tokenCipher = await createAuthTokenCipher(config.auth.tokenEncryptionKey);
    const provider = new SupabaseAuthProvider({
      url: config.auth.providerUrl,
      anonKey: config.auth.providerAnonKey,
      serviceRoleKey: config.auth.providerServiceRoleKey,
    });
    const authService = new AuthService({
      withDatabase: (callback) => withRequestDatabase(env.HYPERDRIVE_FRESH, callback),
      provider,
      tokenCipher,
      providerNamespace: config.auth.providerNamespace,
      recoveryCallbackUrl: config.auth.recoveryCallbackUrl,
      recoveryCompleteUrl: config.auth.recoveryCompleteUrl,
    });
    const employeeService = new EmployeeService({
      withDatabase: (callback) => withRequestDatabase(env.HYPERDRIVE_FRESH, callback),
      provider,
      providerNamespace: config.auth.providerNamespace,
    });
    const roleService = new RoleService((callback) => withRequestDatabase(env.HYPERDRIVE_FRESH, callback));
    return createApp(config, { authService, employeeService, roleService }).fetch(request, env, executionContext);
  },
} satisfies ExportedHandler<Env>;
