import { useState } from "react";
import type { FormEvent } from "react";

type PasswordChangeFormProps = {
  onSubmit(input: { currentPassword: string; newPassword: string }): Promise<void>;
  busy: boolean;
  error: string | null;
};

export function PasswordChangeForm({ onSubmit, busy, error }: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ currentPassword, newPassword });
  }

  return (
    <form className="mt-8 space-y-4" onSubmit={submit}>
      <p className="text-sm text-muted">Для продолжения работы задайте новый пароль. После смены потребуется войти снова.</p>
      <label className="block text-sm font-medium text-ink" htmlFor="current-password">
        Текущий временный пароль
        <input autoComplete="current-password" className="mt-1.5 block w-full rounded-md border bg-surface px-3 py-2" id="current-password" onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} />
      </label>
      <label className="block text-sm font-medium text-ink" htmlFor="new-password">
        Новый пароль
        <input autoComplete="new-password" className="mt-1.5 block w-full rounded-md border bg-surface px-3 py-2" id="new-password" minLength={12} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} />
      </label>
      {error !== null ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-surface disabled:opacity-60" disabled={busy} type="submit">
        {busy ? "Сохраняем…" : "Сменить пароль"}
      </button>
    </form>
  );
}
