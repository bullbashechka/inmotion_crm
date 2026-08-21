import { AppEnvironmentSchema, type AppEnvironment } from "@inmotion-crm/contracts";

import type { RuntimeConfig } from "./app";

type RuntimeVariables = Record<string, string | undefined>;

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} обязателен`);
  }

  return value.trim();
}

function parseOrigins(value: string, environment: AppEnvironment): string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error("CORS_ORIGINS должен содержать хотя бы один origin");
  }

  for (const origin of origins) {
    if (origin === "*") {
      throw new Error("CORS_ORIGINS должен состоять из точным origin без wildcard и пути");
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("CORS_ORIGINS должен состоять из точным origin без wildcard и пути");
    }

    if (parsed.origin !== origin || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw new Error("CORS_ORIGINS должен состоять из точным origin без wildcard и пути");
    }

    if (environment === "production" && parsed.protocol !== "https:") {
      throw new Error("Production CORS origin должен использовать HTTPS");
    }
  }

  return origins;
}

function optionalAuthConfig(variables: RuntimeVariables, corsOrigins: readonly string[], environment: AppEnvironment): RuntimeConfig["auth"] {
  const values = {
    providerUrl: variables.SUPABASE_URL,
    providerAnonKey: variables.SUPABASE_ANON_KEY,
    providerServiceRoleKey: variables.SUPABASE_SERVICE_ROLE_KEY,
    providerNamespace: variables.AUTH_PROVIDER_NAMESPACE,
    tokenEncryptionKey: variables.AUTH_TOKEN_ENCRYPTION_KEY,
    apiPublicOrigin: variables.API_PUBLIC_ORIGIN,
    recoveryCallbackUrl: variables.AUTH_RECOVERY_CALLBACK_URL,
    recoveryCompleteUrl: variables.AUTH_RECOVERY_COMPLETE_URL,
  };
  const configured = Object.values(values).filter((value) => value !== undefined && value.trim() !== "").length;
  if (configured === 0) return undefined;
  if (configured !== Object.keys(values).length) throw new Error("Для Auth BFF должны быть заданы все AUTH_* и SUPABASE_* переменные.");

  const providerUrl = required(values.providerUrl, "SUPABASE_URL");
  const recoveryCallbackUrl = required(values.recoveryCallbackUrl, "AUTH_RECOVERY_CALLBACK_URL");
  const recoveryCompleteUrl = required(values.recoveryCompleteUrl, "AUTH_RECOVERY_COMPLETE_URL");
  const apiPublicOrigin = required(values.apiPublicOrigin, "API_PUBLIC_ORIGIN");
  let provider: URL;
  let recoveryCallback: URL;
  let recoveryComplete: URL;
  let publicApi: URL;
  try {
    provider = new URL(providerUrl);
    recoveryCallback = new URL(recoveryCallbackUrl);
    recoveryComplete = new URL(recoveryCompleteUrl);
    publicApi = new URL(apiPublicOrigin);
  } catch {
    throw new Error("SUPABASE_URL и AUTH_RECOVERY_*_URL должны быть корректными URL.");
  }
  if (provider.protocol !== "https:" || (environment === "production" && (recoveryCallback.protocol !== "https:" || recoveryComplete.protocol !== "https:" || publicApi.protocol !== "https:"))) {
    throw new Error("Auth BFF в production требует HTTPS URL.");
  }
  if (recoveryCallback.pathname !== "/api/v1/auth/recovery/callback" || recoveryCallback.search !== "" || recoveryCallback.hash !== "") {
    throw new Error("AUTH_RECOVERY_CALLBACK_URL должен указывать ровно на /api/v1/auth/recovery/callback.");
  }
  if (publicApi.origin !== apiPublicOrigin || recoveryCallback.origin !== publicApi.origin) {
    throw new Error("API_PUBLIC_ORIGIN должен быть точным origin Auth API, а AUTH_RECOVERY_CALLBACK_URL — его callback URL.");
  }
  if (!corsOrigins.includes(recoveryComplete.origin) || recoveryComplete.search !== "" || recoveryComplete.hash !== "") {
    throw new Error("AUTH_RECOVERY_COMPLETE_URL должен иметь exact origin из CORS_ORIGINS и не содержать query/hash.");
  }
  return {
    providerUrl: provider.toString().replace(/\/$/u, ""),
    providerAnonKey: required(values.providerAnonKey, "SUPABASE_ANON_KEY"),
    providerServiceRoleKey: required(values.providerServiceRoleKey, "SUPABASE_SERVICE_ROLE_KEY"),
    providerNamespace: required(values.providerNamespace, "AUTH_PROVIDER_NAMESPACE"),
    tokenEncryptionKey: required(values.tokenEncryptionKey, "AUTH_TOKEN_ENCRYPTION_KEY"),
    apiPublicOrigin: publicApi.origin,
    recoveryCallbackUrl: recoveryCallback.toString(),
    recoveryCompleteUrl: recoveryComplete.toString(),
  };
}

export function parseRuntimeConfig(variables: RuntimeVariables): RuntimeConfig {
  const appEnvironment = AppEnvironmentSchema.parse(required(variables.APP_ENV, "APP_ENV"));
  const appBuildVersion = required(variables.APP_BUILD_VERSION, "APP_BUILD_VERSION");
  const supportedClientVersions = required(
    variables.SUPPORTED_CLIENT_VERSIONS,
    "SUPPORTED_CLIENT_VERSIONS",
  )
    .split(",")
    .map((version) => version.trim())
    .filter((version) => version.length > 0);

  if (supportedClientVersions.length === 0) {
    throw new Error("SUPPORTED_CLIENT_VERSIONS должен содержать хотя бы одну версию");
  }

  const corsOrigins = parseOrigins(required(variables.CORS_ORIGINS, "CORS_ORIGINS"), appEnvironment);
  return {
    appEnvironment,
    appBuildVersion,
    supportedClientVersions,
    corsOrigins,
    auth: optionalAuthConfig(variables, corsOrigins, appEnvironment),
  };
}
