# Security & session test cases

> Scope: a full security review of the auth/session stack and of every
> feature added since the last such review (Smart follow-up v1, the Twilio
> WhatsApp/SMS notification adapters, and the Dashboard date-range/Lead List
> change), triggered by the request "write down the test cases, check for
> vulnerabilities and security hardening, resolve them, make sure no session
> or cookie can be tampered with, resolve any security breaches." Findings
> and the fixes applied for each are in the README's "Security hardening"
> section; this document is the test-case checklist that review was run
> against, kept here so the same checklist can be re-run after any future
> change to auth, sessions, or a permission-gated endpoint.
>
> Cases marked **(automated)** have a corresponding Vitest test
> (`src/security/*.test.ts`, `src/domain/phoneNumber.test.ts`) that runs in
> CI. Cases marked **(manual)** need a real browser/deployed environment (or
> `curl`/Postman against a running `vercel dev`) and are not currently
> automated — do them by hand after any change to the areas above, and
> before any production deploy that touches auth.

## 1. Login & session establishment

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 1.1 | Valid login issues both cookies | POST `/api/auth/login` with correct email/password | 200; `Set-Cookie` includes `mla_access` and `mla_refresh`, both `HttpOnly`; response body never includes either token |
| 1.2 | Wrong password | POST with correct email, wrong password | 401, generic "Invalid email or password." — never "wrong password" specifically |
| 1.3 | Nonexistent email | POST with an email no account uses | 401, the exact same generic message as 1.2 |
| 1.4 | **(automated - manual timing check)** No email-enumeration via timing | Time 1.2 vs. 1.3 over ~20 requests each | Response times overlap - no statistically distinguishable gap. (`login()` in `src/application/auth.ts` now always runs a bcrypt comparison, against a fixed dummy hash for a nonexistent email, specifically to close this - see README.) |
| 1.5 | Disabled/non-active account | Log in as a user with `status != "active"` | 401, same generic message - never reveals the account exists but is disabled |
| 1.6 | `rememberMe: true` sets a persistent cookie | Log in with `rememberMe: true` | `mla_access`/`mla_refresh` cookies both carry `Max-Age`; refresh token's server-side `expiresAt` is ~30 days out |
| 1.7 | `rememberMe` omitted/false sets a session cookie | Log in with `rememberMe` omitted | Cookies carry **no** `Max-Age`/`Expires` (browser session cookie); server-side `expiresAt` is ~24 hours out |
| 1.8 | `rememberMe` can't be forged to extend a session | Log in with `rememberMe: "true"` (string, not boolean), `1`, or omitted-but-truthy-looking values | Treated as `false` (strict `=== true` check) - short-lived session issued regardless of what the client sends |

## 2. Cookie & JWT tampering

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 2.1 | Tampered JWT payload | Decode `mla_access`, flip one character in the payload segment, re-encode, replay | Any protected endpoint returns 401 (`jwtVerify` signature check fails) |
| 2.2 | Tampered JWT signature | Flip one character in the signature segment only | 401 |
| 2.3 | **(automated)** Algorithm confusion | Craft a token with `alg: "none"` or a different symmetric alg, signed (or unsigned) some other way | Rejected - `verifyAccessToken` now pins `algorithms: ["HS256"]` explicitly |
| 2.4 | Expired access token, valid refresh cookie present | Wait out the access token's 60-minute expiry (or forge one with `exp` in the past, signed with a known-bad approach) without a valid signature | 401 from any protected endpoint; the SPA's silent-refresh-on-401 logic (`app.js`) should transparently call `/api/auth/refresh` and retry |
| 2.5 | Refresh cookie missing entirely | Delete `mla_refresh`, call `POST /api/auth/refresh` | 401 "No refresh token." - never a crash or a session issued from nothing |
| 2.6 | Refresh token value guessed/forged | Present a syntactically-plausible but never-issued refresh token | 401 "Session expired or revoked." No session is revoked as a side effect (nothing to revoke - see 3.4) |
| 2.7 | Cross-site cookie replay (CSRF) | From a different origin, submit a form/fetch POST to a state-changing endpoint (e.g. `pipeline` stage update) relying on the browser to attach cookies | Cookie is `SameSite=Lax`, so it is **not** attached to a cross-site POST/PATCH - request arrives unauthenticated and is rejected with 401 |
| 2.8 | Cookie sent over plain HTTP in production | Inspect `Set-Cookie` on a production (`NODE_ENV != development`) response | `Secure` flag present - browser refuses to send it over HTTP |
| 2.9 | `document.cookie` access from JS | In the browser console on any authenticated page, run `document.cookie` | Neither `mla_access` nor `mla_refresh` appears - both are `HttpOnly` |

