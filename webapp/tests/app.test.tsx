import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app";

afterEach(cleanup);

function renderApp(
  clientEnvironment: "demo" | "production",
  apiEnvironment: "demo" | "production",
  compatibility: "current" | "update_available" | "update_required" = "current",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App
        clientEnvironment={clientEnvironment}
        loadHealth={async () => ({
          status: "ok",
          apiVersion: "v1",
          environment: apiEnvironment,
          apiBuild: "2026.08.06",
          compatibility,
        })}
      />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("marks the demo permanently and shows a connected API", async () => {
    renderApp("demo", "demo");

    expect(
      await screen.findByRole("status", { name: "API подключён" }),
    ).toBeVisible();
    expect(
      screen.getByText("Демонстрационная версия — данные не являются рабочими."),
    ).toBeVisible();
  });

  it("blocks work when the client and API environments differ", async () => {
    renderApp("production", "demo");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Окружение клиента не совпадает с окружением API.",
    );
  });

  it("keeps the current session open when a compatible update is available", async () => {
    renderApp("production", "production", "update_available");

    expect(
      await screen.findByText("Обновление будет применено после завершения текущей сессии."),
    ).toBeVisible();
    expect(screen.getByRole("status", { name: "API подключён" })).toBeVisible();
  });

  it("blocks the workspace when the API requires a critical update", async () => {
    renderApp("production", "production", "update_required");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Требуется критичное обновление приложения.",
    );
  });
});
