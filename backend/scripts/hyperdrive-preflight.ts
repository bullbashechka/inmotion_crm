import {
  extractHyperdriveBindingId,
  parseJsonc,
  validateCloudflareHyperdriveResponse,
  validateSupabasePostgrestResponse,
} from "../src/db/hyperdrive-preflight";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required for preflight.`);
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function selectedEnvironment(): string | undefined {
  const explicitEnvironment = optional("WRANGLER_ENV");
  const cloudflareEnvironment = optional("CLOUDFLARE_ENV");
  if (
    explicitEnvironment !== undefined
    && cloudflareEnvironment !== undefined
    && explicitEnvironment !== cloudflareEnvironment
  ) {
    throw new Error("WRANGLER_ENV and CLOUDFLARE_ENV must select the same environment.");
  }

  return explicitEnvironment ?? cloudflareEnvironment;
}

async function readWranglerConfiguration(): Promise<unknown> {
  const configuredPath = optional("WRANGLER_CONFIG_PATH");
  const file = Bun.file(configuredPath ?? new URL("../wrangler.jsonc", import.meta.url));
  if (!(await file.exists())) {
    throw new Error("Selected Wrangler configuration file is unavailable.");
  }

  return parseJsonc(await file.text());
}

const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const cloudflareToken = required("CLOUDFLARE_API_TOKEN");
const projectRef = required("SUPABASE_PROJECT_REF");
const supabaseToken = required("SUPABASE_ACCESS_TOKEN");
const hyperdriveId = extractHyperdriveBindingId(await readWranglerConfiguration(), selectedEnvironment());

const hyperdriveResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(hyperdriveId)}`, { headers: { Authorization: `Bearer ${cloudflareToken}` } });
validateCloudflareHyperdriveResponse(hyperdriveResponse, await hyperdriveResponse.json(), projectRef);

const postgrestResponse = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/postgrest`, { headers: { Authorization: `Bearer ${supabaseToken}` } });
validateSupabasePostgrestResponse(postgrestResponse, await postgrestResponse.json());
console.log("Hyperdrive and Supabase schema exposure preflight passed.");
