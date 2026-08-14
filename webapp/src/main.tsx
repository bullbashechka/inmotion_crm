import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { getSystemHealth } from "./lib/api";
import { AuthClient } from "./lib/auth";
import { parseClientRuntimeConfig } from "./lib/runtime";
import "./index.css";

const runtime = parseClientRuntimeConfig(import.meta.env);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});
const authClient = new AuthClient(runtime.apiUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App
        clientEnvironment={runtime.environment}
        authClient={authClient}
        loadHealth={() => getSystemHealth(runtime.apiUrl, runtime.clientVersion)}
      />
    </QueryClientProvider>
  </StrictMode>,
);
