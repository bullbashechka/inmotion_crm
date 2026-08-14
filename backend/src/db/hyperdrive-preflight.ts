type JsonRecord = Record<string, unknown>;

type HttpResult = {
  ok: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedConfiguration(config: unknown, environment?: string): JsonRecord {
  if (!isRecord(config)) {
    throw new Error("Wrangler configuration must be an object.");
  }

  if (environment === undefined) {
    return config;
  }

  const environments = config.env;
  if (!isRecord(environments) || !isRecord(environments[environment])) {
    throw new Error("Selected Wrangler environment is missing from the configuration.");
  }

  return environments[environment];
}

export function isProvisionedHyperdriveId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value) && !/^0+$/.test(value);
}

export function extractHyperdriveBindingId(config: unknown, environment?: string): string {
  const bindings = selectedConfiguration(config, environment).hyperdrive;
  if (!Array.isArray(bindings)) {
    throw new Error("Selected Wrangler configuration does not declare Hyperdrive bindings.");
  }

  const matches = bindings.filter((binding) => isRecord(binding) && binding.binding === "HYPERDRIVE_FRESH");
  if (matches.length !== 1) {
    throw new Error("Selected Wrangler configuration must declare exactly one HYPERDRIVE_FRESH binding.");
  }

  const id = matches[0]?.id;
  if (!isProvisionedHyperdriveId(id)) {
    throw new Error("HYPERDRIVE_FRESH must use a provisioned non-placeholder Hyperdrive ID.");
  }

  return id;
}

function originMatchesSupabaseProject(origin: unknown, projectRef: string): boolean {
  if (!isRecord(origin) || typeof origin.host !== "string") {
    return false;
  }

  const host = origin.host.toLowerCase().replace(/\.$/, "");
  const normalizedProjectRef = projectRef.toLowerCase();
  if (host === `db.${normalizedProjectRef}.supabase.co`) {
    return true;
  }

  return host.endsWith(".pooler.supabase.com") && origin.user === `postgres.${normalizedProjectRef}`;
}

export function validateCloudflareHyperdriveResponse(
  response: HttpResult,
  payload: unknown,
  projectRef: string,
): void {
  if (!response.ok) {
    throw new Error("Cloudflare Hyperdrive API request failed.");
  }

  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.result)) {
    throw new Error("Cloudflare Hyperdrive API returned an invalid response.");
  }

  const caching = payload.result.caching;
  if (!isRecord(caching) || caching.disabled !== true) {
    throw new Error("Cloudflare Hyperdrive configuration is not explicitly cache-disabled.");
  }

  if (!originMatchesSupabaseProject(payload.result.origin, projectRef)) {
    throw new Error("Cloudflare Hyperdrive origin does not match the selected Supabase project.");
  }
}

export function validateSupabasePostgrestResponse(response: HttpResult, payload: unknown): void {
  if (!response.ok) {
    throw new Error("Supabase Management API PostgREST configuration request failed.");
  }

  if (!isRecord(payload) || typeof payload.db_schema !== "string") {
    throw new Error("Supabase Management API response does not contain authoritative db_schema.");
  }

  const exposedSchemas = payload.db_schema.split(",").map((schema) => schema.trim()).filter(Boolean);
  if (exposedSchemas.includes("crm") || exposedSchemas.includes("crm_internal")) {
    throw new Error("Supabase PostgREST exposed schemas include a closed CRM schema.");
  }
}

export function parseJsonc(source: string): unknown {
  let withoutComments = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (inString) {
      withoutComments += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      withoutComments += character;
      continue;
    }

    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      withoutComments += "\n";
      continue;
    }

    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    withoutComments += character;
  }

  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}
