import {
  ApiErrorResponseSchema,
  SystemHealthResponseSchema,
  type ApiErrorResponse,
  type SystemHealthResponse,
} from "@inmotion-crm/contracts";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly details: ApiErrorResponse,
  ) {
    super(message);
  }
}

export async function getSystemHealth(
  apiUrl: string,
  clientVersion: string,
): Promise<SystemHealthResponse> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1/system/health`, {
    credentials: "include",
    headers: { "X-Client-Version": clientVersion },
  });

  const payload: unknown = await response.json();

  if (!response.ok) {
    const error = ApiErrorResponseSchema.safeParse(payload);
    if (error.success) {
      throw new ApiRequestError(error.data.message, error.data);
    }

    throw new Error("Не удалось получить безопасное описание ошибки API.");
  }

  return SystemHealthResponseSchema.parse(payload);
}
