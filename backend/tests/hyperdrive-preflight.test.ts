import { describe, expect, test } from "vitest";

import {
  extractHyperdriveBindingId,
  validateCloudflareHyperdriveResponse,
  validateSupabasePostgrestResponse,
} from "../src/db/hyperdrive-preflight";

const projectRef = "abcdefghijklmnopqrst";
const hyperdriveId = "1234567890abcdef1234567890abcdef";

function configuredBinding(id = hyperdriveId): unknown {
  return {
    hyperdrive: [{ binding: "HYPERDRIVE_FRESH", id }],
  };
}

function cloudflarePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    result: {
      caching: { disabled: true },
      origin: { host: `db.${projectRef}.supabase.co`, user: "postgres" },
      ...overrides,
    },
  };
}

describe("Hyperdrive deployment preflight", () => {
  test("reads the selected environment binding and rejects missing or placeholder bindings", () => {
    expect(extractHyperdriveBindingId({ env: { preview: configuredBinding() } }, "preview")).toBe(hyperdriveId);
    expect(() => extractHyperdriveBindingId({}, undefined)).toThrow("does not declare Hyperdrive");
    expect(() => extractHyperdriveBindingId(configuredBinding("00000000000000000000000000000000"))).toThrow("non-placeholder");
  });

  test("fails closed when Cloudflare rejects the request or caching is enabled", () => {
    expect(() => validateCloudflareHyperdriveResponse({ ok: false }, {}, projectRef)).toThrow("Cloudflare Hyperdrive API request failed");
    expect(() => validateCloudflareHyperdriveResponse({ ok: true }, cloudflarePayload({ caching: { disabled: false } }), projectRef)).toThrow("cache-disabled");
  });

  test("accepts only a Hyperdrive origin tied to the selected Supabase project", () => {
    expect(() => validateCloudflareHyperdriveResponse({ ok: true }, cloudflarePayload({ origin: { host: "db.otherproject.supabase.co", user: "postgres" } }), projectRef)).toThrow("does not match");
    expect(() => validateCloudflareHyperdriveResponse({ ok: true }, cloudflarePayload({ origin: { host: "aws-0-us-east-1.pooler.supabase.com", user: `postgres.${projectRef}` } }), projectRef)).not.toThrow();
  });

  test("rejects closed CRM schemas from Supabase PostgREST", () => {
    expect(() => validateSupabasePostgrestResponse({ ok: true }, { db_schema: "public, crm" })).toThrow("closed CRM schema");
    expect(() => validateSupabasePostgrestResponse({ ok: true }, { db_schema: "public, crm_internal" })).toThrow("closed CRM schema");
    expect(() => validateSupabasePostgrestResponse({ ok: true }, { db_schema: "public" })).not.toThrow();
  });
});
