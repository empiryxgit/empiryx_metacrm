// The fixed permission catalog. Custom roles are built by picking a subset
// of these codes (see roles.permissions, jsonb string[]) - the catalog
// itself is not user-editable, which keeps every permission check in the
// codebase referring to a known, typo-proof constant instead of an
// arbitrary string an admin typed into a role editor.

export const PERMISSIONS = {
  COMPANY_MANAGE: "company.manage", // company profile/settings
  USERS_MANAGE: "users.manage", // create/edit/disable users
  ROLES_MANAGE: "roles.manage", // create/edit/delete custom roles
  CAMPAIGNS_VIEW: "campaigns.view",
  CAMPAIGNS_MANAGE: "campaigns.manage", // create/edit/archive campaigns
  WEBHOOKS_MANAGE: "webhooks.manage", // configure a campaign's Meta webhook
  DASHBOARD_VIEW: "dashboard.view",
  PIPELINE_VIEW: "pipeline.view",
  PIPELINE_MANAGE: "pipeline.manage", // move leads between stages
  LEADS_VIEW: "leads.view",
  LEADS_EXPORT: "leads.export",
  LEADS_MANAGE: "leads.manage", // manually add a customer / edit lead-owned fields
  FORMS_VIEW: "forms.view", // see the Forms list + individual form definitions
  FORMS_MANAGE: "forms.manage", // create/edit/publish/archive forms in the builder
  SUBMISSIONS_VIEW: "submissions.view", // view the Submissions list/detail for this company's forms
  // Create/edit/archive branches and manage which users belong to them.
  // Also doubles as the "company-wide branch visibility" flag: a user who
  // holds this permission sees every branch's data; a user who doesn't is
  // restricted to whichever branch(es) they're a member of (or unrestricted,
  // same as before this feature existed, if they belong to none) - see
  // src/application/branchAccess.ts.
  BRANCHES_MANAGE: "branches.manage",
  // Connect/disconnect the tenant's Meta Business account (Settings ->
  // Integrations -> Meta) and choose which Pages/ad accounts it uses -
  // deliberately separate from the legacy, per-campaign WEBHOOKS_MANAGE
  // above: this one governs the tenant-wide OAuth connection itself, not
  // any single campaign's webhook config.
  INTEGRATIONS_MANAGE: "integrations.manage",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionCode[] = Object.values(PERMISSIONS);

export const PERMISSION_CATALOG: Array<{ code: PermissionCode; label: string; category: string }> = [
  { code: PERMISSIONS.DASHBOARD_VIEW, label: "View dashboard", category: "General" },
  { code: PERMISSIONS.COMPANY_MANAGE, label: "Manage company profile & settings", category: "Administration" },
  { code: PERMISSIONS.USERS_MANAGE, label: "Create and manage users", category: "Administration" },
  { code: PERMISSIONS.ROLES_MANAGE, label: "Create and manage roles", category: "Administration" },
  { code: PERMISSIONS.CAMPAIGNS_VIEW, label: "View campaigns", category: "Campaigns" },
  { code: PERMISSIONS.CAMPAIGNS_MANAGE, label: "Create and manage campaigns", category: "Campaigns" },
  { code: PERMISSIONS.WEBHOOKS_MANAGE, label: "Configure Meta webhook integration", category: "Campaigns" },
  { code: PERMISSIONS.PIPELINE_VIEW, label: "View pipeline board", category: "Pipeline" },
  { code: PERMISSIONS.PIPELINE_MANAGE, label: "Move leads between pipeline stages", category: "Pipeline" },
  { code: PERMISSIONS.LEADS_VIEW, label: "View leads", category: "Leads" },
  { code: PERMISSIONS.LEADS_EXPORT, label: "Export lead data", category: "Leads" },
  { code: PERMISSIONS.LEADS_MANAGE, label: "Manually add customers", category: "Leads" },
  { code: PERMISSIONS.FORMS_VIEW, label: "View forms", category: "Forms" },
  { code: PERMISSIONS.FORMS_MANAGE, label: "Create and manage forms", category: "Forms" },
  { code: PERMISSIONS.SUBMISSIONS_VIEW, label: "View form submissions", category: "Forms" },
  { code: PERMISSIONS.BRANCHES_MANAGE, label: "Create and manage branches", category: "Administration" },
  { code: PERMISSIONS.INTEGRATIONS_MANAGE, label: "Connect and manage the Meta integration", category: "Integrations" },
];

/** @deprecated Superseded by the per-industry stage lists in
 * src/domain/industryTemplates.ts (getIndustryTemplate(company.industryTemplate).stages) -
 * valid pipeline stages now depend on the company's selected industry, so a
 * single fixed list can no longer represent every tenant. Kept only so any
 * remaining import of this symbol still typechecks; do not use it for new
 * pipeline/stage validation. */
export const PIPELINE_STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "site_visit", label: "Site Visit" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number]["key"];

export const PIPELINE_STAGE_KEYS: PipelineStage[] = PIPELINE_STAGES.map((s) => s.key);
