#!/usr/bin/env node
// -----------------------------------------------------------------------
// Setu CRM — demo data seed script
// -----------------------------------------------------------------------
// Creates ONE brand-new demo company (via the app's own /api/auth/register
// flow), ONE branch, ONE campaign scoped to that branch, and a set of
// leads submitted through the app's real internal + public form endpoints
// — so the Dashboard, Pipeline, Leads, and Branch views all have real data
// to review.
//
// Deliberately does NOT touch Meta Lead Ads / webhooks in any way — no
// fake Graph API payloads, no source:"meta_lead_ads" leads, no webhook
// config. That integration is being wired up separately later.
//
// Requires Node.js 18.17+ (needs res.headers.getSetCookie(), native
// fetch). Run with:
//
//   node seed-demo-data.mjs
//
// Optional overrides:
//
//   BASE_URL=https://empiryx-metacrm.vercel.app node seed-demo-data.mjs
//   node seed-demo-data.mjs https://empiryx-metacrm.vercel.app
//
// The script prints the new company's login email/password at the end —
// save that, it is not shown again after this run.
// -----------------------------------------------------------------------

const BASE_URL = (process.argv[2] || process.env.BASE_URL || "https://empiryx-metacrm.vercel.app").replace(/\/+$/, "");

// ---- Node version guard -------------------------------------------------
{
  const [major, minor] = process.versions.node.split(".").map(Number);
  const tooOld = major < 18 || (major === 18 && minor < 17);
  if (tooOld) {
    console.error(
      `This script needs Node.js 18.17+ (for fetch + res.headers.getSetCookie()). ` +
        `You're running Node ${process.versions.node}. Please upgrade Node and re-run.`,
    );
    process.exit(1);
  }
}