## 3. Session lifecycle & refresh-token rotation

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 3.1 | **(automated)** Refresh rotates the token | Log in, call `/api/auth/refresh` | New `mla_refresh` value differs from the original; old refresh token's session row is `revokedAt`-stamped |
| 3.2 | **(automated)** Retired refresh token is rejected once rotated | Call `/api/auth/refresh` twice with the SAME (pre-rotation) refresh token | First call succeeds; second call with the same original token 401s |
| 3.3 | **(automated)** Refresh-token reuse revokes the whole session family | Log in, refresh once (token A → token B), then replay token A again | The replay 401s AND token B (the legitimately-rotated one) is also revoked - a subsequent refresh with token B also fails. This is the deliberate "treat reuse as compromise" hardening in `refresh()` - see `src/security/refreshTokenReuse.test.ts` |
| 3.4 | **(automated)** An unrelated/never-issued token doesn't affect real sessions | Log in (session A active), then call `/api/auth/refresh` with a random, never-issued refresh token | 401; session A remains fully active and un-revoked afterward |
| 3.5 | `rememberMe` survives every rotation | Log in with `rememberMe: true`, refresh several times | Every rotation's new session row still has `rememberMe: true` and the ~30-day TTL - never silently downgrades to the short TTL |
| 3.6 | `rememberMe: false` never upgrades itself | Log in with `rememberMe` unset (short session), refresh once via the SPA's silent-refresh-on-401 | New session row still has `rememberMe: false` and the ~24h TTL |
| 3.7 | Logout revokes the session | Log in, call `POST /api/auth/logout`, then try the OLD refresh token | Cookies cleared in the response; the old refresh token now 401s on `/api/auth/refresh` |
| 3.8 | Change-password revokes every other session | Log in on two different browsers/sessions as the same user, change the password from session 1 | Session 1 continues to work for the current request but `revokeAllSessionsForUser` fires - both sessions' refresh tokens now fail on their next `/api/auth/refresh` |
| 3.9 | Expired session row is rejected even with a technically-well-formed cookie | Manually set a session's `expiresAt` in the past (or wait it out), then present its refresh token | 401 - `getActiveSessionByHash` excludes `expiresAt < now()` |
| 3.10 | "Access LMS" re-entry after closing the browser (remembered) | Log in with "remember me" checked, fully close the browser, reopen and navigate to the app | Silently redirected straight to the dashboard - no login form flash (see `login.html`'s `checkExistingSession()`) |
| 3.11 | "Access LMS" re-entry after closing the browser (not remembered) | Log in with "remember me" UNchecked, fully close the browser, reopen | Lands on the login form - the session cookie did not survive the browser restart |

## 4. Rate limiting / brute-force protection

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 4.1 | **(manual)** Login brute-force on one account | From one IP, POST `/api/auth/login` with the wrong password for the same email 9+ times within 15 minutes | The 9th (over the limit of 8) request returns `429 {"error": "Too many attempts..."}` instead of a 5th/6th/… 401 |
| 4.2 | **(manual)** Login credential-spraying across accounts | From one IP, POST `/api/auth/login` with 31+ different emails within 15 minutes | The request that crosses 30 total attempts from that IP returns 429, even though no single email was hit more than a couple of times |
| 4.3 | **(manual)** Rate limit doesn't leak account existence | Compare the 429 response body/timing for a rate-limited real account vs. a rate-limited nonexistent account | Identical - the rate limiter trips on `(ip, email)`/`ip` alone, before `login()` ever runs |
| 4.4 | **(manual)** Registration spam | POST `/api/auth/register` 9+ times from one IP within an hour | 429 past the 8th |
| 4.5 | **(manual)** Change-password brute-force on `currentPassword` | While authenticated, POST `/api/auth/change-password` with a wrong `currentPassword` 9+ times within 15 minutes | 429 past the 8th, keyed to the authenticated user id (not IP) |
| 4.6 | **(manual)** Rate limiter fails open, not closed, on a Redis outage | Point `UPSTASH_REDIS_REST_URL`/`TOKEN` at an unreachable host, then log in normally | Login still succeeds (a warning is logged) - a Redis outage degrades to "no rate limiting," never "nobody can log in" |
| 4.7 | **(manual)** Legitimate silent-refresh traffic isn't rate-limited into a broken session | Stay logged in and active for several hours (many silent refreshes via the 60-minute access-token expiry) | No 429s under normal single-user usage - the refresh limit (30/15min/IP) comfortably covers real traffic, including several users behind one shared/NAT IP |

## 5. Authorization, tenant isolation & IDOR

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 5.1 | **(automated)** Cross-tenant lead read/write | See `src/security/tenantIsolation.test.ts` - Tenant B attempts to read/update Tenant A's lead, form, campaign, Meta connection, page, ad account, Instagram account, lead event, and legacy webhook config by id | Every case returns null/404/zero-rows-affected for Tenant B; Tenant A's own access to the same record still works |
| 5.2 | **(manual)** Cross-tenant admin user PATCH | As an admin of Company A (with a valid `USERS_MANAGE` session), `PATCH /api/admin/users/{a User B's userId}` | 404 "User not found." (hardened - previously returned a misleading `200 {"updated": true}` while writing nothing; see README) |
| 5.3 | **(manual)** Cross-tenant admin user VIEW | As an admin of Company A, `GET /api/admin/users/{a User B's userId}` | 404 |
| 5.4 | **(manual)** Branch-restricted user can't touch a lead outside their branch | Log in as a user restricted to Branch X, attempt to PATCH the pipeline stage of a lead assigned to Branch Y in the same company | 404 - branch access is enforced in the same `WHERE` clause as the update, not checked-then-trusted separately |
| 5.5 | **(manual)** Missing permission | Call any `requirePermission`-gated endpoint (e.g. `/api/admin/users`) as a user whose role lacks that permission | 403 `{"error": "Missing permission: ..."}` |
| 5.6 | **(manual)** No session at all | Call any protected endpoint with no cookies | 401 `{"error": "Not authenticated"}` |
| 5.7 | **(manual)** "Last admin" guard rail | As the only user with a `USERS_MANAGE`-capable role in a company, try to disable your own account or re-role yourself to a non-admin role | 409 "Cannot disable or re-role the last admin who can manage users." |
| 5.8 | **(manual)** Phone number format validation | `PATCH /api/admin/users/{userId}` with `phoneNumber: "not-a-number"` | 400 "phoneNumber must be in E.164 format..." - nothing is written |
| 5.9 | **(manual)** Phone number clearing still works | `PATCH .../{userId}` with `phoneNumber: null` | 200, phone number cleared - `null` is intentionally exempt from the format check |

## 6. Internal/cron endpoint authorization

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 6.1 | **(manual)** Cron endpoint without the secret | `GET /api/internal/followup-nudges` (or `/reconciliation`) with no `Authorization` header | 401 |
| 6.2 | **(manual)** Cron endpoint with the wrong secret | Same, with `Authorization: Bearer wrong-value` | 401 |
| 6.3 | **(manual)** Cron endpoint with the correct secret | Same, with the real `CRON_SECRET` | 200, sweep runs |
| 6.4 | **(automated - by inspection)** Constant-time comparison | Code review of `isAuthorizedVercelCron` | Uses `crypto.timingSafeEqual` on a length-checked buffer pair, not `===` |
| 6.5 | **(manual)** QStash-signed reconciliation POST without a valid signature | `POST /api/internal/reconciliation` with a garbage `Upstash-Signature` header | 401 "Invalid QStash signature" |

## 7. Notification adapters & secrets hygiene

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 7.1 | **(manual)** No secrets in logs | Trigger a Twilio send failure (e.g. an invalid `To` number) in the follow-up nudge cron, inspect server logs | The logged error includes the Twilio HTTP status and truncated response body, never `TWILIO_AUTH_TOKEN`/`WHATSAPP_ACCESS_TOKEN` |
| 7.2 | **(manual)** No secrets in API responses | Call `GET /api/internal/followup-nudges` with a valid `CRON_SECRET`, inspect the JSON body | `summary.errors` contains only owner names/ids and Twilio's own error text - no credentials |
| 7.3 | **(manual)** `.env`/`.env.local` never reach git | `git status` / `git check-ignore -v .env` in a real clone of this project | `.env`, `.env.local`, and every `.env.*.local` variant are ignored (see the new `.gitignore`) |
| 7.4 | **(manual)** No notification provider configured | Unset all Twilio/WhatsApp env vars, run the follow-up nudge cron | Runs to completion, `provider: null` in the summary, no leads/owners are silently dropped - just nothing is sent |

## 8. Password handling

| # | Test case | Steps | Expected result |
|---|---|---|---|
| 8.1 | **(manual)** Password too short on registration | Register with a 9-character password | 400 "Password must be at least 10 characters." |
| 8.2 | **(manual)** Password too short on change-password | `POST /api/auth/change-password` with a 9-character `newPassword` | 400, no change made |
| 8.3 | **(manual)** Wrong current password | `POST /api/auth/change-password` with an incorrect `currentPassword` | 401 "Current password is incorrect.", `newPassword` never applied |
| 8.4 | **(manual)** Password never stored/returned in plaintext | Inspect the `users` table and every API response after registration/password-change/admin-create-user | Only `passwordHash` (bcrypt) is ever persisted; the admin "create user" temp password is returned exactly once in that one response and never stored in plaintext anywhere |

---

## How to run the automated subset

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run - src/security/*.test.ts need DATABASE_URL, skip cleanly without it
```

Against a local Postgres (see `docs/TESTING.md` for setup), the full automated suite includes `src/security/tenantIsolation.test.ts` (§5.1) and `src/security/refreshTokenReuse.test.ts` (§3.1–3.4). Everything else in this document is currently manual - a good next step, if this checklist is going to be re-run often, is wiring up a lightweight HTTP-level test harness (e.g. calling the Vercel handlers directly with mocked `req`/`res` objects) so §1, §2.3–2.9, §4, §5.2–5.9 and §6 can be automated too; none of it is automated today because this codebase's existing test suite only exercises application/repository functions directly, never the Vercel handler layer.
