# Meta App Review — Permission Justifications for RUTA (CRM_Empiryx)

Copy the relevant block into the "How does your app use this permission/feature" text box for each permission during App Review submission. Each is written to match exactly what RUTA's code actually does — no more, no less — since Meta reviewers cross-check these descriptions against your app's real behavior.

---

## email (Standard Access)

RUTA lets a business connect their Meta account once, through Facebook Login, to power automatic lead capture from their Facebook Page and Instagram account. After a person authorizes RUTA, we call `GET /me?fields=id,name,email` a single time to display "Meta Account: <name>" on their Integrations settings screen, so they can confirm which Meta account is connected to their CRM. The email is not used for messaging, marketing, or any purpose beyond this one-time identity confirmation, and is not shared with any third party.

---

## pages_show_list

After a business authorizes RUTA via Facebook Login, we call the Graph API to list the Facebook Pages that person manages, so they can choose exactly one Page to connect for lead capture. Without this permission, RUTA cannot show the person their own Pages to pick from, and they would have no way to tell RUTA which Page's leads to capture. This directly replaces manually typing in a Page ID — the person simply selects their Page from a list of Pages they already manage.

---

## pages_manage_metadata

Once a person selects their Page, RUTA automatically subscribes that Page to Meta's `leadgen` webhook field so that every new Lead Ads submission is delivered to RUTA in real time, with zero manual webhook configuration. `pages_manage_metadata` is what lets RUTA create and maintain this Page-level webhook subscription server-to-server (and remove it if the person disconnects their Meta account). This is the permission that eliminates the traditional, error-prone process of a person manually entering a callback URL and verify token into the Meta dashboard themselves — RUTA does it for them the moment they pick their Page.

---

## leads_retrieval

When Meta's `leadgen` webhook notifies RUTA that a new lead was submitted, the webhook payload contains only a `leadgen_id` — not the lead's actual answers. RUTA uses `leads_retrieval` to call the Graph API and fetch that lead's full field data (name, email, phone number, and any custom question answers) using the `leadgen_id`. This is the core mechanism that turns a bare notification into an actual usable CRM record — without it, RUTA would know a lead arrived but have no way to retrieve who it was or what they submitted.

---

## ads_read

Once a person selects their ad account, RUTA performs a read-only sync of their ad campaigns, ad sets, and ads, and keeps this catalog refreshed. When a lead comes in, RUTA uses this synced data to show the person exactly which campaign, ad set, and ad generated that lead. This lets a business see which of their ad spends are actually producing leads, without ever leaving RUTA to cross-reference Meta Ads Manager manually. RUTA never creates, edits, or manages ads on the person's behalf — this permission is used exclusively to read and display existing campaign performance/attribution data.

---

## business_management

RUTA is used by many independent businesses ("tenants"), each of whom connects their own Meta Business's Pages and ad accounts through Facebook Login. `business_management` lets RUTA confirm which Businesses a connecting person is associated with and enumerate the Pages/ad accounts owned at the Business level (rather than only assets tied to the individual's personal profile), so a person who manages Pages/ad accounts through a Business Portfolio can still select and connect them in RUTA. This is necessary because many businesses organize their Facebook Pages and ad accounts under a Meta Business Portfolio rather than a personal account.

---

## instagram_basic

When a person's connected Facebook Page has a linked Instagram professional account, RUTA reads that Instagram account's basic profile information (its ID and @username) so the person can see and select it during setup, and so leads originating from Instagram ads/forms can be correctly attributed to "Instagram" as their source in the CRM alongside Facebook leads. This lets a business manage Facebook and Instagram lead generation from the same, single connected account and pipeline, without connecting or configuring anything separately for Instagram.

---

### General notes for the App Review submission form

- **Platform:** Web application (Vercel-hosted).
- **Who uses these permissions:** The business (tenant) that connects their own Meta account through RUTA's "Connect Meta" flow in Settings → Integrations → Meta — never an end consumer/lead.
- **What's NOT used:** RUTA never creates, edits, or publishes ads, posts, or Page content; never sends messages on the person's behalf; never accesses data beyond the Page/ad account/Instagram account the person explicitly selects during setup.
- Consider recording your App Review screencast by walking through the exact "Connect Meta" flow end-to-end (Settings → Integrations → Meta → Connect → select Page/Instagram/ad account → see leads sync in) — this is the clearest way to demonstrate every permission above in the single, real flow a reviewer will be checking against these descriptions.
