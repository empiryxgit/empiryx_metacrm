#!/usr/bin/env node
// -----------------------------------------------------------------------
// Setu CRM — seed demo campaigns + leads into an EXISTING tenant
// -----------------------------------------------------------------------
// Unlike seed-demo-data.mjs (which always registers a brand-new demo
// company), this script logs in as a REAL, already-onboarded user and adds
// realistic campaigns + leads to THEIR tenant, so their own account (and
// their own RUTA AI Assistant WhatsApp conversations) has believable data
// to query against ("how many leads did we get today", "pending
// follow-ups", etc.).
//
// It is intentionally conservative about what it touches:
//   - Never creates a new company/user — reuses what already exists.
//   - Never edits the tenant's existing default "Add Customer" form or its
//     CRM defaults.
//   - Creates ONE throwaway internal form ("Demo Data Seed — safe to
//     delete") to submit leads through (this is the only real, safe way to
//     create leads with the app's own validation rules — the public
//     /api/forms/{id}/submit + /api/public/forms/{key}/submit paths don't
//     let you set pipelineStage/owner directly). That form is archived
//     automatically at the end of the run; nothing else in the account is
//     touched.
//   - Reads the tenant's ACTUAL industry template (stages + custom fields)
//     from /api/pipeline at runtime instead of assuming real_estate, so
//     this works for any industry.
//
// Requires Node.js 18.17+ (uses res.headers.getSetCookie(), native fetch).
//
// Usage:
//   RUTA_EMAIL=mitul@empiryx.cm RUTA_PASSWORD='...' node seed-existing-tenant-data.mjs
//
// Optional overrides:
//   BASE_URL=https://uat.ruta.empiryx.com node seed-existing-tenant-data.mjs
//   CAMPAIGN_COUNT=4 node seed-existing-tenant-data.mjs   (default 4)
//   LEAD_COUNT=35 node seed-existing-tenant-data.mjs      (default 35 total leads, split as
//                                                           evenly as possible across the
//                                                           CAMPAIGN_COUNT campaigns and
//                                                           funnel-shaped within each one across
//                                                           that tenant's own pipeline stages)
//
// Run this yourself — it needs your real login password, which this
// assistant should never handle on your behalf.
// -----------------------------------------------------------------------

const BASE_URL = ("https://uatruta.empiryx.com").replace(/\/+$/, "");
const EMAIL = process.env.RUTA_EMAIL;
const PASSWORD = process.env.RUTA_PASSWORD;
const CAMPAIGN_COUNT = Number(process.env.CAMPAIGN_COUNT || 4);
const TOTAL_LEADS = Number(process.env.LEAD_COUNT || 35);

if (!EMAIL || !PASSWORD) {
  console.error(
    "Set RUTA_EMAIL and RUTA_PASSWORD before running this script, e.g.:\n\n" +
      "  RUTA_EMAIL=mitul@empiryx.cm RUTA_PASSWORD='yourpassword' node seed-existing-tenant-data.mjs\n",
  );
  process.exit(1);
}

{
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 18 || (major === 18 && minor < 17)) {
    console.error(`This script needs Node.js 18.17+. You're running Node ${process.versions.node}.`);
    process.exit(1);
  }
}

// ---- Tiny cookie jar + API helper (same pattern as seed-demo-data.mjs) ----

const cookieJar = new Map();

function updateCookieJar(res) {
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
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookieJar.size > 0) headers["Cookie"] = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  updateCookieJar(res);

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
}

function log(msg) {
  console.log(`\n${msg}`);
}

// ---- Demo data pools --------------------------------------------------

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna",
  "Ishaan", "Kabir", "Rohan", "Nikhil", "Priya", "Ananya", "Diya", "Saanvi",
  "Myra", "Aadhya", "Kiara", "Meera", "Neha", "Pooja", "Riya", "Sneha",
  "Tanvi", "Karan", "Varun", "Rachit", "Devansh", "Simran", "Heena", "Yash",
];
const LAST_NAMES = [
  "Shah", "Patel", "Mehta", "Sharma", "Gupta", "Verma", "Desai", "Trivedi",
  "Joshi", "Rao", "Iyer", "Nair", "Kapoor", "Malhotra", "Chopra", "Bhatt",
  "Pandya", "Solanki", "Thakkar", "Modi",
];
const LOCATIONS = ["Satellite", "Bopal", "Vastrapur", "SG Highway", "Thaltej", "Prahladnagar", "Maninagar", "Naranpura", "Chandkheda", "Gota"];

