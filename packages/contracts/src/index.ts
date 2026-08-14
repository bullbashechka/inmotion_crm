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

export const RouteAccessClassSchema = z
  .enum(["public", "crm_session", "password_change", "recovery", "service_admin"])
  .openapi("RouteAccessClass");

export type RouteAccessClass = z.infer<typeof RouteAccessClassSchema>;

export const AuthSessionStateSchema = z
  .enum(["active", "warning", "password_change_required"])
  .openapi("AuthSessionState");

export type AuthSessionState = z.infer<typeof AuthSessionStateSchema>;

export const AuthSessionSchema = z
  .object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    state: AuthSessionStateSchema,
    serverNow: z.string().datetime(),
    warningAt: z.string().datetime(),
    idleExpiresAt: z.string().datetime(),
    absoluteExpiresAt: z.string().datetime(),
    revision: z.number().int().positive(),
  })
  .openapi("AuthSession");

export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const UsernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{1,62}[a-zA-Z0-9])?$/, "Используйте 3–64 латинских символа, цифры, точку, дефис или подчёркивание.")
  .openapi("Username");

export const RecoveryEmailSchema = z.string().trim().toLowerCase().email().max(320).openapi("RecoveryEmail");

export const SignInRequestSchema = z
  .object({
    login: UsernameSchema,
    password: z.string().min(1).max(1024),
    attemptId: z.string().uuid(),
  })
  .strict()
  .openapi("SignInRequest");

export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const SignInResponseSchema = z
  .object({
    accessToken: z.string().min(32),
    accessTokenExpiresAt: z.string().datetime(),
    session: AuthSessionSchema,
  })
  .strict()
  .openapi("SignInResponse");

export type SignInResponse = z.infer<typeof SignInResponseSchema>;

export const ContinueSessionResponseSchema = z
  .object({ session: AuthSessionSchema })
  .strict()
  .openapi("ContinueSessionResponse");

export type ContinueSessionResponse = z.infer<typeof ContinueSessionResponseSchema>;

export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(12).max(1024),
  })
  .strict()
  .openapi("ChangePasswordRequest");

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const PasswordRecoveryRequestSchema = z
  .object({ login: UsernameSchema })
  .strict()
  .openapi("PasswordRecoveryRequest");

export type PasswordRecoveryRequest = z.infer<typeof PasswordRecoveryRequestSchema>;

export const PasswordRecoveryResetRequestSchema = z
  .object({ newPassword: z.string().min(12).max(1024) })
  .strict()
  .openapi("PasswordRecoveryResetRequest");

export type PasswordRecoveryResetRequest = z.infer<typeof PasswordRecoveryResetRequestSchema>;

export const CreateEmployeeRequestSchema = z
  .object({
    fullName: z.string().min(1).max(200),
    contactEmail: RecoveryEmailSchema,
    login: UsernameSchema,
    roleId: z.string().uuid(),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .openapi("CreateEmployeeRequest");

export type CreateEmployeeRequest = z.infer<typeof CreateEmployeeRequestSchema>;

export const CreateEmployeeResponseSchema = z
  .object({
    employeeId: z.string().uuid(),
    employmentEpochId: z.string().uuid(),
    provisioningState: z.enum(["pending_activation", "provisioning"]),
  })
  .strict()
  .openapi("CreateEmployeeResponse");

export type CreateEmployeeResponse = z.infer<typeof CreateEmployeeResponseSchema>;

export const RecordScopeSchema = z
  .object({ records: z.enum(["own", "assigned", "all"]) })
  .strict()
  .openapi("RecordScope");

export type RecordScope = z.infer<typeof RecordScopeSchema>;

export const EmployeeAccessStateSchema = z.enum([
  "active",
  "pending_activation",
  "suspended",
  "security_quarantined",
  "terminated",
]);
export type EmployeeAccessState = z.infer<typeof EmployeeAccessStateSchema>;

export const EmployeeListItemSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().min(1),
  login: UsernameSchema.nullable(),
  roles: z.array(z.string().min(1)),
  accessState: EmployeeAccessStateSchema,
  credentialState: z.string().min(1),
  temporaryPasswordExpiresAt: z.string().datetime().nullable(),
  lastSignInAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
}).strict();

