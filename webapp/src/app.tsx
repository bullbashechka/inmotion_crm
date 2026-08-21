import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppEnvironment, SystemHealthResponse } from "@inmotion-crm/contracts";

import { EnvironmentBanner } from "./components/environment-banner";
import { EmployeeAccessScreen } from "./components/employee-access-screen";
import { LoginForm } from "./components/login-form";
import { PasswordChangeForm } from "./components/password-change-form";
import { RecoveryResetForm } from "./components/recovery-reset-form";
import { Alert } from "./components/ui/alert";
import { Card } from "./components/ui/card";
import { AuthClient } from "./lib/auth";

type AppProps = {
  clientEnvironment: AppEnvironment;
  loadHealth: () => Promise<SystemHealthResponse>;
  authClient?: AuthClient;
};

export function App({ clientEnvironment, loadHealth, authClient }: AppProps) {
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: ["system-health"],
    queryFn: loadHealth,
    retry: false,
  });

  const apiEnvironment = healthQuery.data?.environment;
  const hasEnvironmentMismatch =
    apiEnvironment !== undefined && apiEnvironment !== clientEnvironment;
  const hasCriticalUpdate = healthQuery.data?.compatibility === "update_required";
  const hasNonBlockingUpdate = healthQuery.data?.compatibility === "update_available";
  const [session, setSession] = useState<Awaited<ReturnType<AuthClient["restore"]>>>(null);
  const [authReady, setAuthReady] = useState(authClient === undefined);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [recoveryCompleted, setRecoveryCompleted] = useState(false);
  const authChannel = useRef<BroadcastChannel | null>(null);
  const authGeneration = useRef(0);
  const recoveryResetRoute = typeof window !== "undefined" && window.location.pathname === "/recovery/reset";

  const clearPrivateState = useCallback((message?: string) => {
    authGeneration.current += 1;
    queryClient.cancelQueries();
    queryClient.clear();
    authClient?.clearMemory();
    setSession(null);
    if (message !== undefined) setAuthError(message);
  }, [authClient, queryClient]);

  useEffect(() => {
    if (authClient === undefined || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("inmotion-auth");
    authChannel.current = channel;
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data === "logout") clearPrivateState();
    });
    return () => {
      authChannel.current = null;
      channel.close();
    };
  }, [authClient, clearPrivateState]);

  useEffect(() => {
    if (authClient === undefined) return;
    let active = true;
    const generation = authGeneration.current;
    void authClient.restore()
      .then((restored) => {
        if (active && authGeneration.current === generation) {
          setSession(restored);
          setNow(Date.now());
        }
      })
      .catch(() => {
        if (active) setAuthError("Не удалось восстановить сессию. Войдите снова.");
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
    return () => { active = false; };
  }, [authClient]);

  useEffect(() => {
    if (session === null || authClient === undefined) return;
    let active = true;
    const idleExpiresAt = new Date(session.idleExpiresAt).getTime();
    const absoluteExpiresAt = new Date(session.absoluteExpiresAt).getTime();
    const warningAt = new Date(session.warningAt).getTime();
    const updateSessionClock = () => {
      const observedNow = Date.now();
      if (!active) return;
      setNow(observedNow);
      if (idleExpiresAt <= observedNow || absoluteExpiresAt <= observedNow) {
        clearPrivateState("Сессия завершена из-за бездействия. Войдите снова.");
        return;
      }
      void authClient.currentSession()
        .then((current) => {
          if (active) setSession(current);
        })
        .catch(() => {
          if (!active) return;
          clearPrivateState("Сессия завершена. Войдите снова.");
        });
    };
    const interval = window.setInterval(updateSessionClock, 30_000);
    const warningTimeout = window.setTimeout(updateSessionClock, Math.max(0, warningAt - Date.now()));
    return () => {
      active = false;
      window.clearInterval(interval);
      window.clearTimeout(warningTimeout);
    };
  }, [authClient, clearPrivateState, session]);

  useEffect(() => {
    if (session === null || authClient === undefined) return;
    let active = true;
    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      void authClient.currentSession()
        .then((current) => {
          if (active) setSession(current);
        })
        .catch(() => {
          if (active) clearPrivateState("Сессия завершена. Войдите снова.");
        });
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      active = false;
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [authClient, clearPrivateState, session]);

  const isSessionWarning = session !== null && (session.state === "warning" || new Date(session.warningAt).getTime() <= now);
  const passwordChangeRequired = session?.state === "password_change_required";
  const workspaceBlocked = hasEnvironmentMismatch || hasCriticalUpdate;

  async function signIn(input: { login: string; password: string }) {
    if (authClient === undefined) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      setSession(await authClient.signIn({ ...input, attemptId: crypto.randomUUID() }));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Не удалось выполнить вход.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function requestRecovery(login: string) {
    if (authClient === undefined) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authClient.requestPasswordRecovery(login);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Не удалось начать восстановление.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function continueSession() {
    if (authClient === undefined) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      setSession(await authClient.continueSession());
      setNow(Date.now());
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Не удалось продлить сессию.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function changePassword(input: { currentPassword: string; newPassword: string }) {
    if (authClient === undefined) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authClient.changePassword(input);
      clearPrivateState("Пароль изменён. Войдите с новым паролем.");
      authChannel.current?.postMessage("logout");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Не удалось сменить пароль.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    if (authClient === undefined) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authClient.logout();
      clearPrivateState();
      authChannel.current?.postMessage("logout");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Не удалось подтвердить выход. Повторите попытку.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function resetRecoveredPassword(newPassword: string) {
    if (authClient === undefined) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authClient.resetRecoveredPassword(newPassword);
      setRecoveryCompleted(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Не удалось восстановить пароль.");
    } finally {
      setAuthBusy(false);
    }
  }

  const workspace = (() => {
    if (authClient === undefined) return null;
    if (!authReady) return <p aria-live="polite" role="status" className="mt-8 text-sm text-muted">Восстанавливаем безопасную сессию…</p>;
    if (recoveryResetRoute) return <RecoveryResetForm busy={authBusy} completed={recoveryCompleted} error={authError} onSubmit={resetRecoveredPassword} />;
    if (passwordChangeRequired) return <PasswordChangeForm busy={authBusy} error={authError} onSubmit={changePassword} />;
    if (session === null) return <LoginForm busy={authBusy} error={authError} onRecovery={requestRecovery} onSubmit={signIn} />;
    return <EmployeeAccessScreen
      authClient={authClient}
      sessionId={session.id}
      onLogout={logout}
      sessionWarning={
        <>
          {isSessionWarning ? (
            <Alert role="alert">
              Сессия завершится в {Math.max(0, Math.ceil((new Date(session.idleExpiresAt).getTime() - now) / 60_000))} мин. Несохранённые изменения не будут отправлены после завершения. {" "}
              <button className="ml-1 font-semibold underline underline-offset-4" disabled={authBusy} onClick={() => void continueSession()} type="button">Продолжить работу</button>
            </Alert>
          ) : null}
          {authError !== null ? <Alert role="alert">{authError}</Alert> : null}
        </>
      }
    />;
  })();

  const fullWorkspace = authClient !== undefined && authReady && session !== null && !passwordChangeRequired && !recoveryResetRoute;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <EnvironmentBanner environment={clientEnvironment} />
      {fullWorkspace && !workspaceBlocked && healthQuery.isSuccess ? workspace : <main className="mx-auto flex min-h-[calc(100vh-40px)] max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <p className="text-sm font-medium text-muted">InMotion CRM</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Рабочее пространство</h1>
          <p className="mt-3 max-w-xl text-muted">
            Базовая оболочка подключена к API. Следующие функции будут добавляться без
            смешивания пользовательского интерфейса и серверного контракта.
          </p>

          <section aria-label="Состояние подключения" className="mt-8">
            {healthQuery.isPending ? (
              <p aria-live="polite" role="status" className="text-sm text-muted">
                Проверяем подключение к API…
              </p>
            ) : null}

            {healthQuery.isError ? (
              <Alert role="alert">
                API временно недоступен. Откройте страницу позже; несохранённые данные не
                будут подтверждены до восстановления соединения.
              </Alert>
            ) : null}

            {hasEnvironmentMismatch ? (
              <Alert role="alert">
                Окружение клиента не совпадает с окружением API. Работа остановлена, чтобы
                данные не попали не в тот контур.
              </Alert>
            ) : null}

            {hasCriticalUpdate ? (
              <Alert role="alert">
                Требуется критичное обновление приложения. Работа остановлена для защиты
                данных.
              </Alert>
            ) : null}

            {healthQuery.isSuccess && !hasEnvironmentMismatch && !hasCriticalUpdate ? (
              <div className="space-y-3">
                <p
                  aria-label="API подключён"
                  className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-sm font-medium text-success"
                  role="status"
                >
                  API подключён · версия {healthQuery.data.apiBuild}
                </p>
                {hasNonBlockingUpdate ? (
                  <p className="text-sm text-muted" role="status">
                    Обновление будет применено после завершения текущей сессии.
                  </p>
                ) : null}
              </div>
            ) : null}

            {!workspaceBlocked && healthQuery.isSuccess ? workspace : null}
          </section>
        </Card>
      </main>}
    </div>
  );
}
