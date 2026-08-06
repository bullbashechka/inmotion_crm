import {
  AppEnvironmentSchema,
  type AppEnvironment,
} from "@inmotion-crm/contracts";

type RuntimeEnvironment = {
  VITE_API_URL?: string;
  VITE_APP_ENV?: string;
  VITE_CLIENT_VERSION?: string;
};

export type ClientRuntimeConfig = {
  apiUrl: string;
  environment: AppEnvironment;
  clientVersion: string;
};

export function parseClientRuntimeConfig(
  environment: RuntimeEnvironment,
): ClientRuntimeConfig {
  const apiUrl = environment.VITE_API_URL?.replace(/\/$/, "");
  const clientVersion = environment.VITE_CLIENT_VERSION?.trim();
  const parsedEnvironment = AppEnvironmentSchema.safeParse(environment.VITE_APP_ENV);

  if (!apiUrl || !URL.canParse(apiUrl)) {
    throw new Error("VITE_API_URL должен содержать корректный URL API.");
  }

  if (!parsedEnvironment.success) {
    throw new Error("VITE_APP_ENV содержит неподдерживаемое окружение.");
  }

  if (!clientVersion) {
    throw new Error("VITE_CLIENT_VERSION обязателен.");
  }

  return {
    apiUrl,
    environment: parsedEnvironment.data,
    clientVersion,
  };
}
