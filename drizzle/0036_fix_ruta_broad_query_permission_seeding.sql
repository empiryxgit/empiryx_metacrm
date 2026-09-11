-- Fix for audit Finding 2a (RUTA LMS pre-build audit):
-- "ruta_ai_assistant.broad_query" was unintentionally falling through
-- BASE_ALL_PERMISSIONS (src/domain/fixedRoles.ts) into every auto-seeded
-- "full access" system role - Owner, AGENCY_OWNER, AGENCY_ADMIN,
-- CLIENT_OWNER, CLIENT_ADMIN - despite that permission being documented
-- (src/domain/permissions.ts) as "deliberately off by default for every
-- role, including Owner ... opt-in, never inherited". createOwnerRole()
-- (src/infrastructure/db/repositories/tenancy.ts) additionally seeded the
-- literal, unfiltered ALL_PERMISSIONS for every plain "Owner" role.
--
-- The application code (fixedRoles.ts, tenancy.ts) has been fixed so no
-- FUTURE company/role seed carries this permission by default. This
-- migration is the one-time cleanup for roles ALREADY seeded before that
-- fix - system roles can't be edited through the app UI
-- (api/admin/roles/handler.ts blocks it), so there is no other way for an
-- existing tenant to shed this permission.
--
-- Scoped to is_system = true only: a custom role where an admin
-- deliberately opted a teammate into this permission via the role editor
-- (a legitimate, intentional grant) is left untouched. Idempotent - the
-- WHERE clause only matches rows that still carry the permission, so
-- re-running this migration after it has already applied is a no-op.
UPDATE "crm"."roles"
SET "permissions" = "permissions" - 'ruta_ai_assistant.broad_query',
    "updated_at" = now()
WHERE "is_system" = true
  AND "permissions" @> '["ruta_ai_assistant.broad_query"]'::jsonb;
