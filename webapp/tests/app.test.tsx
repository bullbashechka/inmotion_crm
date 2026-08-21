import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app";
import { AuthClient } from "../src/lib/auth";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function activeSession() {
  const currentTime = Date.now();
  return {
    id: "00000000-0000-7000-8000-000000000051",
    employeeId: "00000000-0000-7000-8000-000000000052",
    state: "active" as const,
    serverNow: new Date(currentTime).toISOString(),
    warningAt: new Date(currentTime + 25 * 60_000).toISOString(),
    idleExpiresAt: new Date(currentTime + 30 * 60_000).toISOString(),
    absoluteExpiresAt: new Date(currentTime + 12 * 60 * 60_000).toISOString(),
    revision: 1,
  };
}

function renderApp(
  clientEnvironment: "demo" | "production",
  apiEnvironment: "demo" | "production",
  compatibility: "current" | "update_available" | "update_required" = "current",
  authClient?: AuthClient,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App
        authClient={authClient}
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

  it("does not restore a late revalidation after logout", async () => {
    const session = activeSession();
    const authClient = new AuthClient("https://api.test");
    vi.spyOn(authClient, "restore").mockResolvedValue(session);
    vi.spyOn(authClient, "getEmployees").mockResolvedValue({ employees: [] });
    vi.spyOn(authClient, "logout").mockResolvedValue();
    let resolveRevalidation!: (value: typeof session) => void;
    vi.spyOn(authClient, "currentSession").mockImplementation(() => new Promise((resolve) => { resolveRevalidation = resolve; }));
    renderApp("production", "production", "current", authClient);

    const logout = await screen.findByRole("button", { name: "Выйти" });
    act(() => { window.dispatchEvent(new Event("focus")); });
    fireEvent.click(logout);
    await screen.findByRole("button", { name: "Войти" });
    await act(async () => resolveRevalidation(session));

    await waitFor(() => expect(screen.getByRole("button", { name: "Войти" })).toBeVisible());
    expect(screen.queryByRole("button", { name: "Выйти" })).not.toBeInTheDocument();
  });

  it("keeps the authenticated workspace when logout was not confirmed", async () => {
    const authClient = new AuthClient("https://api.test");
    vi.spyOn(authClient, "restore").mockResolvedValue(activeSession());
    vi.spyOn(authClient, "getEmployees").mockResolvedValue({ employees: [] });
    vi.spyOn(authClient, "logout").mockRejectedValue(new Error("Сервер не подтвердил выход."));
    renderApp("production", "production", "current", authClient);

    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Сервер не подтвердил выход.");
    expect(screen.getByRole("button", { name: "Выйти" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Войти" })).not.toBeInTheDocument();
  });

  it("clears private state immediately when another tab broadcasts logout", async () => {
    class TestBroadcastChannel extends EventTarget {
      static latest: TestBroadcastChannel | null = null;
      constructor(readonly name: string) {
        super();
        TestBroadcastChannel.latest = this;
      }
      close(): void {}
      postMessage(): void {}
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    const authClient = new AuthClient("https://api.test");
    vi.spyOn(authClient, "restore").mockResolvedValue(activeSession());
    vi.spyOn(authClient, "getEmployees").mockResolvedValue({ employees: [] });
    renderApp("production", "production", "current", authClient);
    await screen.findByRole("button", { name: "Выйти" });

    act(() => TestBroadcastChannel.latest?.dispatchEvent(new MessageEvent("message", { data: "logout" })));

    expect(await screen.findByRole("button", { name: "Войти" })).toBeVisible();
  });

  it("does not restore a session after another tab logs out during initial restore", async () => {
    class TestBroadcastChannel extends EventTarget {
      static latest: TestBroadcastChannel | null = null;
      constructor(readonly name: string) {
        super();
        TestBroadcastChannel.latest = this;
      }
      close(): void {}
      postMessage(): void {}
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    const authClient = new AuthClient("https://api.test");
    let resolveRestore!: (value: ReturnType<typeof activeSession>) => void;
    vi.spyOn(authClient, "restore").mockImplementation(() => new Promise((resolve) => { resolveRestore = resolve; }));
    renderApp("production", "production", "current", authClient);
    await screen.findByRole("status", { name: "API подключён" });

    act(() => TestBroadcastChannel.latest?.dispatchEvent(new MessageEvent("message", { data: "logout" })));
    await act(async () => resolveRestore(activeSession()));

    expect(await screen.findByRole("button", { name: "Войти" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Выйти" })).not.toBeInTheDocument();
  });
});
