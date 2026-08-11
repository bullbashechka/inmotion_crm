import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerOptions = {
  wrangler: { configPath: "./wrangler.test.jsonc" },
};

export default defineConfig({
  plugins: [cloudflareTest(workerOptions)],
  ssr: {
    optimizeDeps: {
      rolldownOptions: {
        external: ["crypto", "dns", "fs", "net", "path", "stream", "tls", "node:module"],
      },
    },
  },
  test: {
    pool: cloudflarePool(workerOptions),
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["pg"],
        },
      },
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.test.ts", "tests/**/*.performance.test.ts"],
  },
});
