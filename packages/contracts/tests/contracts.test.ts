import { describe, expect, test } from "bun:test";

import {
  ApiErrorResponseSchema,
  SystemHealthResponseSchema,
} from "../src/index";

describe("shared API contracts", () => {
  test("accepts a health response that a current client can render", () => {
    const result = SystemHealthResponseSchema.parse({
      status: "ok",
      apiVersion: "v1",
      environment: "local",
      apiBuild: "dev",
      compatibility: "current",
    });

    expect(result.environment).toBe("local");
    expect(result.compatibility).toBe("current");
  });

  test("rejects an unknown deployment environment", () => {
    expect(() =>
      SystemHealthResponseSchema.parse({
        status: "ok",
        apiVersion: "v1",
        environment: "staging",
        apiBuild: "dev",
        compatibility: "current",
      }),
    ).toThrow();
  });

  test("preserves actionable field errors without technical details", () => {
    const result = ApiErrorResponseSchema.parse({
      code: "VALIDATION_ERROR",
      message: "Исправьте отмеченные поля",
      fieldErrors: { phone: ["Укажите корректный номер"] },
      correlationId: "d0b8e9bd-f30b-46b1-a330-1c1a2b13f4fe",
      retryable: false,
    });

    expect(result.fieldErrors?.phone).toEqual(["Укажите корректный номер"]);
    expect(result.retryable).toBeFalse();
  });
});
