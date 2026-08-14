import { canonicalizeLogin } from "./crypto";

export type ProviderSession = {
  subjectId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  login: string;
  authenticationMethods: readonly string[];
};

export type ProviderSignInResult =
  | { kind: "success"; session: ProviderSession }
  | { kind: "invalid_credentials" }
  | { kind: "unavailable" };

export type AuthProvider = {
  signInWithPassword(input: { login: string; password: string }): Promise<ProviderSignInResult>;
  refreshSession(refreshToken: string): Promise<ProviderSignInResult>;
  updatePassword(input: { subjectId: string; password: string }): Promise<"updated" | "unavailable">;
  banUser(subjectId: string): Promise<"banned" | "unavailable">;
  sendPasswordRecovery(input: { login: string; redirectTo: string; codeChallenge: string }): Promise<"accepted" | "unavailable">;
  exchangeRecoveryCode(input: { code: string; codeVerifier: string }): Promise<ProviderSignInResult>;
  createUser(input: { subjectId: string; login: string; temporaryPassword: string; marker: string }): Promise<"created" | "conflict" | "unavailable">;
  getUserById(subjectId: string): Promise<{ subjectId: string; login: string; marker: string } | null | "unavailable">;
};

export type SupabaseAuthProviderOptions = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

type ProviderTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user?: { id?: unknown; email?: unknown };
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function base64UrlJson(value: string): unknown {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}

function accessTokenClaims(accessToken: string): { sessionId: string; authenticationMethods: readonly string[] } | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload = base64UrlJson(parts[1]);
    if (typeof payload !== "object" || payload === null || !("session_id" in payload)) return null;
    const sessionId = payload.session_id;
    const amr = "amr" in payload ? payload.amr : [];
    if (typeof sessionId !== "string" || !isUuid(sessionId) || !Array.isArray(amr)) return null;
    const authenticationMethods = amr.flatMap((item) => typeof item === "object" && item !== null && "method" in item && typeof item.method === "string" ? [item.method] : []);
    return { sessionId, authenticationMethods };
  } catch {
    return null;
  }
}

function toProviderSession(payload: ProviderTokenPayload): ProviderSession | null {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresInSeconds = payload.expires_in;
  const subjectId = payload.user?.id;
  const login = payload.user?.email;
  if (
    typeof accessToken !== "string"
    || typeof refreshToken !== "string"
    || typeof expiresInSeconds !== "number"
    || !Number.isSafeInteger(expiresInSeconds)
    || expiresInSeconds <= 0
    || typeof subjectId !== "string"
    || !isUuid(subjectId)
    || typeof login !== "string"
  ) return null;
  const canonicalLogin = canonicalizeLogin(login);
  const claims = accessTokenClaims(accessToken);
  if (canonicalLogin === null || claims === null) return null;
  return { subjectId, sessionId: claims.sessionId, accessToken, refreshToken, expiresInSeconds, login: canonicalLogin, authenticationMethods: claims.authenticationMethods };
}

/** Narrow server-side adapter; it intentionally exposes no generic Auth proxy. */
export class SupabaseAuthProvider implements AuthProvider {
  readonly #baseUrl: string;

  constructor(private readonly options: SupabaseAuthProviderOptions) {
    this.#baseUrl = options.url.replace(/\/$/u, "");
  }

  async signInWithPassword(input: { login: string; password: string }): Promise<ProviderSignInResult> {
    return this.requestToken("password", { email: input.login, password: input.password });
  }

  async refreshSession(refreshToken: string): Promise<ProviderSignInResult> {
    return this.requestToken("refresh_token", { refresh_token: refreshToken });
  }

  async updatePassword(input: { subjectId: string; password: string }): Promise<"updated" | "unavailable"> {
    try {
      const response = await fetch(`${this.#baseUrl}/auth/v1/admin/users/${encodeURIComponent(input.subjectId)}`, {
        method: "PUT",
        headers: this.serviceHeaders(),
        body: JSON.stringify({ password: input.password }),
      });
      return response.ok ? "updated" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async banUser(subjectId: string): Promise<"banned" | "unavailable"> {
    try {
      const response = await fetch(`${this.#baseUrl}/auth/v1/admin/users/${encodeURIComponent(subjectId)}`, {
        method: "PUT",
        headers: this.serviceHeaders(),
        body: JSON.stringify({ ban_duration: "876000h" }),
      });
      return response.ok ? "banned" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async sendPasswordRecovery(input: { login: string; redirectTo: string; codeChallenge: string }): Promise<"accepted" | "unavailable"> {
    try {
      const response = await fetch(`${this.#baseUrl}/auth/v1/recover`, {
        method: "POST",
        headers: this.anonHeaders(),
        body: JSON.stringify({
          email: input.login,
          redirect_to: input.redirectTo,
          code_challenge: input.codeChallenge,
          code_challenge_method: "s256",
        }),
      });
      return response.ok ? "accepted" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async exchangeRecoveryCode(input: { code: string; codeVerifier: string }): Promise<ProviderSignInResult> {
    return this.requestToken("pkce", { auth_code: input.code, code_verifier: input.codeVerifier });
  }

  async createUser(input: { subjectId: string; login: string; temporaryPassword: string; marker: string }): Promise<"created" | "conflict" | "unavailable"> {
    try {
      const response = await fetch(`${this.#baseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: this.serviceHeaders(),
        body: JSON.stringify({
          id: input.subjectId,
          email: input.login,
          password: input.temporaryPassword,
          email_confirm: true,
          app_metadata: { inmotion_marker: input.marker },
        }),
      });
      if (response.ok) return "created";
      if (response.status === 400 || response.status === 409 || response.status === 422) return "conflict";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async getUserById(subjectId: string): Promise<{ subjectId: string; login: string; marker: string } | null | "unavailable"> {
    try {
      const response = await fetch(`${this.#baseUrl}/auth/v1/admin/users/${encodeURIComponent(subjectId)}`, {
        headers: this.serviceHeaders(),
      });
      if (response.status === 404) return null;
      if (!response.ok) return "unavailable";
      const body = await response.json() as { id?: unknown; email?: unknown; app_metadata?: { inmotion_marker?: unknown } };
      const canonicalLogin = typeof body.email === "string" ? canonicalizeLogin(body.email) : null;
      if (typeof body.id !== "string" || !isUuid(body.id) || canonicalLogin === null || typeof body.app_metadata?.inmotion_marker !== "string") return "unavailable";
      return { subjectId: body.id, login: canonicalLogin, marker: body.app_metadata.inmotion_marker };
    } catch {
      return "unavailable";
    }
  }

  private async requestToken(grantType: "password" | "refresh_token" | "pkce", body: Record<string, string>): Promise<ProviderSignInResult> {
    try {
      const response = await fetch(`${this.#baseUrl}/auth/v1/token?grant_type=${grantType}`, {
        method: "POST",
        headers: this.anonHeaders(),
        body: JSON.stringify(body),
      });
      if (response.status === 400 || response.status === 401 || response.status === 422) return { kind: "invalid_credentials" };
      if (!response.ok) return { kind: "unavailable" };
      const session = toProviderSession(await response.json() as ProviderTokenPayload);
      return session === null ? { kind: "unavailable" } : { kind: "success", session };
    } catch {
      return { kind: "unavailable" };
    }
  }

  private anonHeaders(): HeadersInit {
    return { apikey: this.options.anonKey, "Content-Type": "application/json" };
  }

  private serviceHeaders(): HeadersInit {
    return {
      apikey: this.options.serviceRoleKey,
      Authorization: `Bearer ${this.options.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
  }
}
