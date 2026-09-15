# Creating a Meta App for RUTA — Full Setup Guide

RUTA needs one Meta App that supports two things at once: **Facebook Login
for Business** (to read a tenant's own Pages, ad accounts, Instagram
account, and Lead Ads leads) and the **WhatsApp Business Platform** (to
send/receive WhatsApp messages). No single built-in "use case" in Meta's
creation flow bundles both — pick the broadest one and add the rest as
separate products, per the steps below.

(If you already have an app for UAT — App ID `1082039621446478` — this
guide is for setting up an additional app, e.g. a separate Production app.
If that's not what you meant, let me know.)

---

## 1. Create the app

1. Go to **developers.facebook.com/apps** → **Create App**.
2. **"What do you want your app to do?"** — Meta's use-case picker. None of
   the canned use cases cover Login + Lead Ads + WhatsApp together, so
   choose **"Other"** (lets you add products manually afterward) — this
   avoids the picker pre-selecting a narrower permission set than RUTA
   actually needs.
3. **App type: Business.** Facebook Login for Business specifically
   requires a Business-type app — this isn't optional for RUTA's use case.
4. **App details** — app name (e.g. "RUTA Production" or "RUTA UAT") and a
   contact email.
5. **Business Portfolio** — link an existing Meta Business Portfolio, or
   create one if you don't have one yet. Required for WhatsApp and for most
   of the advanced permissions RUTA needs (see step 6).
6. Review the **Requirements** screen, then **Create App**.

---

## 2. Add the products RUTA actually uses

From the App Dashboard's left sidebar, **Add Product**, add:

- **Facebook Login for Business** — for the OAuth "Connect Meta" flow.
- **Webhooks** — for the shared `leadgen` + `messages` callback endpoint.
- **WhatsApp** — for the Business Platform / Cloud API.

(Lead Ads itself isn't a separate product — it comes from the
`leads_retrieval` permission plus subscribing a Page to the `leadgen`
webhook field, both configured later.)

---

## 3. App Settings → Basic

- **App Icon**, **Category**, **Privacy Policy URL**, **Terms of Service
  URL**, **App Domains** — Meta requires these before App Review will even
  accept a submission later; worth filling in now.
- **App Secret** — click **Show**, copy it into your env as
  `META_APP_SECRET`. This is also what `verifySignature.ts` uses to
  validate `X-Hub-Signature-256` on every incoming webhook — nothing
  webhook-related works without it.
- Note the **App ID** at the top of this page → `META_APP_ID`.

---

## 4. Business verification

Under **Business Settings** (Meta Business Suite, not the App Dashboard),
complete **Business Verification** for the linked Business Portfolio.
Required before you can request advanced-access permissions
(`leads_retrieval`, `whatsapp_business_management`, etc.) or ever go Live —
worth starting early since it can take a few days.

---

## 5. Facebook Login for Business settings

- **Facebook Login for Business → Settings**.
- **Valid OAuth Redirect URIs**: `<PUBLIC_BASE_URL>/api/integrations/meta/callback`
  (exactly what `getRedirectUri()` in `src/application/metaOAuth.ts`
  builds — must match byte-for-byte, including trailing slash handling).
- Leave **Client OAuth Login** and **Web OAuth Login** enabled; leave
  **Enforce HTTPS** on (RUTA is Vercel-hosted, always HTTPS).

---

## 6. Webhooks settings

- **Webhooks** product → **Callback URL**:
  `<PUBLIC_BASE_URL>/api/webhooks/meta/leadgen`
- **Verify Token**: whatever `META_WEBHOOK_VERIFY_TOKEN` (or
  `UAT_META_WEBHOOK_VERIFY_TOKEN` for a UAT app) is set to in Vercel.
- **Verify and Save.**
- Once verified, subscribe fields for both products that share this one
  endpoint:
  - **Page** → `leadgen`
  - **WhatsApp Business Account** → `messages`

---

## 7. WhatsApp product setup

- **WhatsApp → API Setup** — select or add the phone number/WABA you'll
  use, note the **Phone number ID** and **WhatsApp Business account ID**.
- Create at least one approved **message template** in WhatsApp Manager
  (see the earlier `hello_world`/`en_US` fix) before testing outbound
  sends.
- Add a **payment method** to the WABA before sending anything beyond the
  free test-number allowance.

---

## 8. App Roles (so you can test before App Review)

- **App Roles → Roles** — add every Meta account that will test this app
  (yours, teammates') as **Admin**, **Developer**, or **Tester**.
- In **Development Mode**, these accounts can use every permission the app
  requests — `leads_retrieval`, `whatsapp_business_messaging`, all of it —
  with zero App Review needed. This is what makes UAT testing possible
  immediately after setup.

---

## 9. Environment variables to fill in (Vercel / `.env`)

| Variable | Where it comes from |
|---|---|
| `META_APP_ID` | App Settings → Basic |
| `META_APP_SECRET` | App Settings → Basic → Show |
| `META_WEBHOOK_VERIFY_TOKEN` (or `UAT_META_WEBHOOK_VERIFY_TOKEN`) | whatever you set as the Webhooks Verify Token |
| `PUBLIC_BASE_URL` | your deployed domain, e.g. `https://uatruta.empiryx.com` |

---

## 10. App Review — only needed before going Live

Everything above works today, in Development Mode, for accounts added in
step 8. App Review only becomes necessary when you flip this app to **Live**
so a real tenant who isn't manually added as a role can connect their own
Meta account through RUTA's OAuth flow. When that time comes, the
justification text for every permission RUTA requests is already written
in `meta-app-review-permission-justifications.md` — submit each one from
**App Review → Permissions and Features**.