export type EmployeeListItem = z.infer<typeof EmployeeListItemSchema>;

export const EffectivePermissionSchema = z.object({
  permissionCode: z.string().min(1),
  resourceFamily: z.string().min(1),
  scope: z.enum(["own", "assigned", "all"]),
  source: z.enum(["role", "override"]),
  sourceLabel: z.string().min(1),
  expiresAt: z.string().datetime().nullable(),
}).strict();

export const EmployeeDetailSchema = EmployeeListItemSchema.extend({
  recoveryEmail: RecoveryEmailSchema,
  assignedRoles: z.array(z.object({ id: z.string().uuid(), code: z.string().min(1), source: z.string().min(1) }).strict()),
  effectivePermissions: z.array(EffectivePermissionSchema),
  overrides: z.array(z.object({ permissionCode: z.string().min(1), mode: z.enum(["replace", "deny"]), scope: RecordScopeSchema.nullable(), expiresAt: z.string().datetime().nullable(), reason: z.string().min(1) }).strict()),
}).strict();

export type EmployeeDetail = z.infer<typeof EmployeeDetailSchema>;

export const EmployeeListResponseSchema = z.object({ employees: z.array(EmployeeListItemSchema) }).strict();
export type EmployeeListResponse = z.infer<typeof EmployeeListResponseSchema>;

export const UnlockEmployeeRequestSchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict()
  .openapi("UnlockEmployeeRequest");

export type UnlockEmployeeRequest = z.infer<typeof UnlockEmployeeRequestSchema>;

export const IssueTemporaryPasswordRequestSchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict()
  .openapi("IssueTemporaryPasswordRequest");

export type IssueTemporaryPasswordRequest = z.infer<typeof IssueTemporaryPasswordRequestSchema>;

export const IssueTemporaryPasswordResponseSchema = z
  .object({ temporaryPassword: z.string().min(16) })
  .strict()
  .openapi("IssueTemporaryPasswordResponse");

export type IssueTemporaryPasswordResponse = z.infer<typeof IssueTemporaryPasswordResponseSchema>;

export const OffboardEmployeeRequestSchema = z
  .object({
    leadReplacementEmployeeId: z.string().uuid().optional(),
    medicalCaseReplacementEmployeeId: z.string().uuid().optional(),
    confirmedNoReassignment: z.boolean().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .openapi("OffboardEmployeeRequest");

export type OffboardEmployeeRequest = z.infer<typeof OffboardEmployeeRequestSchema>;

export const RehireEmployeeRequestSchema = z
  .object({
    contactEmail: RecoveryEmailSchema,
    login: UsernameSchema,
    roleId: z.string().uuid(),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .openapi("RehireEmployeeRequest");

export type RehireEmployeeRequest = z.infer<typeof RehireEmployeeRequestSchema>;

export const AssignRoleRequestSchema = z
  .object({ roleId: z.string().uuid(), reason: z.string().min(1).max(500) })
  .strict()
  .openapi("AssignRoleRequest");

export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

export const RevokeRoleRequestSchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict()
  .openapi("RevokeRoleRequest");

export type RevokeRoleRequest = z.infer<typeof RevokeRoleRequestSchema>;

export const SetPermissionOverrideRequestSchema = z
  .object({
    mode: z.enum(["replace", "deny"]),
    scope: RecordScopeSchema.optional(),
    expiresAt: z.string().datetime().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "replace" && value.scope === undefined) context.addIssue({ code: "custom", path: ["scope"], message: "Для replace необходима область данных." });
    if (value.mode === "deny" && value.scope !== undefined) context.addIssue({ code: "custom", path: ["scope"], message: "Для deny область данных не передаётся." });
  })
  .openapi("SetPermissionOverrideRequest");

export type SetPermissionOverrideRequest = z.infer<typeof SetPermissionOverrideRequestSchema>;

export const PublishRoleRevisionRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    grants: z.array(z.object({ permissionCode: z.string().min(1).max(120), scope: RecordScopeSchema }).strict()).min(1),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .openapi("PublishRoleRevisionRequest");

export type PublishRoleRevisionRequest = z.infer<typeof PublishRoleRevisionRequestSchema>;
