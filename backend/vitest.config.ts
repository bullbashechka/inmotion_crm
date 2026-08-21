import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerOptions = {
  // Tests must never import developer credentials from .dev.vars/.env.
  wrangler: { configPath: "./tests/wrangler.test.jsonc", secrets: { TEST_ONLY_NOOP: "unused" } },
};

export default defineConfig({
  plugins: [cloudflareTest(workerOptions)],
  ssr: {
    optimizeDeps: {
      rolldownOptions: {
        external: ["crypto", "dns", "events", "fs", "net", "path", "stream", "string_decoder", "tls", "util", "node:module"],
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