// ---- Tiny cookie jar + API helper ---------------------------------------

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
    if (idx > -1) {
      cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookieJar.size > 0) {
    headers["Cookie"] = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

// Public endpoints must NOT carry the demo owner's auth cookie — a real
// anonymous visitor never has one. Simple unauthenticated fetch, no jar.
async function publicApi(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

// ---- Demo data pools ------------------------------------------------------

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
const LOCATIONS = [
  "Satellite", "Bopal", "Vastrapur", "SG Highway", "Thaltej", "Prahladnagar",
  "Maninagar", "Naranpura", "Chandkheda", "Gota",
];
const PROPERTY_TYPES = ["Apartment", "Villa", "Plot", "Commercial", "Other"];
const MANUAL_SOURCES = ["referral", "phone", "walk_in", "whatsapp", "website", "other"];

const STAGE_NOTES = {
  new: "Fresh inquiry, not yet contacted.",
  contacted: "Spoke on call, gauging budget and timeline.",
  qualified: "Budget and requirement confirmed, scheduling a site visit.",
  site_visit: "Site visit done, sharing more options in the same locality.",
  negotiation: "Interested after site visit, discussing final price.",
  booking: "Token amount received, documentation in progress.",
  won: "Booking confirmed — unit closed successfully.",
  lost: "Went with another developer over budget/location mismatch.",
};

// Funnel-shaped distribution across the real_estate template's stages.
const STAGE_PLAN = [
  { stage: "new", count: 5 },
  { stage: "contacted", count: 4 },
  { stage: "qualified", count: 4 },
  { stage: "site_visit", count: 3 },
  { stage: "negotiation", count: 2 },
  { stage: "booking", count: 2 },
  { stage: "won", count: 2 },
  { stage: "lost", count: 2 },
];
const PUBLIC_FORM_LEAD_COUNT = 8;

function pick(arr, i) {
  return arr[i % arr.length];
}

function propertyLabel(propertyType, location) {
  const bhk = pick([1, 2, 3, 4], Math.floor(Math.random() * 4));
  switch (propertyType) {
    case "Apartment":
      return `${bhk} BHK Apartment in ${location}`;
    case "Villa":
      return `${bhk} BHK Villa in ${location}`;
    case "Plot":
      return `${200 + bhk * 50} sq.yd Plot in ${location}`;
    case "Commercial":
      return `Commercial space in ${location}`;
    default:
      return `Property in ${location}`;
  }
}

function randomBudget() {
  // 25L - 1.5Cr, rounded to the nearest lakh.
  const lakhs = 25 + Math.floor(Math.random() * 125);
  return String(lakhs * 100000);
}

function buildLead(index, phoneBase) {
  const first = pick(FIRST_NAMES, index + Math.floor(index / 3));
  const last = pick(LAST_NAMES, index * 2 + 1);
  const fullName = `${first} ${last}`;
  const location = pick(LOCATIONS, index);
  const propertyType = pick(PROPERTY_TYPES, index + 1);
  return {
    fullName,
    phoneNumber: `+91 ${phoneBase + index}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}.demo${index}@example.com`,
    property: propertyLabel(propertyType, location),
    propertyType,
    budget: randomBudget(),
    location,
  };
}

// ---- Main -----------------------------------------------------------------

async function main() {
  const runId = String(Date.now()).slice(-8);
  const companyName = `Setu Demo Realty ${runId}`;
  const ownerEmail = `demo.owner.${runId}@empiryxtech-demo.test`;
  const ownerPassword = `DemoPass${runId}!`;
  const branchName = "Ahmedabad";
  const branchCode = `AMD${runId}`;
  const campaignName = "Diwali Property Drive";
  const salesEmail = `demo.sales.${runId}@empiryxtech-demo.test`;
  const salesFullName = "Priya Shah";

  console.log(`Seeding demo data on ${BASE_URL}`);
  console.log(`Company: ${companyName}`);

  // 1. Register the demo company + owner, and log in (register already
  //    logs the new owner in and sets cookies).
  log("1/9 Registering demo company + owner...");
  const registerRes = await api("POST", "/api/auth/register", {
    companyName,
    fullName: "Demo Owner",
    email: ownerEmail,
    password: ownerPassword,
    industry: "real_estate",
  });
  const ownerId = registerRes.user.id;
  console.log(`   Owner user id: ${ownerId}`);

  // 2. Onboarding step 1 — company profile.
  log("2/9 Setting company profile (onboarding step 1)...");
  await api("POST", "/api/onboarding/company", {
    industry: "real_estate",
    companySize: "11-50",
    timezone: "Asia/Kolkata",
  });

  // 3. Create the one branch.
  log(`3/9 Creating branch "${branchName}"...`);
  const branchRes = await api("POST", "/api/branches", {
    name: branchName,
    code: branchCode,
    city: "Ahmedabad",
    state: "Gujarat",
    status: "active",
  });
  const branchId = branchRes.branch.id;
  console.log(`   Branch id: ${branchId}`);

  // 4. Create the one campaign, scoped to that branch.
  log(`4/9 Creating campaign "${campaignName}" (scoped to ${branchName})...`);
  const campaignRes = await api("POST", "/api/campaigns", {
    name: campaignName,
    platform: "facebook",
    branchId,
  });
  const campaignId = campaignRes.campaign.id;
  console.log(`   Campaign id: ${campaignId}`);

  // 5. Finish onboarding (frontend wizard order: campaign, then complete).
  log("5/9 Completing onboarding...");
  await api("POST", "/api/onboarding/complete", {});

  // 6. One extra branch-scoped "sales" user, so Owner filters/columns on
  //    the Dashboard and Pipeline have more than one value to show.
  log(`6/9 Creating a branch sales user (${salesFullName})...`);
  const salesRole = await api("POST", "/api/admin/roles", {
    name: "Branch Sales Executive",
    description: "Demo role — manage leads/pipeline/forms for their own branch only.",
    permissions: [
      "dashboard.view",
      "pipeline.view",
      "pipeline.manage",
      "leads.view",
      "leads.manage",
      "campaigns.view",
      "forms.view",
      "submissions.view",
    ],
  });
  const salesUserRes = await api("POST", "/api/admin/users", {
    fullName: salesFullName,
    email: salesEmail,
    roleId: salesRole.role.id,
  });
  const salesUserId = salesUserRes.user.id;
  await api("POST", `/api/branches/${branchId}/users`, {
    userId: salesUserId,
    role: "member",
    isPrimary: true,
  });
  console.log(`   Sales user id: ${salesUserId} (temp password: ${salesUserRes.temporaryPassword})`);

  // 7. Scope the auto-provisioned internal ("Add Customer") form to this
  //    branch + campaign, so submissions default into them.
  log("7/9 Configuring the internal Add-Customer form...");
  const internalForms = await api("GET", "/api/forms?type=internal");
  const internalForm = internalForms.forms[0];
  if (!internalForm) throw new Error("No internal form found — registration should have auto-provisioned one.");
  await api("PUT", `/api/forms/${internalForm.id}`, {
    branchMode: "specific",
    branchId,
    defaultCrmCampaignId: campaignId,
  });

  // 8. Scope + publish the auto-provisioned public form (used for a
  //    handful of "website" leads, exercising the real public-submit
  //    flow — NOT Meta).
  log("8/9 Configuring + publishing the public form...");
  const publicForms = await api("GET", "/api/forms?type=public");
  const publicFormMeta = publicForms.forms[0];
  if (!publicFormMeta) throw new Error("No public form found — registration should have auto-provisioned one.");
  await api("PUT", `/api/forms/${publicFormMeta.id}`, {
    branchMode: "specific",
    branchId,
    defaultCrmCampaignId: campaignId,
    defaultSource: "public_form",
  });
  const publishedPublicForm = await api("POST", `/api/forms/${publicFormMeta.id}/publish`, {});
  const publicKey = publishedPublicForm.form.publicKey;
  console.log(`   Public form key: ${publicKey}`);
  console.log(`   Public form URL: ${BASE_URL}/public-form.html?key=${publicKey}`);

  // 9. Seed leads.
  log("9/9 Submitting leads through the internal form (varied stage/source/owner)...");
  let leadIndex = 0;
  let manualCreated = 0;
  let manualFailed = 0;
  for (const { stage, count } of STAGE_PLAN) {
    for (let i = 0; i < count; i++) {
      const lead = buildLead(leadIndex, 9810000000);
      const source = pick(MANUAL_SOURCES, leadIndex);
      const owner = leadIndex % 2 === 0 ? ownerId : salesUserId;
      try {
        await api("POST", `/api/forms/${internalForm.id}/submit`, {
          values: {
            ...lead,
            source,
            ownerId: owner,
            pipelineStage: stage,
            notes: STAGE_NOTES[stage],
          },
        });
        manualCreated++;
      } catch (err) {
        manualFailed++;
        console.warn(`   ! Failed to create lead #${leadIndex} (stage=${stage}): ${err.message}`);
      }
      leadIndex++;
    }
  }
  console.log(`   Internal-form leads created: ${manualCreated} (failed: ${manualFailed})`);

  console.log(`\nSubmitting ${PUBLIC_FORM_LEAD_COUNT} leads through the public form (anonymous, no auth)...`);
  let publicCreated = 0;
  let publicFailed = 0;
  for (let i = 0; i < PUBLIC_FORM_LEAD_COUNT; i++) {
    const lead = buildLead(leadIndex, 9920000000);
    try {
      await publicApi("POST", `/api/public/forms/${publicKey}/submit`, { values: lead });
      publicCreated++;
    } catch (err) {
      publicFailed++;
      console.warn(`   ! Failed to submit public lead #${leadIndex}: ${err.message}`);
    }
    leadIndex++;
  }
  console.log(`   Public-form leads created: ${publicCreated} (failed: ${publicFailed})`);

  // ---- Summary --------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log("Done. Demo data created:");
  console.log(`  Company:        ${companyName}`);
  console.log(`  Branch:         ${branchName} (code ${branchCode})`);
  console.log(`  Campaign:       ${campaignName}`);
  console.log(`  Total leads:    ${manualCreated + publicCreated} (${manualCreated} internal + ${publicCreated} public-form)`);
  console.log("");
  console.log("Login credentials (save these — shown only once):");
  console.log(`  Owner login:    ${ownerEmail} / ${ownerPassword}`);
  console.log(`  Sales login:    ${salesEmail} / ${salesUserRes.temporaryPassword}  (must change password on first login)`);
  console.log("");
  console.log(`  App:            ${BASE_URL}/login.html`);
  console.log("=".repeat(72));
  console.log("\nNo Meta Lead Ads data was touched — no webhook config, no meta_lead_ads leads.");
}

main().catch((err) => {
  console.error("\nSeed script failed:", err.message);
  process.exit(1);
});
