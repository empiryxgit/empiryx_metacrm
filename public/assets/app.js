// Shared client-side helpers: an api() fetch wrapper that transparently
// refreshes the access token once on a 401 before giving up, an auth guard
// every protected page calls on load, and the application shell (top
// navigation + mobile drawer + user menu) renderer. No build step, no
// framework - plain JS, consistent with the rest of this project's
// "no unnecessary complexity" choice.

const App = (() => {
  let refreshing = null;

  async function rawFetch(path, opts = {}) {
    return fetch(path, {
      ...opts,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  /** Fetch wrapper for every /api call from a page. On a 401, tries exactly one
   * silent refresh (via /api/auth/refresh) before redirecting to /login.html -
   * so a page doesn't need to think about access-token expiry at all. */
  async function api(path, opts = {}) {
    let res = await rawFetch(path, opts);
    if (res.status === 401 && path !== "/api/auth/refresh") {
      refreshing = refreshing || rawFetch("/api/auth/refresh", { method: "POST" });
      const refreshed = await refreshing;
      refreshing = null;
      if (refreshed.ok) {
        res = await rawFetch(path, opts);
      } else {
        window.location.href = "/login.html?next=" + encodeURIComponent(window.location.pathname + window.location.search);
        return new Promise(() => {}); // never resolves - navigation is happening
      }
    }
    return res;
  }

  async function apiJson(path, opts = {}) {
    const res = await api(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Phase 11 - a fully expired trial/subscription blocks every
      // permission-gated write across the whole app (see requirePermission
      // in src/infrastructure/auth/context.ts) with this one machine-
      // readable code, on every page, so it's handled once here rather
      // than repeated at dozens of individual call sites the way the
      // narrower 402 campaign_limit_reached/client_limit_reached codes
      // are (those predate this and still redirect per-page - see
      // campaigns.html/clients.html/agency-dashboard.html).
      if (res.status === 402 && data.code === "account_locked") {
        window.location.href = "/subscription.html?locked=1";
        return new Promise(() => {}); // never resolves - navigation is happening
      }
      // fieldErrors (per-field validation messages) is carried through when
      // present - see src/domain/formValidation.ts / api/forms/handler.ts -
      // so a caller can highlight individual inputs instead of just showing
      // one generic banner message. `status` lets a caller special-case a
      // specific response (e.g. login.html showing a rate-limit message
      // instead of its usual "check your email and password" text only for
      // a 429 - see api/auth/handler.ts's checkRateLimit calls) without
      // having to string-match the error message itself.
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { fieldErrors: data.fieldErrors, status: res.status });
    }
    return data;
  }

  /** The 15-day trial / paid-base-plan banner (see src/domain/trial.ts and
   * src/application/billing.ts's getEntitlementSummary, which is what
   * /api/auth/me's `entitlement` field comes from) - called once from
   * requireAuth() below, right after `me` is fetched, so it shows up on
   * EVERY protected page without each page having to remember to call it
   * itself. Renders nothing (and removes any previous banner) once the
   * account is genuinely "subscribed" - the common case for every
   * pre-existing/grandfathered company and every converted trial. Inserted
   * right after #topnav, ahead of that page's own .wrap content - never
   * inside a page-specific #banner div (several pages already use that id
   * for their own transient success/error messages; this is a persistent,
   * page-independent notice). */
  function removeTrialBanner() {
    const existing = document.getElementById("trialBanner");
    existing?.remove();
  }

  function renderTrialBanner() {
    removeTrialBanner();
  }

  /** Called at the top of every protected page. Redirects to /login.html if not
   * authenticated, or to /onboarding.html if the company hasn't finished
   * onboarding yet (unless the page itself IS the onboarding page). */
  async function requireAuth({ allowIncompleteOnboarding = false } = {}) {
    try {
      const me = await apiJson("/api/auth/me");
      if (!allowIncompleteOnboarding && !me.company.onboardingCompleted) {
        window.location.href = "/onboarding.html";
        return null;
      }
      removeTrialBanner();
      return me;
    } catch {
      // Bug fix: this used to send just window.location.pathname, dropping
      // any query string - a page that reads its own state out of the URL
      // (e.g. meta-status.html's ?error=access_denied banner after a
      // declined Meta OAuth attempt, or ?connected=1) would land back on
      // itself with that context silently gone once the tenant logged back
      // in. Matching api()'s own already-correct "pathname + search"
      // pattern above keeps it intact across the round trip.
      window.location.href = "/login.html?next=" + encodeURIComponent(window.location.pathname + window.location.search);
      return null;
    }
  }

  function hasPermission(me, code) {
    if (!code) return true;
    return Boolean(me?.role?.permissions?.includes(code));
  }

  async function logout() {
    await rawFetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function initials(fullName) {
    const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ---------------------------------------------------------------------
  // Application shell: brand + primary nav + admin nav + notifications +
  // user menu, rendered once into <nav id="topnav">, plus a mobile drawer
  // appended to <body>. Every page calls App.renderNav(me, activeHref).
  // ---------------------------------------------------------------------

  // Status icons for .banner (16x16, stroke-based, currentColor) - same
  // visual language as NAV_ICONS below. Used by renderTrialBanner()'s
  // info/warning/error states.
  const BANNER_ICONS = {
    info: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.4"/><path d="M10 9.3v4M10 6.8h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.3 17.3 16H2.7L10 3.3Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 8.3v3.4M10 13.8h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    error: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.4"/><path d="M10 6.5v4M10 13.2h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  };

  const BRAND_MARK_SVG = `<svg class="brand-mark" width="20" height="20" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="6" cy="20" r="3" fill="currentColor" />
      <circle cx="22" cy="20" r="3" fill="currentColor" />
      <path d="M6 20 C 6 8, 22 8, 22 20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none" />
    </svg>`;

  // Small (16x16, stroke-based, currentColor) icons shown before each nav
  // label - same visual language as the notification bell / brand mark
  // above (1.4-1.6 stroke-width, round joins). Purely decorative alongside
  // the text label, so each is aria-hidden and the link's own text still
  // carries the accessible name.
  const NAV_ICONS = {
    dashboard: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="3" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="11" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="11" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.4"/></svg>`,
    campaigns: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 8.5v3a1 1 0 0 0 1 1h1.3l3.9 3.1c.6.5 1.6.1 1.6-.7V5.1c0-.8-1-1.2-1.6-.7L5.3 7.5H4a1 1 0 0 0-1 1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M14.5 7.7a3 3 0 0 1 0 4.6M17 6a5.6 5.6 0 0 1 0 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    pipeline: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 4h14l-4.8 5.6v5.1L8.8 16.6v-7L3 4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    forms: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 2.5h6l3 3V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 9h6M7 12h6M7 6h2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    submissions: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 10 6 3.5h8L16.5 10" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M3.5 10v5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5h-3.6a2.4 2.4 0 0 1-4.8 0H3.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    users: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="6.5" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    roles: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 4-2.6 6.7-6 8-3.4-1.3-6-4-6-8V5l6-2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7.8 10 9.2 11.5 12.5 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    branches: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 17.5S4.5 12.4 4.5 8.3a5.5 5.5 0 0 1 11 0c0 4.1-5.5 9.2-5.5 9.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="8.2" r="1.9" stroke="currentColor" stroke-width="1.4"/></svg>`,
    settings: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.4"/><path d="M10 3v1.6M10 15.4V17M17 10h-1.6M4.6 10H3M14.9 5.1l-1.1 1.1M6.2 13.7l-1.1 1.1M14.9 14.9l-1.1-1.1M6.2 6.2 5.1 5.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    metaIntegration: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 6.5 4.8 9.7a2.3 2.3 0 0 0 3.3 3.3L11.2 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 13.5 15.2 10.3a2.3 2.3 0 0 0-3.3-3.3L8.8 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    // "Subscription & Capacity" (public/subscription.html) - a simple card
    // glyph, distinct from "settings" (a gear) since this is specifically
    // about the plan/billing screen, not general configuration.
    billing: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="5" width="15" height="10" rx="1.4" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 8.4h15" stroke="currentColor" stroke-width="1.4"/><path d="M5 12h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    // "Agency" nav-group trigger - a small two-building skyline, distinct
    // from the location-pin "branches" icon (used for the Clients nav item)
    // so the two dropdown triggers read differently at a glance.
    agency: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="5.5" width="6.5" height="10.5" rx="0.8" stroke="currentColor" stroke-width="1.4"/><rect x="10.5" y="8.5" width="6.5" height="7.5" rx="0.8" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 8.2h1.1M5.2 10.6h1.1M5.2 13h1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    // "Invitations" - a simple envelope, used for both the agency nav item
    // and (implicitly, via the same page) the Invite Client / Generate
    // Onboarding Link actions on clients.html.
    invitations: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="1.2" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 5.8 10 11.2l6.5-5.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  // Individual (non-agency) company nav, and - doubling as - the "Current
  // Client" group's contents while an agency user is managing a client
  // (see renderNav's own clientLinks below): the client's own effective
  // company (me.company) scopes these automatically, so the exact same
  // three links work in both places unchanged. "Leads" used to be labeled
  // "Pipeline" - pipeline.html's Kanban board view is currently disabled
  // (BOARD_VIEW_ENABLED = false, see that file's own comment), so today
  // this page only ever shows the leads list - "Leads" is what it actually
  // is right now. A genuine Kanban "Pipeline" view is future work (would
  // mean re-enabling/redesigning that disabled board view), not a nav
  // change, so it's intentionally not a separate item here.
  const PRIMARY_LINKS = [
    { href: "/dashboard.html", label: "Dashboard", icon: NAV_ICONS.dashboard },
    { href: "/pipeline.html", label: "Leads", icon: NAV_ICONS.pipeline },
    { href: "/campaigns.html", label: "Campaigns", icon: NAV_ICONS.campaigns },
  ];

  // "Agency" nav group - the caller's OWN agency-level pages, always
  // available to an agency identity regardless of whether a client context
  // is currently active (see me.agency in api/auth/handler.ts's handleMe -
  // unlike me.company, this never flips to a client's record). Rendered as
  // two flat top-level links (see renderNav's agencyHtml), the same
  // navLinkHtml treatment PRIMARY_LINKS gets for individual accounts - not
  // a dropdown - now that this list is down to just two items.
  //
  // Deliberately just Dashboard + Clients now: the redesigned Agency
  // Dashboard's own charts/tables (see getAgencyDashboardSummary/
  // getAgencyEmployeePerformance in src/application/agency.ts) already
  // cover the cross-client leads/campaigns visibility the old standalone
  // "Leads"/"Campaigns" report links existed for, so those two - and
  // "Invitations" (clients.html already has "Invite Client"/"Generate
  // Onboarding Link" as first-class page actions, not nav-gated - see that
  // page's own load()) and "Users" (moved into SETTINGS_LINKS below,
  // relabeled "Employee" for this identity) - are no longer separate nav
  // entries. agency-leads-report.html/agency-campaigns-report.html
  // themselves are untouched on disk, just unlinked from the nav.
  const AGENCY_LINKS = [
    { href: "/agency-dashboard.html", label: "Dashboard", icon: NAV_ICONS.dashboard },
    { href: "/clients.html", label: "Clients", icon: NAV_ICONS.branches },
  ];

  // Flat, top-level admin nav items - kept separate from the "Settings"
  // master menu below (see SETTINGS_LINKS) to keep the top-level nav short
  // enough to never wrap/overflow the header (no horizontal scrollbar).
  const ADMIN_LINKS = [
    { href: "/forms.html", label: "Forms", perm: "forms.view", icon: NAV_ICONS.forms },
    { href: "/submissions.html", label: "Submissions", perm: "submissions.view", icon: NAV_ICONS.submissions },
  ];

  // "Settings" is a master/parent menu (dropdown), not a link itself -
  // Users, Roles, and Meta Integration live under it instead of
  // each being its own top-level nav item. "Meta Integration" points at
  // the same /settings.html page the old flat "Settings" link used to -
  // that page's content (Meta connection management) is unchanged, only
  // where it's reached from and its label have changed. For an agency's
  // OWN identity this same list is shown with its "Users" entry relabeled
  // "Employee" instead (see renderNav's settingsSource) - same page
  // (admin/users.html), same href/perm, just the word an agency owner
  // actually uses for their own team. Individual companies keep the
  // "Users" label and the full list unchanged.
  const SETTINGS_LINKS = [
    { href: "/admin/users.html", label: "Users", perm: "users.manage", icon: NAV_ICONS.users },
    { href: "/admin/roles.html", label: "Roles", perm: "roles.manage", icon: NAV_ICONS.roles },
    { href: "/settings.html", label: "Meta Integration", perm: "integrations.manage", icon: NAV_ICONS.metaIntegration },
    // Direct entry point for public/subscription.html - same "company.manage"
    // gate as the "Subscription & Capacity Plan" card on settings.html itself
    // (see that page's own load()). Without its own nav link here, this
    // page was only reachable by clicking into "Meta Integration" above and
    // noticing the card - unreachable at all for anyone who has
    // company.manage but not integrations.manage, since that's the only
    // other link in this list that lands on settings.html.
    { href: "/subscription.html", label: "Subscription & Capacity Plan", perm: "company.manage", icon: NAV_ICONS.billing },
  ];

  function navLinkHtml(link, activeHref, extraClass) {
    const active = link.href === activeHref;
    const icon = link.icon ? `<span class="nav-link-icon">${link.icon}</span>` : "";
    return `<a href="${link.href}" class="${extraClass || "nav-link"}${active ? " active" : ""}"${active ? ' aria-current="page"' : ""}>${icon}${link.label}</a>`;
  }

  /** Desktop dropdown nav group - a trigger (styled like a nav-link) plus
   * its own .dropdown panel, following the same menu-wrap/dropdown/
   * toggleMenu pattern as the notifications and user menus. Shared by the
   * "Settings", "Agency", and "Current Client" nav groups below - each
   * just a different id/label/icon/link-set over the same markup. Returns
   * "" for an empty link list, so a trigger never shows for a group with
   * nothing in it (e.g. Settings when the signed-in user holds none of its
   * sub-permissions). `id` becomes `${id}Btn`/`${id}Menu` in the DOM - see
   * closeAllMenus/wireShellInteractions, which reference those same ids. */
  function dropdownNavMenuHtml({ id, label, icon, links, activeHref }) {
    if (!links.length) return "";
    const isActive = links.some((l) => l.href === activeHref);
    const itemsHtml = links.map((l) => {
      const active = l.href === activeHref;
      return `<a href="${l.href}" class="dropdown-item${active ? " active" : ""}"${active ? ' aria-current="page"' : ""}><span class="nav-link-icon">${l.icon}</span>${l.label}</a>`;
    }).join("");
    return `
      <div class="menu-wrap">
        <button type="button" class="nav-link nav-link-btn${isActive ? " active" : ""}" id="${id}Btn" aria-haspopup="true" aria-expanded="false">
          <span class="nav-link-icon">${icon}</span>${escapeHtml(label)}
          <svg class="chev" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="dropdown nav-dropdown" id="${id}Menu" hidden>${itemsHtml}</div>
      </div>
    `;
  }

  /** "Settings" master menu - Users/Roles/Meta Integration (or a
   * permission-filtered subset). Thin wrapper over dropdownNavMenuHtml so
   * every existing call site/id ("settingsNavBtn"/"settingsNavMenu") stays
   * unchanged. */
  function settingsMenuHtml(settingsLinks, activeHref) {
    return dropdownNavMenuHtml({ id: "settingsNav", label: "Settings", icon: NAV_ICONS.settings, links: settingsLinks, activeHref });
  }

  function trialPillHtml(me) {
    const entitlement = me?.entitlement;
    if (!entitlement) return "";
    const state = entitlement.entitlement;
    if (!state || state.kind === "subscribed") return "";

    const isAgency = entitlement.accountType === "agency";
    let pillDesktop = "";
    let pillTablet = "";
    let pillMobile = "";
    let popoverTitle = isAgency ? "Agency Trial" : "Free Trial";
    let popoverSub = "";
    let ctaLabel = isAgency ? "Upgrade Agency Plan" : "Upgrade Plan";
    let pillClass = "trial-pill";

    if (state.kind === "trialing") {
      const d = state.daysRemaining;
      pillDesktop = `Trial · ${d} day${d === 1 ? "" : "s"} left`;
      pillTablet = `Trial · ${d} day${d === 1 ? "" : "s"}`;
      pillMobile = `Trial · ${d}d`;
      popoverSub = `${d} day${d === 1 ? "" : "s"} remaining`;
      if (d <= 3) pillClass += " warning";
    } else if (state.kind === "trial_expired") {
      pillDesktop = "Trial Expired";
      pillTablet = "Expired";
      pillMobile = "Expired";
      popoverTitle = isAgency ? "Agency Trial" : "Free Trial";
      popoverSub = "Trial period ended";
      ctaLabel = isAgency ? "View Agency Plans & Subscribe" : "View Plans & Subscribe";
      pillClass += " expired";
    } else if (state.kind === "subscription_expired") {
      pillDesktop = "Subscription Expired";
      pillTablet = "Expired";
      pillMobile = "Expired";
      popoverTitle = "Subscription Expired";
      popoverSub = "Renew to continue";
      ctaLabel = "Renew Plan";
      pillClass += " expired";
    } else {
      return "";
    }

    const clientStat = isAgency && entitlement.clients ? `
      <div class="trial-popover-stat">
        <span class="trial-popover-stat-label">Clients</span>
        <span class="trial-popover-stat-val">${entitlement.clients.used} of ${entitlement.clients.limit}</span>
      </div>` : "";

    const campaignStat = entitlement.campaigns ? `
      <div class="trial-popover-stat">
        <span class="trial-popover-stat-label">Campaigns</span>
        <span class="trial-popover-stat-val">${entitlement.campaigns.used} of ${entitlement.campaigns.limit}</span>
      </div>` : "";

    return `
      <div class="menu-wrap trial-menu-wrap">
        <button class="${pillClass}" id="trialPillBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="trialPopover" aria-label="${escapeHtml(pillDesktop)}">
          <span class="trial-pill-dot" aria-hidden="true"></span>
          <span class="trial-pill-text-desktop">${escapeHtml(pillDesktop)}</span>
          <span class="trial-pill-text-tablet">${escapeHtml(pillTablet)}</span>
          <span class="trial-pill-text-mobile">${escapeHtml(pillMobile)}</span>
        </button>
        <div class="dropdown trial-popover" id="trialPopover" hidden>
          <div class="trial-popover-head">
            <div class="trial-popover-title">${escapeHtml(popoverTitle)}</div>
            <div class="trial-popover-sub">${escapeHtml(popoverSub)}</div>
          </div>
          <div class="trial-popover-body">
            ${clientStat}
            ${campaignStat}
          </div>
          <div class="trial-popover-footer">
            <a href="/subscription.html" class="btn trial-popover-cta">${escapeHtml(ctaLabel)}</a>
          </div>
        </div>
      </div>
    `;
  }

  function renderNav(me, activeHref) {
    const nav = document.getElementById("topnav");
    if (!nav) return;
    nav.classList.add("topnav");

    // me.agency is the caller's OWN real agency identity - present whenever
    // they belong to an agency, regardless of whether a client context is
    // currently active (unlike me.company, which flips to the client's own
    // record while managing one - see handleMe in api/auth/handler.ts).
    // This is what lets the "Agency" group below stay visible at the same
    // time as "Current Client" - the old isAgency = me.company.accountType
    // check could only ever show one or the other.
    const isAgencyIdentity = Boolean(me?.agency);
    const inClientContext = Boolean(me?.clientContext);

    // Individual (never-agency) companies keep the original flat nav:
    // primary CRM pages + Settings. An agency identity never shows these
    // directly - its own equivalents live in the "Agency" and "Current
    // Client" groups below instead.
    const primaryLinks = isAgencyIdentity ? [] : PRIMARY_LINKS;
    // Forms/Submissions removed from the Individual user's nav entirely
    // (explicit request) - ADMIN_LINKS itself is left defined above
    // (forms.html/submissions.html are untouched on disk, just unlinked
    // from the nav, same "delist, don't delete" treatment AGENCY_LINKS'
    // own header comment already documents for its own dropped items), so
    // this is always empty now, not filtered by identity.
    const admin = [];

    // Settings (Employee/Roles/Meta Integration/Subscription & Capacity
    // Plan) is deliberately hidden entirely while an agency user is
    // "managing" a client (see src/application/agencyClientContext.ts's
    // header comment): those endpoints always act on the caller's OWN real
    // company, never the client's, regardless of any active client context
    // - showing them here would let a user believe the "Current Client"
    // group below also scopes team/role administration for that client,
    // which it never does. For an agency's own identity (not in client
    // context), the "Users" entry is relabeled "Employee" rather than
    // filtered out - it now lives ONLY here (see AGENCY_LINKS above, which
    // no longer duplicates it).
    const settingsSource = isAgencyIdentity
      ? SETTINGS_LINKS.map((l) => (l.label === "Users" ? { ...l, label: "Employee" } : l))
      : SETTINGS_LINKS;
    const settingsLinks = inClientContext ? [] : settingsSource.filter((l) => hasPermission(me, l.perm));

    // "Agency" group - the caller's own agency-level pages (just Dashboard +
    // Clients now - see AGENCY_LINKS above). Safe to gate with
    // hasPermission() here even mid client-context: me.role always reflects
    // the caller's OWN real role (handleMe derives it from the JWT's
    // auth.companyId/auth.roleId, never the client-context cookie), exactly
    // like ADMIN_LINKS above already relies on - though neither current
    // link carries a perm, so this is a no-op filter today, kept for
    // symmetry with how every other group here is built and in case a
    // future addition to AGENCY_LINKS ever needs gating.
    const agencyLinks = isAgencyIdentity ? AGENCY_LINKS.filter((l) => hasPermission(me, l.perm)) : [];

    // "Current Client" group - shown only while actually managing a client,
    // pointing at the exact same per-tenant pages the plain Individual nav
    // uses (me.company is already the client's own effective company, so
    // no separate agency-flavored pages are needed). Labeled with the
    // client's own name so it's immediately clear which client is active,
    // matching the "ABC Digital / Current Client -> ABC Realty" structure
    // this was built from.
    const clientLinks = inClientContext ? PRIMARY_LINKS : [];
    // Truncated defensively - unlike "Settings"/"Agency" (fixed, short
    // labels), a client's own company name is arbitrary length and this
    // trigger sits inline in a `white-space:nowrap` nav bar with no
    // max-width/ellipsis of its own (see .nav-link in app.css).
    const rawClientLabel = me?.clientContext?.name || "Current Client";
    const clientLabel = rawClientLabel.length > 24 ? rawClientLabel.slice(0, 23) + "…" : rawClientLabel;

    const navItems = [];
    if (primaryLinks.length) {
      navItems.push(primaryLinks.map((l) => navLinkHtml(l, activeHref)).join(""));
    }
    if (admin.length) {
      navItems.push(admin.map((l) => navLinkHtml(l, activeHref)).join(""));
    }
    if (agencyLinks.length) {
      navItems.push(agencyLinks.map((l) => navLinkHtml(l, activeHref)).join(""));
    }
    if (clientLinks.length) {
      navItems.push(dropdownNavMenuHtml({ id: "clientNav", label: clientLabel, icon: NAV_ICONS.branches, links: clientLinks, activeHref }));
    }
    if (settingsLinks.length) {
      navItems.push(settingsMenuHtml(settingsLinks, activeHref));
    }
    const sep = `<span class="nav-sep" aria-hidden="true"></span>`;
    const centerHtml = navItems.join(sep);

    const displayName = me?.user?.fullName ?? "";
    const roleName = me?.role?.name ?? "";
    const companyName = me?.company?.name ?? "RUTA";
    const avatarInitials = initials(displayName);
    // Brand/logo "home" link - an agency identity outside client context
    // has no /dashboard.html of its own (that's the per-tenant CRM view,
    // and the agency's own company never populates it), so it goes home to
    // /agency-dashboard.html instead. While managing a client, "home" is
    // that client's own dashboard, same as clientLinks above.
    const brandHref = isAgencyIdentity && !inClientContext ? "/agency-dashboard.html" : "/dashboard.html";

    nav.innerHTML = `
      <div class="shell-inner">
        <div class="shell-brand">
          <a href="${brandHref}" class="brand-link" aria-label="${escapeHtml(companyName)} home">
            ${BRAND_MARK_SVG}
            <span class="brand-word">RUTA</span>
            <span class="brand-tag">Lead Management</span>
          </a>
          <span class="brand-by">by Empiryx</span>
        </div>

        <div class="shell-center">${centerHtml}</div>

        <div class="shell-right">
          <div class="agency-context-switch" id="agencyContextSlot" style="display:none"></div>

          <div class="menu-wrap">
            <button class="icon-btn" id="notifBtn" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5c-2.5 0-4.2 1.9-4.2 4.4v2.4c0 .5-.2 1.2-.5 1.7l-.9 1.4c-.5.8 0 1.9 1 2.1 2.9.7 6.3.7 9.2 0 .9-.2 1.4-1.3.9-2.1l-.9-1.4c-.3-.5-.5-1.2-.5-1.7V7.9c0-2.5-1.8-4.4-4.1-4.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M11.6 17a1.7 1.7 0 0 1-3.2 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
            <div class="dropdown notif-dropdown" id="notifMenu" hidden>
              <div class="dropdown-title">Notifications</div>
              <div class="dropdown-empty">You're all caught up</div>
            </div>
          </div>

          ${trialPillHtml(me)}

          <div class="menu-wrap">
            <button class="user-trigger" id="userTrigger" type="button" aria-haspopup="true" aria-expanded="false">
              <span class="avatar">${escapeHtml(avatarInitials)}</span>
              <span class="user-meta">
                <span class="user-name">${escapeHtml(displayName)}</span>
                ${roleName ? `<span class="user-role">${escapeHtml(roleName)}</span>` : ""}
              </span>
              <svg class="chev" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div class="dropdown user-dropdown" id="userMenu" hidden>
              <div class="dropdown-head">
                <span class="avatar avatar-lg">${escapeHtml(avatarInitials)}</span>
                <div>
                  <div class="user-name">${escapeHtml(displayName)}</div>
                  <div class="user-role">${escapeHtml(roleName || companyName)}</div>
                </div>
              </div>
              <div class="dropdown-divider"></div>
              <a href="/change-password.html" class="dropdown-item">Account settings</a>
              <button class="dropdown-item dropdown-item-danger" id="logoutBtn" type="button">Sign out</button>
            </div>
          </div>

          <button class="nav-burger" id="navBurger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobileDrawer">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.5 5h15M2.5 10h15M2.5 15h15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    `;

    renderMobileDrawer(me, activeHref, {
      primaryLinks,
      admin,
      agencyLinks,
      clientLinks,
      clientLabel,
      settingsLinks,
    });
    wireShellInteractions();
    loadNotifications();
    loadAgencyContextSwitcher(me);
  }

  async function loadNotifications() {
    const menu = document.getElementById("notifMenu");
    const button = document.getElementById("notifBtn");
    if (!menu || !button) return;
    try {
      const result = await apiJson("/api/notifications");
      const notifications = result.notifications || [];
      const unread = notifications.filter((notification) => !notification.readAt).length;
      button.setAttribute("aria-label", unread ? `Notifications (${unread} unread)` : "Notifications");
      menu.innerHTML = `<div class="dropdown-title">Notifications${unread ? ` <span>(${unread} unread)</span>` : ""}</div>${notifications.length ? notifications.slice(0, 5).map((notification) => `<button type="button" class="dropdown-notification ${notification.readAt ? "" : "unread"}" data-notification-id="${escapeHtml(notification.id)}"><strong>${escapeHtml(notification.title)}</strong><span>${escapeHtml(notification.message)}</span>${notification.ctaLabel ? `<em>${escapeHtml(notification.ctaLabel)}</em>` : ""}</button>`).join("") : `<div class="dropdown-empty">You're all caught up</div>`}`;
      menu.querySelectorAll("[data-notification-id]").forEach((notificationButton) => notificationButton.addEventListener("click", async () => {
        const notificationId = notificationButton.dataset.notificationId;
        await apiJson(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" });
        const item = notifications.find((notification) => notification.id === notificationId);
        if (item?.ctaUrl) window.location.href = item.ctaUrl;
        else await loadNotifications();
      }));
    } catch {
      menu.innerHTML = `<div class="dropdown-title">Notifications</div><div class="dropdown-empty">Notifications unavailable</div>`;
    }
  }

  /** Mirrors the desktop nav's groups exactly (see renderNav above), just
   * rendered as labeled, stacked sections instead of a horizontal bar +
   * dropdowns - a drawer has no header-width constraint, so every group
   * (including "Current Client" and "Settings", each still a dropdown on
   * desktop) can get a plain section label instead. "Agency" is a labeled
   * section here purely for drawer-grouping consistency - on desktop it's
   * flat links, never a dropdown, per agencyHtml above. */
  function renderMobileDrawer(me, activeHref, groups) {
    const { primaryLinks, admin, agencyLinks, clientLinks, clientLabel, settingsLinks } = groups;
    let drawer = document.getElementById("mobileDrawer");
    if (!drawer) {
      drawer = document.createElement("div");
      drawer.id = "mobileDrawer";
      drawer.className = "mobile-drawer";
      drawer.hidden = true;
      document.body.appendChild(drawer);
    }
    const displayName = me?.user?.fullName ?? "";
    const roleName = me?.role?.name ?? "";
    const isAgency = me?.entitlement?.accountType === "agency";
    const state = me?.entitlement?.entitlement;

    const groupHtml = (links, groupClass) =>
      links.map((l) => navLinkHtml(l, activeHref, `mobile-nav-link${groupClass ? " " + groupClass : ""}`)).join("");
    const labeledSection = (label, links) =>
      links.length
        ? `<div class="mobile-nav-divider"></div><div class="mobile-nav-section-label">${escapeHtml(label)}</div><div class="mobile-nav-group">${groupHtml(links)}</div>`
        : "";

    drawer.innerHTML = `
      <div class="mobile-drawer-inner">
        <div class="mobile-user-row">
          <span class="avatar avatar-lg">${escapeHtml(initials(displayName))}</span>
          <div><div class="user-name">${escapeHtml(displayName)}</div>${roleName ? `<div class="user-role">${escapeHtml(roleName)}</div>` : ""}</div>
        </div>
        <div class="agency-context-switch agency-context-switch-mobile" id="agencyContextSlotMobile" style="display:none"></div>
        ${state && state.kind !== "subscribed" ? `
        <div class="mobile-drawer-trial">
          <div class="mobile-drawer-trial-top">
            <span class="trial-pill-dot"></span>
            <strong>${isAgency ? "Agency Trial" : "Free Trial"}</strong>
            <span style="color:var(--text-muted); font-size:12px">· ${state.daysRemaining ? `${state.daysRemaining}d left` : "Expired"}</span>
          </div>
          <a href="/subscription.html" class="btn sm" style="margin-top:8px; width:100%">${isAgency ? "Upgrade Agency Plan" : "Upgrade Plan"}</a>
        </div>
        <div class="mobile-nav-divider"></div>` : ""}
        ${primaryLinks.length ? `<div class="mobile-nav-group">${groupHtml(primaryLinks)}</div>` : ""}
        ${admin.length ? `<div class="mobile-nav-divider"></div><div class="mobile-nav-group">${groupHtml(admin)}</div>` : ""}
        ${labeledSection("Agency", agencyLinks)}
        ${labeledSection(clientLabel, clientLinks)}
        ${labeledSection("Settings", settingsLinks)}
        <div class="mobile-nav-divider"></div>
        <div class="mobile-nav-group">
          <a href="/change-password.html" class="mobile-nav-link">Account settings</a>
          <button class="mobile-nav-link mobile-nav-link-danger" id="mobileLogoutBtn" type="button">Sign out</button>
        </div>
      </div>
    `;
    document.getElementById("mobileLogoutBtn")?.addEventListener("click", logout);
  }

  function closeAllMenus() {
    document.getElementById("notifMenu")?.setAttribute("hidden", "");
    document.getElementById("notifBtn")?.setAttribute("aria-expanded", "false");
    document.getElementById("trialPopover")?.setAttribute("hidden", "");
    document.getElementById("trialPillBtn")?.setAttribute("aria-expanded", "false");
    document.getElementById("userMenu")?.setAttribute("hidden", "");
    document.getElementById("userTrigger")?.setAttribute("aria-expanded", "false");
    document.getElementById("settingsNavMenu")?.setAttribute("hidden", "");
    document.getElementById("settingsNavBtn")?.setAttribute("aria-expanded", "false");
    document.getElementById("clientNavMenu")?.setAttribute("hidden", "");
    document.getElementById("clientNavBtn")?.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(btnId, menuId) {
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    const willOpen = menu.hidden;
    closeAllMenus();
    if (willOpen) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
  }

  function wireShellInteractions() {
    document.getElementById("logoutBtn")?.addEventListener("click", logout);

    document.getElementById("notifBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("notifBtn", "notifMenu");
    });
    document.getElementById("trialPillBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("trialPillBtn", "trialPopover");
    });
    document.getElementById("trialPopover")?.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      e.stopPropagation();
    });
    document.getElementById("userTrigger")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("userTrigger", "userMenu");
    });
    document.getElementById("settingsNavBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("settingsNavBtn", "settingsNavMenu");
    });
    document.getElementById("clientNavBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("clientNavBtn", "clientNavMenu");
    });

    const burger = document.getElementById("navBurger");
    const drawer = document.getElementById("mobileDrawer");
    burger?.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = drawer.hidden;
      drawer.hidden = !willOpen;
      burger.setAttribute("aria-expanded", String(willOpen));
      document.body.classList.toggle("drawer-open", willOpen);
    });

    // Click outside / Escape closes any open menu or drawer.
    document.addEventListener("click", () => {
      closeAllMenus();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeAllMenus();
      if (drawer && !drawer.hidden) {
        drawer.hidden = true;
        burger?.setAttribute("aria-expanded", "false");
        document.body.classList.remove("drawer-open");
      }
    });
  }

  // ---------------------------------------------------------------------
  // Agency client switcher ("Agency Context -> Client Context -> CRM
  // Dashboard"): lets an agency user pick one of their agency's clients and,
  // for the rest of the browser session, have the app operate on THAT
  // CLIENT's data instead of the agency's own - see
  // src/application/agencyClientContext.ts for the full server-side design
  // this mirrors (that file's header comment explains exactly which pages
  // honor this and which never do). Switching here is a FULL-PAGE
  // NAVIGATION, not a live re-filter -
  // GET /api/auth/me's `company` field itself changes (to the client's own
  // record) once the switch takes effect, and `clientContext` becomes
  // present - which is what makes the "Current Client" nav group appear
  // (alongside "Agency", not instead of it) for free - see renderNav's own
  // isAgencyIdentity/inClientContext.
  //
  // Populated from GET /api/agency/dashboard's `clients` array - already
  // scoped to exactly the clients this user is allowed to manage (see
  // resolveAgencyClientAccess/canAccessClient) - so this control can only
  // ever offer a switch the backend would actually accept.
  // ---------------------------------------------------------------------

  // null until GET /api/auth/me + GET /api/agency/dashboard have both
  // resolved; { agencyName, clientContextId, clientContextName, clients }
  // once known. Left null (not even an empty-clients shape) for a
  // non-agency user so renderAgencyContextSwitcher's very first check hides
  // both slots without needing to special-case "not an agency user" at
  // every call site.
  let agencyContextInfo = null;

  /** THE one place that actually calls POST /api/agency/context/enter -
   * used by the nav switcher below, and exposed on the public API (see the
   * return statement at the bottom of this file) so any page that offers
   * its own "open this client's CRM" action (clients.html,
   * client-detail.html - see the client-detail.html-driven "when an agency
   * opens a client, they should see the client's normal CRM interface"
   * requirement this was built for) can reuse the exact same call rather
   * than re-implementing it. Navigates to /dashboard.html on success -
   * from that point on it IS the client's own, completely unchanged
   * dashboard.html/pipeline.html/etc., not a separate agency-side view of
   * their data. Rethrows on failure so each caller can show its own error
   * UI instead of this function always alert()-ing. */
  async function enterClient(clientCompanyId) {
    await apiJson("/api/agency/context/enter", { method: "POST", body: { clientCompanyId } });
    window.location.href = "/dashboard.html";
  }

  async function enterClientContext(clientCompanyId) {
    try {
      await enterClient(clientCompanyId);
    } catch (err) {
      alert(err.message || "Could not switch to that client. It may no longer be assigned to you.");
      renderAgencyContextSwitcher(); // reset the select back to the last-known-good state
    }
  }

  /** Ends the active client context and returns to the Clients page - the
   * header's "Back" button while an agency user is managing a client (see
   * renderAgencyContextSwitcher below). Used to land on /agency-dashboard.html
   * under the old "Exit to Agency" label/badge; now goes straight back to
   * /clients.html instead, since that's the page a "Back" action from a
   * client's workspace is actually expected to return to (the Clients page
   * is where a client gets picked to work on in the first place - see
   * clients.html's own "Start Work" action). */
  async function exitClientContext() {
    try {
      await apiJson("/api/agency/context/exit", { method: "POST" });
    } catch {
      // Best-effort - even if this particular request fails, navigating to
      // clients.html is harmless: that page's own auth guard talks to the
      // agency's own real company either way (never swapped by client
      // context - see api/admin/users/handler.ts's handleAgencyResource),
      // and the next protected page's own live re-validation
      // (resolveActiveClientContext) is what actually decides whether any
      // lingering cookie still counts, not this client-side call succeeding.
    }
    window.location.href = "/clients.html";
  }

  // Left-arrow "Back" icon - same 16x16 stroke-based visual language as
  // NAV_ICONS, used only here so it doesn't need a place in that shared map.
  const BACK_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12.5 4.5 6 10l6.5 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function renderAgencyContextSwitcher() {
    const info = agencyContextInfo;
    const desktopSlot = document.getElementById("agencyContextSlot");
    const mobileSlot = document.getElementById("agencyContextSlotMobile");

    if (!info) {
      if (desktopSlot) desktopSlot.style.display = "none";
      if (mobileSlot) mobileSlot.style.display = "none";
      return;
    }

    const inContext = Boolean(info.clientContextId);

    // Desktop: no "Managing: <client name>" badge any more - the client's
    // own name is already shown by the "Current Client" nav dropdown right
    // next to this slot (see renderNav's clientLinks/clientLabel), so the
    // badge was pure duplication. A single compact icon button ("Back",
    // same footprint as the bell/notifications icon-btn) is what's left,
    // which is what actually fixes the header overflowing into horizontal
    // scroll at normal widths.
    if (desktopSlot) {
      if (!inContext) {
        desktopSlot.style.display = "none";
        desktopSlot.innerHTML = "";
      } else {
        desktopSlot.style.display = "";
        desktopSlot.classList.add("in-context");
        desktopSlot.innerHTML = `
          <button type="button" class="icon-btn agency-context-back" id="agencyContextExitBtn" title="Back to Clients" aria-label="Back to Clients">
            ${BACK_ICON_SVG}
          </button>
        `;
        desktopSlot.querySelector("#agencyContextExitBtn")?.addEventListener("click", exitClientContext);
      }
    }

    // Mobile drawer has no width constraint, so it keeps the descriptive
    // "Managing: <client>" status line - only the action button's label/
    // destination changes, matching the desktop button above.
    if (mobileSlot) {
      if (!inContext) {
        mobileSlot.style.display = "none";
        mobileSlot.innerHTML = "";
      } else {
        mobileSlot.style.display = "";
        mobileSlot.classList.add("in-context");
        mobileSlot.innerHTML = `
          <div class="agency-context-mobile-agency">${escapeHtml(info.agencyName)}</div>
          <div class="agency-context-mobile-status">Managing: <strong>${escapeHtml(info.clientContextName || "")}</strong></div>
          <button type="button" class="agency-context-exit" id="agencyContextExitBtnMobile">← Back to Clients</button>
        `;
        mobileSlot.querySelector("#agencyContextExitBtnMobile")?.addEventListener("click", exitClientContext);
      }
    }
  }

  function loadAgencyContextSwitcher(me) {
    if (!me?.agency) {
      agencyContextInfo = null;
      renderAgencyContextSwitcher();
      return;
    }
    agencyContextInfo = {
      agencyName: me.agency.name,
      clientContextId: me.clientContext?.id || null,
      clientContextName: me.clientContext?.name || null,
      clients: [],
    };
    renderAgencyContextSwitcher();
  }

  // =========================================================================
  // Shared numbered-pagination control - generalized from the PAGE_SIZE /
  // updatePaginationBar pattern originally hand-rolled in campaigns.html.
  // One implementation for every server-paginated list page: a count line,
  // Prev/Next, and a 25/50/100 rows-per-page picker. This function holds no
  // state of its own - it just renders `state` (the `pagination` object
  // every paginated endpoint now returns: { page, pageSize, total,
  // totalPages }) into `containerEl` and wires the controls to `handlers`.
  // The caller owns re-fetching: onPageChange/onPageSizeChange are called
  // with the new value, the caller re-fetches from the server, then calls
  // renderPagination again with the fresh response. Hides itself (rather
  // than just disabling controls) when there's nothing to page through -
  // same UX rule the original campaigns.html bar used.
  // =========================================================================
  const PAGE_SIZE_OPTIONS = [25, 50, 100];

  function renderPagination(containerEl, state, handlers) {
    if (!containerEl) return;
    const { page, pageSize, total, totalPages } = state || {};
    if (!total || totalPages <= 1) {
      containerEl.style.display = "none";
      containerEl.innerHTML = "";
      return;
    }
    containerEl.style.display = "flex";
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    containerEl.innerHTML = `
      <span class="pagination-info">${start}–${end} of ${total}</span>
      <span class="pagination-controls">
        <label class="pagination-size">Rows:
          <select class="pagination-size-select" aria-label="Rows per page">
            ${PAGE_SIZE_OPTIONS.map((s) => `<option value="${s}" ${s === pageSize ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="btn secondary pagination-prev" ${page <= 1 ? "disabled" : ""}>Prev</button>
        <span class="page-indicator">Page ${page} of ${totalPages}</span>
        <button type="button" class="btn secondary pagination-next" ${page >= totalPages ? "disabled" : ""}>Next</button>
      </span>
    `;
    containerEl.querySelector(".pagination-prev")?.addEventListener("click", () => {
      if (page > 1 && handlers?.onPageChange) handlers.onPageChange(page - 1);
    });
    containerEl.querySelector(".pagination-next")?.addEventListener("click", () => {
      if (page < totalPages && handlers?.onPageChange) handlers.onPageChange(page + 1);
    });
    containerEl.querySelector(".pagination-size-select")?.addEventListener("change", (e) => {
      handlers?.onPageSizeChange?.(Number(e.target.value));
    });
  }

  /** Clamps an untrusted/parsed page-size value (e.g. from a query string
   * or a stale localStorage value) into the one allowed set, same as every
   * paginated backend endpoint does server-side - keeps the frontend
   * default in sync with what the server will actually clamp to. */
  function clampPageSize(value) {
    const n = Number(value);
    return PAGE_SIZE_OPTIONS.includes(n) ? n : PAGE_SIZE_OPTIONS[0];
  }

  return {
    api,
    apiJson,
    requireAuth,
    hasPermission,
    logout,
    renderNav,
    renderTrialBanner,
    escapeHtml,
    initials,
    enterClient,
    renderPagination,
    clampPageSize,
  };
})();
