import { createApp } from "./app";
import { parseRuntimeConfig } from "./config";

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
