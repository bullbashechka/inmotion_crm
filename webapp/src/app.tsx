import { useQuery } from "@tanstack/react-query";
import type { AppEnvironment, SystemHealthResponse } from "@inmotion-crm/contracts";

import { EnvironmentBanner } from "./components/environment-banner";
import { Alert } from "./components/ui/alert";
import { Card } from "./components/ui/card";

type AppProps = {
  clientEnvironment: AppEnvironment;
  loadHealth: () => Promise<SystemHealthResponse>;
};

export function App({ clientEnvironment, loadHealth }: AppProps) {
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

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <EnvironmentBanner environment={clientEnvironment} />
      <main className="mx-auto flex min-h-[calc(100vh-40px)] max-w-3xl items-center px-6 py-12">
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
          </section>
        </Card>
      </main>
    </div>
  );
}