// Now that RUTA scopes leads by campaign (not branch), we seed a handful of
// distinctly-named campaigns rather than one generic name repeated, so
// campaign lists/dashboards/filters have realistic-looking rows to check
// against, not placeholder duplicates. These themes cycle (with an index
// suffix for uniqueness) to cover CAMPAIGN_COUNT campaigns, however many
// that is — the pool of themes below is intentionally larger than the
// default CAMPAIGN_COUNT so a higher override still gets distinct names
// for a while before it starts cycling.
const CAMPAIGN_THEMES = [
  "Diwali Property Drive", "New Year Site Visit Push", "Website Enquiries - Ongoing",
  "Summer Special Offer", "Republic Day Sale", "Independence Day Campaign",
  "Monsoon Booking Bonanza", "Flash Sale Weekend", "Referral Rewards Push",
  "Instagram Reels Promo", "Facebook Lead Gen - Tier 1", "Facebook Lead Gen - Tier 2",
  "Google Display Retargeting", "WhatsApp Broadcast Campaign", "Local SEO Leads",
  "Premium Listings Showcase", "First-Time Buyer Special", "Investor Outreach",
  "NRI Buyer Campaign", "Corporate Tie-up Leads", "Walk-in Event Promotion",
  "Weekend Site Visit Special", "Festive Season Push", "Early Bird Booking Offer",
  "Loyalty Referral Drive", "Metro Corridor Launch", "New Project Launch Buzz",
  "Year-End Clearance Push", "Story Ads Retargeting", "Carousel Ads - New Leads",
];

function pick(arr, i) {
  return arr[((i % arr.length) + arr.length) % arr.length];
}

// Generates CAMPAIGN_COUNT campaign plans with varied, human-readable
// names (cycling through CAMPAIGN_THEMES, disambiguated with a running
// number + this run's id) and platforms alternating facebook/instagram.
function buildCampaignPlans(count, runId) {
  const plans = [];
  for (let i = 0; i < count; i++) {
    const theme = pick(CAMPAIGN_THEMES, i);
    plans.push({
      name: `${theme} ${i + 1} (${runId})`,
      platform: pick(["facebook", "instagram"], i),
    });
  }
  return plans;
}

// Generates a plausible value for one of the tenant's CUSTOM (industry-
// specific) lead fields, from /api/pipeline's `template.fields`. Special-
// cases the field keys used by every built-in industry template (real
// estate / solar / healthcare / education / ecommerce) with realistic
// pools; falls back to a generic value by fieldType for anything else
// (a custom/edited template) so this never breaks on an unexpected key.
function valueForCustomField(field, index) {
  const location = pick(LOCATIONS, index);
  switch (field.key) {
    case "property":
      return `${pick([1, 2, 3, 4], index)} BHK ${pick(["Apartment", "Villa"], index)} in ${location}`;
    case "propertyType":
      return pick(field.options ?? ["Apartment", "Villa", "Plot", "Commercial"], index + 1);
    case "budget":
    case "orderValue": {
      const lakhs = 25 + ((index * 7) % 125);
      return String(lakhs * 100000);
    }
    case "location":
      return location;
    case "monthlyBill":
      return String(1500 + ((index * 137) % 8000));
    case "systemCapacity":
      return String(2 + (index % 8));
    case "serviceInterest":
      return pick(["General Consultation", "Specialist Referral", "Diagnostic Package", "Follow-up Visit"], index);
    case "patientType":
      return pick(field.options ?? ["New Patient", "Existing Patient", "Referral"], index);
    case "preferredDoctor":
      return pick(["Dr. Mehta", "Dr. Shah", "Dr. Iyer", "Dr. Nair"], index);
    case "insuranceProvider":
      return pick(["Star Health", "HDFC Ergo", "ICICI Lombard", "Self-pay"], index);
    case "courseInterest":
      return pick(["MBA", "Data Science Bootcamp", "B.Tech CSE", "UX Design Certificate"], index);
    case "preferredIntake":
      return pick(["Jan 2027", "Jul 2027", "Jan 2028"], index);
    case "studentType":
      return pick(field.options ?? ["Domestic", "International"], index);
    case "productInterest":
      return pick(["Wireless Earbuds", "Smart Watch", "Office Chair", "Standing Desk"], index);
    case "quantity":
      return String(1 + (index % 20));
    case "channel":
      return pick(field.options ?? ["Website", "Marketplace", "Wholesale", "Retail"], index);
    default:
      break;
  }
  switch (field.type) {
    case "select":
      return pick(field.options && field.options.length ? field.options : ["Other"], index);
    case "currency":
      return String((25 + ((index * 11) % 125)) * 100000);
    case "number":
      return String(1 + (index % 10));
    default:
      return `${field.label} #${index}`;
  }
}

