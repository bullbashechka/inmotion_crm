import { useState } from "react";
import type { FormEvent } from "react";

type RecoveryResetFormProps = {
  onSubmit(newPassword: string): Promise<void>;
  busy: boolean;
  error: string | null;
  completed: boolean;
};

export function RecoveryResetForm({ onSubmit, busy, error, completed }: RecoveryResetFormProps) {
  const [newPassword, setNewPassword] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(newPassword);
  }

  if (completed) return <p className="mt-8 text-sm text-success" role="status">Пароль изменён. Вернитесь на страницу входа и используйте новый пароль.</p>;

  return (
    <form className="mt-8 space-y-4" onSubmit={submit}>
      <p className="text-sm text-muted">Задайте новый пароль для своей учётной записи.</p>
      <label className="block text-sm font-medium text-ink" htmlFor="recovery-new-password">
        Новый пароль
        <input autoComplete="new-password" className="mt-1.5 block w-full rounded-md border bg-surface px-3 py-2" id="recovery-new-password" minLength={12} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} />
      </label>
      {error !== null ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-surface disabled:opacity-60" disabled={busy} type="submit">
        {busy ? "Сохраняем…" : "Сменить пароль"}
      </button>
    </form>
  );
}
