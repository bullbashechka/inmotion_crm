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

  return {
    appEnvironment,
    appBuildVersion,
    supportedClientVersions,
    corsOrigins: parseOrigins(required(variables.CORS_ORIGINS, "CORS_ORIGINS"), appEnvironment),
  };
}
