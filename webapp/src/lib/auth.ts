import {
  ApiErrorResponseSchema,
  AuthSessionSchema,
  ChangePasswordRequestSchema,
  ContinueSessionResponseSchema,
  EmployeeDetailSchema,
  EmployeeListResponseSchema,
  PasswordRecoveryRequestSchema,
  PasswordRecoveryResetRequestSchema,
  SignInRequestSchema,
  SignInResponseSchema,
  type AuthSession,
  type EmployeeDetail,
  type EmployeeListResponse,
  type SignInRequest,
} from "@inmotion-crm/contracts";

import { ApiRequestError } from "./api";

function endpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/$/u, "")}${path}`;
}

async function readError(response: Response): Promise<never> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = ApiErrorResponseSchema.safeParse(payload);
  if (parsed.success) throw new ApiRequestError(parsed.data.message, parsed.data);
  throw new Error("Не удалось получить безопасное описание ошибки API.");
}

/**
 * The access token is intentionally private in this in-memory object. It is
 * never written to localStorage, sessionStorage, IndexedDB, URL fragments, or
 * React Query cache. A full page reload obtains a new token via the HttpOnly
 * refresh cookie, if that cookie is still valid.
 */
export class AuthClient {
  private accessToken: string | null = null;

  constructor(private readonly apiUrl: string) {}

  async signIn(input: SignInRequest): Promise<AuthSession> {
    const response = await fetch(endpoint(this.apiUrl, "/api/v1/auth/sign-in"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SignInRequestSchema.parse(input)),
    });
    if (!response.ok) return readError(response);
    const issued = SignInResponseSchema.parse(await response.json());
    this.accessToken = issued.accessToken;
    return issued.session;
  }

  async restore(): Promise<AuthSession | null> {
    const response = await fetch(endpoint(this.apiUrl, "/api/v1/auth/refresh"), {
      method: "POST",
      credentials: "include",
    });
    if (response.status === 401) {
      this.accessToken = null;
      return null;
    }
    if (!response.ok) return readError(response);
    const issued = SignInResponseSchema.parse(await response.json());
    this.accessToken = issued.accessToken;
    return issued.session;
  }

  async currentSession(): Promise<AuthSession> {
    const response = await this.authorizedFetch("/api/v1/auth/session", { method: "GET" });
    if (!response.ok) return readError(response);
    return ContinueSessionResponseSchema.parse(await response.json()).session;
  }

  async getEmployees(): Promise<EmployeeListResponse> {
    const response = await this.authorizedFetch("/api/v1/employees", { method: "GET" });
    if (!response.ok) return readError(response);
    return EmployeeListResponseSchema.parse(await response.json());
  }

  async getEmployee(employeeId: string): Promise<EmployeeDetail> {
    const response = await this.authorizedFetch(`/api/v1/employees/${employeeId}`, { method: "GET" });
    if (!response.ok) return readError(response);
    return EmployeeDetailSchema.parse(await response.json());
  }

  async continueSession(): Promise<AuthSession> {
    const response = await this.authorizedFetch("/api/v1/auth/session/continue", { method: "POST" });
    if (!response.ok) return readError(response);
    return ContinueSessionResponseSchema.parse(await response.json()).session;
  }

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    const response = await this.authorizedFetch("/api/v1/auth/password/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ChangePasswordRequestSchema.parse(input)),
    });
    if (!response.ok) return readError(response);
    this.accessToken = null;
  }

  async requestPasswordRecovery(login: string): Promise<void> {
    const response = await fetch(endpoint(this.apiUrl, "/api/v1/auth/password/recovery"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PasswordRecoveryRequestSchema.parse({ login })),
    });
    if (!response.ok) return readError(response);
  }

  async resetRecoveredPassword(newPassword: string): Promise<void> {
    const response = await fetch(endpoint(this.apiUrl, "/api/v1/auth/recovery/reset"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PasswordRecoveryResetRequestSchema.parse({ newPassword })),
    });
    if (!response.ok) return readError(response);
  }

  async logout(): Promise<void> {
    if (this.accessToken === null) return;
    const response = await this.authorizedFetch("/api/v1/auth/logout", { method: "POST" });
    this.accessToken = null;
    if (!response.ok && response.status !== 401) return readError(response);
  }

  clearMemory(): void {
    this.accessToken = null;
  }

  private async authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    if (this.accessToken === null) throw new ApiRequestError("Сессия завершена. Войдите снова.", {
      code: "AUTHENTICATION_REQUIRED",
      message: "Сессия завершена. Войдите снова.",
      correlationId: "00000000-0000-7000-8000-000000000000",
      retryable: false,
    });
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    return fetch(endpoint(this.apiUrl, path), { ...init, headers, credentials: "include" });
  }
}

export function sessionExpired(session: AuthSession, now = Date.now()): boolean {
  return new Date(session.idleExpiresAt).getTime() <= now || new Date(session.absoluteExpiresAt).getTime() <= now;
}

export function parseSession(value: unknown): AuthSession {
  return AuthSessionSchema.parse(value);
}
