# WhatsApp UAT Testing — Meta Dashboard Settings Checklist

Everything needed in Meta's App Dashboard to test RUTA's WhatsApp integration
end-to-end on UAT, before any App Review submission is required (you're in
Development Mode — see note at the bottom).

Domain used throughout: `https://uatruta.empiryx.com` (RUTA's real UAT domain,
confirmed reachable and Deployment Protection off).

---

## 1. Confirm you're covered without App Review

Development Mode lets any Meta account added as **Admin, Developer, or
Tester** use every permission the app requests, with no App Review needed.

- Go to **App Dashboard → App Roles → Roles**.
- Confirm your own Meta account (and anyone else testing) is listed as
  Admin/Developer/Tester.
- If not, add them here first — nothing below will work for an account that
  isn't on this list.

---

## 2. WhatsApp product → API Setup

- **My Apps → your app → Connect on WhatsApp → API Setup.**
- Under **Step 1: Select phone numbers**, confirm the **From** number is the
  WABA/phone number you intend to test with. Note down:
  - **Phone number ID** (used in the Graph API send-message URL and as
    `META_WHATSAPP_PHONE_NUMBER_ID` if your code reads it from env).
  - **WhatsApp Business account ID**.
- If you saw the amber "missing a payment method" banner earlier: not
  required for the free test-number allowance, but you'll need it before
  any business-initiated message outside the free tier will send.

---

## 3. Create a message template (needed before any test send)

This is what fixed the `hello_world` / `en_US` error earlier.

- Click **create your own template** (linked in Step 2 of API Setup) →
  opens **WhatsApp Manager → Message Templates**.
- Either confirm `hello_world` exists under language **English (US)**, or
  create it (Category: Utility, Body: "Hello World") — usually
  auto-approved instantly.
- You only need one approved template to prove outbound sending works;
  RUTA's actual reply logic doesn't need a template for session-window
  replies (see note in step 8), but Meta's own "Send message" test button
  does.

---

## 4. Configure the Webhooks callback (Callback URL + Verify Token)

- Still in **API Setup**, click **Configure webhooks** (Step 3), or go to
  **App Dashboard → Webhooks**.
- **Callback URL:** `https://uatruta.empiryx.com/api/webhooks/meta/leadgen`
  (this is the one shared endpoint for both Page `leadgen` and WhatsApp
  `messages` — confirm it's not the OAuth path
  `/api/integrations/meta/callback`, a different endpoint entirely).
- **Verify Token:** whatever value `UAT_META_WEBHOOK_VERIFY_TOKEN` is set to
  in Vercel right now (the new token we set earlier, unless you've since
  rotated it again).
- **Before clicking Verify and Save**, double check in Vercel → your
  project → **Settings → Deployment Protection** that protection is off for
  this domain — if it's back on, Meta's validation call will fail with the
  same generic "callback URL or verify token couldn't be validated" error
  regardless of the token being correct, exactly like we saw earlier.
- Click **Verify and Save**.

---

## 5. Subscribe to the `messages` webhook field

The Callback URL being verified doesn't automatically mean WhatsApp events
are flowing to it — the WABA still needs to be subscribed to the `messages`
field specifically (separate from the Page's `leadgen` field subscription).

- In the **Webhooks** page, find the **WhatsApp Business Account** product
  row.
- Click **Manage**, and toggle **messages** to subscribed.
- If RUTA's own code auto-subscribes this on connect (check
  `graphClient.ts` / the OAuth completion flow) it may already show as
  subscribed — confirm the toggle is on either way before testing.

---

## 6. Add test recipient numbers (if using a Meta test number)

Only applies if you're using the built-in **Test phone number** shown in
API Setup (the `+1 555 742 2749`-style number), not a verified production
number.

- In API Setup, under the **To** field, add up to 5 real phone numbers
  (your own, teammates') to the allow-list — only these numbers can
  send/receive with the test number.
- If you're instead using your own verified business number, this step
  doesn't apply — anyone can message it.

---

## 7. RUTA-side setup (not Meta, but required before testing the Assistant)

- In RUTA's admin panel, set the **phone number** field on a user's profile
  to the exact digits WhatsApp will send as `message.from` — no `+`, no
  spaces/dashes, country code included (e.g. `919876543210`, not
  `+91 98765 43210`). This auto-provisions the `user_whatsapp_links` row
  that routes that number to the RUTA Assistant instead of Lead Capture.
- Any number NOT set this way will be treated as an inbound lead instead.

---

## 8. Run the actual test

1. **Handshake check** (optional, already proven working): browser-GET
   `https://uatruta.empiryx.com/api/webhooks/meta/leadgen?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=test123`
   — should echo back `test123`.
2. **Assistant path**: from a phone number you set in step 7, send any
   message (e.g. "how many leads today") to the WABA number. Expect a
   reply generated from that tenant's CRM data.
3. **Lead Capture path**: from a phone number NOT registered to any user,
   send any message to the same WABA number. Expect a new Lead row to
   appear in that tenant's CRM (`lead_approach: "whatsapp"`), with no reply
   sent back.
4. **Meta's own "Send message" test button** (API Setup, Step 2) only
   proves outbound sending works using a template — it's not a substitute
   for steps 2–3 above, which test RUTA's actual inbound handling.

---

## When App Review actually becomes required

None of the above needs App Review — it all works in Development Mode for
accounts added as Admin/Developer/Tester. App Review (the justifications
already drafted in `meta-app-review-permission-justifications.md`) is only
needed before flipping the app to **Live** mode, so a real tenant who isn't
manually added as a role can connect their own WhatsApp Business Account
through RUTA's own OAuth flow.