function stageNote(stage) {
  if (stage.isWon) return "Closed successfully.";
  if (stage.isClosed) return "Did not convert — went with another option or budget mismatch.";
  if (stage.isInitial) return "Fresh inquiry, not yet contacted.";
  if (stage.isQualified) return "Requirement and budget confirmed, moving forward.";
  if (stage.isMilestone) return `${stage.label} completed — following up on next steps.`;
  return `In progress — currently at "${stage.label}".`;
}

// Funnel-shaped distribution over however many stages this tenant's
// industry template actually has (varies: real_estate has 8, "general"
// has only 4, etc.) — front-loaded toward the initial stage, tapering off
// toward the closed (won/lost) stages, at least 1 lead per stage whenever
// there are enough leads to go around.
//
// TOTAL_LEADS is split across CAMPAIGN_COUNT campaigns (see main()'s own
// perCampaign/remainder math below), so a single campaign's own share can
// legitimately be SMALLER than the tenant's stage count — e.g. the default
// 35 leads / 4 campaigns is ~8-9 leads/campaign, which already undercuts an
// 8-stage real_estate template, and a lower LEAD_COUNT or higher
// CAMPAIGN_COUNT override makes this even more likely. The original
// "always >= 1 per stage" minimum can't be met in that case, and the old
// balancing loop below would spin forever trying to shave counts back down
// to a floor of 1 that every stage was already at. Handle that case
// explicitly: give exactly one lead each to the `total` highest-weighted
// stages (front-of-funnel first) and leave the rest at 0, instead of
// looping.
function buildStagePlan(stages, total) {
  const n = stages.length;
  if (total <= 0) return stages.map((s) => ({ stage: s, count: 0 }));

  const rawWeights = stages.map((s, i) => (s.isWon ? 1.3 : s.isClosed ? 1 : n - i + 1));

  if (total < n) {
    const topIndexes = stages
      .map((_, i) => i)
      .sort((a, b) => rawWeights[b] - rawWeights[a])
      .slice(0, total);
    const chosen = new Set(topIndexes);
    return stages.map((s, i) => ({ stage: s, count: chosen.has(i) ? 1 : 0 }));
  }

  const sum = rawWeights.reduce((a, b) => a + b, 0);
  const counts = rawWeights.map((w) => Math.max(1, Math.round((w / sum) * total)));
  let diff = total - counts.reduce((a, b) => a + b, 0);
  let idx = 0;
  while (diff !== 0) {
    const i = idx % n;
    if (diff > 0) {
      counts[i]++;
      diff--;
    } else if (counts[i] > 1) {
      counts[i]--;
      diff++;
    }
    idx++;
  }
  return stages.map((s, i) => ({ stage: s, count: counts[i] }));
}

function buildLead(index, phoneBase, templateFields) {
  const first = pick(FIRST_NAMES, index + Math.floor(index / 3));
  const last = pick(LAST_NAMES, index * 2 + 1);
  const values = {
    fullName: `${first} ${last}`,
    phoneNumber: `+91 ${phoneBase + index}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}.seed${index}@example.com`,
  };
  for (const field of templateFields) {
    values[field.key] = valueForCustomField(field, index);
  }
  return values;
}

// ---- Main ---------------------------------------------------------------

