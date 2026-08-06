import { z } from "@hono/zod-openapi";

export const AppEnvironmentSchema = z
  .enum(["local", "preview", "demo", "production"])
  .openapi("AppEnvironment");

export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export const ClientCompatibilitySchema = z
  .enum(["current", "update_available", "update_required"])
  .openapi("ClientCompatibility");

export type ClientCompatibility = z.infer<typeof ClientCompatibilitySchema>;

export const ApiErrorResponseSchema = z
  .object({
    code: z.string().min(1).openapi({ example: "VALIDATION_ERROR" }),
    message: z.string().min(1).openapi({ example: "Исправьте отмеченные поля" }),
    fieldErrors: z
      .record(z.string(), z.array(z.string().min(1)).min(1))
      .optional()
      .openapi({ example: { phone: ["Укажите корректный номер"] } }),
    correlationId: z.string().uuid().openapi({
      example: "d0b8e9bd-f30b-46b1-a330-1c1a2b13f4fe",
    }),
    retryable: z.boolean().openapi({ example: false }),
  })
  .openapi("ApiErrorResponse");

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const SystemHealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    apiVersion: z.literal("v1"),
    environment: AppEnvironmentSchema,
    apiBuild: z.string().min(1),
    compatibility: ClientCompatibilitySchema,
  })
  .openapi("SystemHealthResponse");

export type SystemHealthResponse = z.infer<typeof SystemHealthResponseSchema>;
