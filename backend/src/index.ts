import { createApp } from "./app";
import { parseRuntimeConfig } from "./config";

// Keep the Worker bundle coupled to the adapter without opening a connection for health checks.
export async function loadRequestDatabaseAdapter() {
  return import("./db/client");
}

export default {
  fetch(request, env, executionContext) {
    return createApp(
      parseRuntimeConfig({
        APP_ENV: env.APP_ENV,
        APP_BUILD_VERSION: env.APP_BUILD_VERSION,
        SUPPORTED_CLIENT_VERSIONS: env.SUPPORTED_CLIENT_VERSIONS,
        CORS_ORIGINS: env.CORS_ORIGINS,
      }),
    ).fetch(request, env, executionContext);
  },
} satisfies ExportedHandler<Env>;