async function main() {
  const runId = String(Date.now()).slice(-6);
  console.log(`Seeding realistic demo data on ${BASE_URL}`);
  console.log(`Logging in as: ${EMAIL}`);

  // 1. Log in as the real, existing user.
  log("1/7 Logging in...");
  const loginRes = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  const userId = loginRes.user.id;
  console.log(`   Logged in as ${loginRes.user.fullName} (${loginRes.user.id})`);
  if (loginRes.user.mustChangePassword) {
    console.warn("   ! This account has mustChangePassword set — some actions may be blocked until the password is changed in the app.");
  }

  // 2. Read this tenant's ACTUAL industry template (stages + custom
  //    fields) and the list of users to assign as lead owners — never
  //    assume real_estate, this works for any industry.
  log("2/7 Reading pipeline template (stages, custom fields, owners)...");
  const pipeline = await api("GET", "/api/pipeline");
  const template = pipeline.template;
  const owners = pipeline.owners && pipeline.owners.length ? pipeline.owners : [{ id: userId }];
  const validSources = (pipeline.sources || [])
    .map((s) => s.key)
    .filter((k) => !["meta_lead_ads", "public_form"].includes(k));
  console.log(`   Industry template: ${template.key} (${template.stages.length} stages, ${template.fields.length} custom fields)`);

  // 3. Copy the tenant's EXISTING default internal form's field list — we
  //    never touch that form itself, just reuse its field definitions so
  //    our throwaway seed form is schema-compatible.
  log("3/7 Reading the existing internal form's field definitions...");
  const internalForms = await api("GET", "/api/forms?type=internal");
  const sourceForm = internalForms.forms[0];
  if (!sourceForm) throw new Error("No internal form found on this account.");
  const sourceFormDetail = await api("GET", `/api/forms/${sourceForm.id}`);
  const fieldDefs = sourceFormDetail.fields;

  // 4. Create CAMPAIGN_COUNT dummy campaigns (4 by default) with
  //    TOTAL_LEADS leads spread across them (35 by default) — a small,
  //    easy-to-eyeball batch for smoke-testing campaign lists/dashboard
  //    rollups now that branch scoping is gone and campaigns are the only
  //    scoping unit. Bump CAMPAIGN_COUNT/LEAD_COUNT for a heavier load.
  log(`4/7 Creating ${CAMPAIGN_COUNT} campaigns...`);
  const campaignPlans = buildCampaignPlans(CAMPAIGN_COUNT, runId);
  const campaigns = [];
  for (const plan of campaignPlans) {
    const res = await api("POST", "/api/campaigns", { name: plan.name, platform: plan.platform });
    campaigns.push(res.campaign);
    console.log(`   Campaign created: "${res.campaign.name}" (${res.campaign.id})`);
  }

  // 5. Create ONE throwaway internal form to submit leads through — keeps
  //    the tenant's real "Add Customer" form/defaults completely untouched.
  log('5/7 Creating a throwaway "Demo Data Seed" form...');
  const seedForm = await api("POST", "/api/forms", {
    name: `Demo Data Seed ${runId} (safe to delete)`,
    description: "Created by seed-existing-tenant-data.mjs to seed realistic demo leads. Safe to archive/delete.",
    type: "internal",
    fields: fieldDefs,
  });
  await api("POST", `/api/forms/${seedForm.form.id}/publish`, {});
  console.log(`   Seed form created + published: ${seedForm.form.id}`);

  // 6. Submit leads, split across the 3 campaigns, funnel-shaped across
  //    this tenant's real pipeline stages.
  log(`6/7 Submitting ${TOTAL_LEADS} leads across ${campaigns.length} campaigns...`);
  const perCampaign = Math.floor(TOTAL_LEADS / campaigns.length);
  const remainder = TOTAL_LEADS - perCampaign * campaigns.length;
  let leadIndex = 0;
  let created = 0;
  let failed = 0;
  const summary = [];

  for (let c = 0; c < campaigns.length; c++) {
    const campaign = campaigns[c];
    const campaignTotal = perCampaign + (c < remainder ? 1 : 0);
    // Point the seed form's default campaign at THIS campaign for this
    // batch (only mutates our own throwaway form, never the real one).
    await api("PUT", `/api/forms/${seedForm.form.id}`, { defaultCrmCampaignId: campaign.id });

    const stagePlan = buildStagePlan(template.stages, campaignTotal);
    let campaignCreated = 0;
    for (const { stage, count } of stagePlan) {
      for (let i = 0; i < count; i++) {
        const lead = buildLead(leadIndex, 9800000000 + c * 100000, template.fields);
        const owner = pick(owners, leadIndex).id;
        const source = pick(validSources.length ? validSources : ["manual"], leadIndex);
        const nextFollowUpAt = stage.isClosed ? undefined : new Date(Date.now() + (1 + (leadIndex % 5)) * 24 * 60 * 60 * 1000).toISOString();
        try {
          await api("POST", `/api/forms/${seedForm.form.id}/submit`, {
            values: {
              ...lead,
              source,
              ownerId: owner,
              pipelineStage: stage.key,
              notes: stageNote(stage),
              ...(nextFollowUpAt ? { nextFollowUpAt } : {}),
            },
          });
          created++;
          campaignCreated++;
        } catch (err) {
          failed++;
          console.warn(`   ! Failed to create lead #${leadIndex} (campaign="${campaign.name}", stage=${stage.key}): ${err.message}`);
        }
        leadIndex++;
      }
    }
    summary.push({ campaign: campaign.name, created: campaignCreated });
    console.log(`   ${campaign.name}: ${campaignCreated} leads created`);
  }

  // 7. Archive the seed form — it's done its job; leads stay, form just
  //    drops out of the active Forms list.
  log("7/7 Archiving the seed form...");
  await api("POST", `/api/forms/${seedForm.form.id}/archive`, {});
  console.log("   Done.");

  // ---- Summary ----------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log("Demo data seeded into your EXISTING account:");
  for (const s of summary) console.log(`  Campaign: ${s.campaign} — ${s.created} leads`);
  console.log(`  Total leads created: ${created}${failed ? ` (${failed} failed — see warnings above)` : ""}`);
  console.log("=".repeat(72));
  console.log("\nNothing else on the account was touched — no new users,");
  console.log("and your real \"Add Customer\" form/defaults were never edited.");
}

main().catch((err) => {
  console.error("\nSeed script failed:", err.message);
  process.exit(1);
});
