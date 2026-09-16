#!/usr/bin/env node
// -----------------------------------------------------------------------
// Setu CRM — Platform Admin: force-activate a customer onto the Yearly
// base plan
// -----------------------------------------------------------------------
// Fixes: `POST /api/campaigns -> 402 "You've reached your plan's campaign
// limit (1)"`. That "(1)" is the 15-day TRIAL's hard cap
// (TRIAL_CAMPAIGN_LIMIT in src/domain/trial.ts) — not a real plan limit.
// This script converts the account from trialing/trial_expired straight to
// an ACTIVE, paid Yearly base subscription the same way a real Razorpay
// payment would: it calls forceActivateSubscription
// (src/application/platformAdmin.ts) via the exact same endpoint the
// Platform Admin "Subscriptions" page's own "Force-activate" button calls
// (POST /api/platform-admin/subscriptions/:companyId) — no invented
// shortcut, no separate code path.
//
// Why ONE call fixes this everywhere: campaign/client limits, the trial
// banner, and the /subscription.html page all resolve entitlement LIVE
// from the same companies.subscriptionStatus / subscriptionCycle /
// subscriptionExpiresAt columns on every request
// (resolveEntitlementState in src/domain/trial.ts) — nothing caches this
// server-side, so there's no second place to update and no re-login
// needed on the tenant's side; their very next "Create campaign" click
// just works.
//
// Needs TWO separate sets of credentials — this script never guesses or
// reuses one for the other:
//   RUTA_ADMIN_EMAIL / RUTA_ADMIN_PASSWORD  - a Platform Admin login
//     (public/admin/login.html) - the actual authority to force-activate
//     anyone's subscription.
//   RUTA_EMAIL / RUTA_PASSWORD              - the target tenant's own
//     login (same vars as seed-existing-tenant-data.mjs) - used ONLY to
//     read their companyId + before/after entitlement. Never used to
//     change anything itself.
// Already know the target companyId? Skip the tenant login entirely by
// setting RUTA_COMPANY_ID instead of RUTA_EMAIL/RUTA_PASSWORD.
//
// Usage:
//   RUTA_ADMIN_EMAIL=admin@empiryx.com RUTA_ADMIN_PASSWORD='...' \
//   RUTA_EMAIL=mitul@empiryx.cm RUTA_PASSWORD='...' \
//   node set-yearly-plan.mjs
//
// Optional overrides:
//   BASE_URL=https://uatruta.empiryx.com node set-yearly-plan.mjs   (default)
//   BILLING_CYCLE=yearly node set-yearly-plan.mjs   (default; monthly|quarterly|halfyearly|yearly)
//   RUTA_COMPANY_ID=<uuid> node set-yearly-plan.mjs   (skip tenant login, target this company id directly)
//   REASON="..." node set-yearly-plan.mjs   (recorded on the platform_audit_logs row; default below)
//
// Run this yourself — it needs your real admin password, which this
// assistant should never handle on your behalf.
// -----------------------------------------------------------------------

const BASE_URL = (process.env.BASE_URL || "https://uatruta.empiryx.com").replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.RUTA_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.RUTA_ADMIN_PASSWORD;
const TENANT_EMAIL = process.env.RUTA_EMAIL;
const TENANT_PASSWORD = process.env.RUTA_PASSWORD;
const COMPANY_ID = process.env.RUTA_COMPANY_ID;
const CYCLE = process.env.BILLING_CYCLE || "yearly";
const REASON = process.env.REASON || "Force-activated to Yearly plan (seed/demo data testing needed more than the 1-campaign trial cap).";

const VALID_CYCLES = ["monthly", "quarterly", "halfyearly", "yearly"];

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error(
    "Set RUTA_ADMIN_EMAIL and RUTA_ADMIN_PASSWORD (your Platform Admin login) before running this script, e.g.:\n\n" +
      "  RUTA_ADMIN_EMAIL=admin@empiryx.com RUTA_ADMIN_PASSWORD='yourpassword' \\\n" +
      "  RUTA_EMAIL=mitul@empiryx.cm RUTA_PASSWORD='yourpassword' \\\n" +
      "  node set-yearly-plan.mjs\n",
  );
  process.exit(1);
}
if (!COMPANY_ID && (!TENANT_EMAIL || !TENANT_PASSWORD)) {
  console.error(
    "Either set RUTA_COMPANY_ID directly, or set RUTA_EMAIL + RUTA_PASSWORD (the target tenant's own login) so this script can look up their companyId.\n",
  );
  process.exit(1);
}
if (!VALID_CYCLES.includes(CYCLE)) {
  console.error(`BILLING_CYCLE must be one of ${VALID_CYCLES.join(", ")} — got "${CYCLE}".`);
  process.exit(1);
}

{
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 18 || (major === 18 && minor < 17)) {
    console.error(`This script needs Node.js 18.17+. You're running Node ${process.versions.node}.`);
    process.exit(1);
  }
}

