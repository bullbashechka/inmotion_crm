import { useState } from "react";
import type { FormEvent } from "react";

type LoginFormProps = {
  onSubmit(input: { login: string; password: string }): Promise<void>;
  onRecovery(login: string): Promise<void>;
  busy: boolean;
  error: string | null;
};

export function LoginForm({ onSubmit, onRecovery, busy, error }: LoginFormProps) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryRequested, setRecoveryRequested] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ login, password });
  }

  async function requestRecovery() {
    await onRecovery(login);
    setRecoveryRequested(true);
  }

  return (
    <form className="mt-8 space-y-4" onSubmit={submit}>
      <label className="block text-sm font-medium text-ink" htmlFor="login">
        Логин
        <input
          autoComplete="username"
          className="mt-1.5 block w-full rounded-md border bg-surface px-3 py-2 text-base shadow-sm outline-none focus:border-ink"
          id="login"
          onChange={(event) => setLogin(event.target.value)}
          required
          value={login}
        />
      </label>
      <label className="block text-sm font-medium text-ink" htmlFor="password">
        Пароль
        <input
          autoComplete="current-password"
          className="mt-1.5 block w-full rounded-md border bg-surface px-3 py-2 text-base shadow-sm outline-none focus:border-ink"
          id="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </label>
      {error !== null ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {recoveryRequested ? <p className="text-sm text-success" role="status">Если учётная запись существует, письмо для восстановления уже отправлено.</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-surface disabled:cursor-not-allowed disabled:opacity-60" disabled={busy} type="submit">
          {busy ? "Проверяем…" : "Войти"}
        </button>
        <button className="text-sm text-muted underline underline-offset-4 disabled:cursor-not-allowed" disabled={busy || login.trim() === ""} onClick={() => void requestRecovery()} type="button">
          Восстановить доступ
        </button>
      </div>
    </form>
  );
}
