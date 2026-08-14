import type { AppEnvironment } from "@inmotion-crm/contracts";

type EnvironmentBannerProps = {
  environment: AppEnvironment;
};

export function EnvironmentBanner({ environment }: EnvironmentBannerProps) {
  if (environment === "production") {
    return null;
  }

  const label =
    environment === "demo"
      ? "Демонстрационная версия — данные не являются рабочими."
      : `Окружение: ${environment}.`;

  return (
    <div className="bg-demo px-4 py-2 text-center text-sm font-medium text-demo-ink" role="status">
      {label}
    </div>
  );
}