// ---- Tiny cookie-jar-per-session API client (same pattern as
// seed-existing-tenant-data.mjs) — one instance per login so the Platform
// Admin session and the tenant session can never cross-contaminate. ----

function makeApiClient() {
  const cookieJar = new Map();
  return async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookieJar.size > 0) headers["Cookie"] = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")]
          : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx > -1) cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) {
      const msg = json && typeof json === "object" && json.error ? json.error : `HTTP ${res.status}`;
      throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json;
  };
}

function log(msg) {
  console.log(`\n${msg}`);
}

function printEntitlement(label, entitlement) {
  if (!entitlement) {
    console.log(`   ${label}: (unavailable)`);
    return;
  }
  const e = entitlement.entitlement;
  const stateLine =
    e.kind === "trialing"
      ? `trialing (${e.daysRemaining} day(s) left, ends ${e.trialEndsAt})`
      : e.kind === "trial_expired"
        ? `trial_expired (ended ${e.trialEndsAt})`
        : e.kind === "subscribed"
          ? `subscribed${e.expiresAt ? ` (renews/expires ${e.expiresAt})` : " (no expiry on file)"}`
          : `subscription_expired (expired ${e.expiresAt})`;
  console.log(`   ${label}: ${stateLine}`);
  console.log(`   ${label} campaigns: ${entitlement.campaigns.used} used / ${entitlement.campaigns.limit} limit`);
  if (entitlement.clients) {
    console.log(`   ${label} clients:   ${entitlement.clients.used} used / ${entitlement.clients.limit} limit`);
  }
}

async function main() {
  console.log(`Force-activating a ${CYCLE} plan on ${BASE_URL}`);

  // 1. Resolve the target companyId (+ show its BEFORE entitlement) via the
  //    tenant's own login, unless RUTA_COMPANY_ID was given directly.
  let companyId = COMPANY_ID;
  let companyName = null;
  const tenantApi = makeApiClient();

  if (!companyId) {
    log("1/3 Logging in as the target tenant (read-only — just to find their companyId)...");
    const loginRes = await tenantApi("POST", "/api/auth/login", { email: TENANT_EMAIL, password: TENANT_PASSWORD });
    companyId = loginRes.user.companyId;
    const me = await tenantApi("GET", "/api/auth/me");
    companyName = me.company.name;
    printEntitlement("BEFORE", me.entitlement);
    console.log(`   Target company: "${companyName}" (${companyId})`);
  } else {
    log(`1/3 Using RUTA_COMPANY_ID directly: ${companyId}`);
  }

  // 2. Log in as Platform Admin and force-activate the subscription.
  log("2/3 Logging in as Platform Admin...");
  const adminApi = makeApiClient();
  const adminLogin = await adminApi("POST", "/api/platform-admin/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  console.log(`   Logged in as ${adminLogin.admin.fullName} (${adminLogin.admin.email})`);

  log(`3/3 Force-activating the ${CYCLE} base plan for ${companyId}...`);
  const result = await adminApi("POST", `/api/platform-admin/subscriptions/${companyId}`, {
    action: "force_activate",
    cycle: CYCLE,
    reason: REASON,
  });
  console.log(`   subscriptionStatus=${result.subscriptionStatus} subscriptionCycle=${result.subscriptionCycle} subscriptionExpiresAt=${result.subscriptionExpiresAt}`);

  // 3. Confirm from the TENANT's own side too — same live read the
  //    campaign-creation check itself uses, so this is the real proof the
  //    402 is gone, not just a trust-the-write assumption.
  if (!COMPANY_ID) {
    const meAfter = await tenantApi("GET", "/api/auth/me");
    printEntitlement("AFTER ", meAfter.entitlement);
    // Entitlement is always resolved against the POOL ROOT company
    // (src/application/billing.ts's resolvePoolRootCompanyId) - an ordinary
    // Individual/Agency resolves to itself, but a company that is itself a
    // CLAIMED CLIENT of some agency resolves to that agency's row instead.
    // If companyId above was the client's own id, force-activating it is a
    // silent no-op (the client's own subscriptionStatus column is never
    // read). Surface that here rather than letting it pass quietly.
    if (meAfter.entitlement?.entitlement?.kind !== "subscribed") {
      console.warn(
        "\n   ! Still not showing as subscribed after the force-activate. If this account is a claimed CLIENT of an agency " +
          "(see /admin/agency in the app, or ask), its plan is the AGENCY's to activate - re-run this script with " +
          "RUTA_COMPANY_ID set to the AGENCY's own companyId instead.",
      );
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(`Done. "${companyName ?? companyId}" is now on an ACTIVE ${CYCLE} plan.`);
  console.log("Campaign/client limits, the trial banner, and /subscription.html all read");
  console.log("this live — no re-login or redeploy needed. Re-run the seed script now.");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("\nScript failed:", err.message);
  process.exit(1);
});
