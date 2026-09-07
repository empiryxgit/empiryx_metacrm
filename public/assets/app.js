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
    return me?.role?.permissions?.includes(code);
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
    // from "branches" (a single location pin, used for one specific
    // client/branch) so the two dropdown triggers read differently at a
    // glance.
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
  // a dropdown (see dropdownNavMenuHtml below), not flat top-level links -
  // with the "Current Client" group potentially showing at the same time
  // (see renderNav), a flat list here would crowd/wrap the header.
  //
  // "Leads"/"Campaigns" here are the aggregate cross-client reports (see
  // getAgencyLeadsReport/getAgencyCampaignsReport in src/application/
  // agency.ts), NOT a single client's own leads/campaigns - deliberately
  // named the same as the Individual/"Current Client" nav items they sit
  // alongside, since from an agency owner's perspective both answer "show
  // me leads/campaigns," just at a different scope.
  //
  // "Invitations" reuses clients.html - see that page's own load(): a
  // `?tab=invitations` query param auto-opens the existing "Generate
  // Onboarding Link" modal, so this is a real, distinct landing action, not
  // just a second link to an identical screen. "Users" is gated the same
  // "users.manage" permission SETTINGS_LINKS used to gate it under -
  // relocated here, not duplicated (see renderNav's settingsSource).
  const AGENCY_LINKS = [
    { href: "/agency-dashboard.html", label: "Agency Dashboard", icon: NAV_ICONS.dashboard },
    { href: "/clients.html", label: "Clients", icon: NAV_ICONS.branches },
    { href: "/agency-leads-report.html", label: "Leads", icon: NAV_ICONS.pipeline },
    { href: "/agency-campaigns-report.html", label: "Campaigns", icon: NAV_ICONS.campaigns },
    { href: "/admin/users.html", label: "Users", perm: "users.manage", icon: NAV_ICONS.users },
    { href: "/clients.html?tab=invitations", label: "Invitations", icon: NAV_ICONS.invitations },
  ];

  // Flat, top-level admin nav items - kept separate from the "Settings"
  // master menu below (see SETTINGS_LINKS) to keep the top-level nav short
  // enough to never wrap/overflow the header (no horizontal scrollbar).
  const ADMIN_LINKS = [
    { href: "/forms.html", label: "Forms", perm: "forms.view", icon: NAV_ICONS.forms },
    { href: "/submissions.html", label: "Submissions", perm: "submissions.view", icon: NAV_ICONS.submissions },
  ];

  // "Settings" is a master/parent menu (dropdown), not a link itself -
  // Users, Roles, Branches and Meta Integration live under it instead of
  // each being its own top-level nav item. "Meta Integration" points at
  // the same /settings.html page the old flat "Settings" link used to -
  // that page's content (Meta connection management) is unchanged, only
  // where it's reached from and its label have changed. For an agency's
  // OWN identity this list is shown with "Users" filtered out (see
  // renderNav's settingsSource) since Users already lives in AGENCY_LINKS
  // above - Individual companies keep the full list unchanged.
  const SETTINGS_LINKS = [
    { href: "/admin/users.html", label: "Users", perm: "users.manage", icon: NAV_ICONS.users },
    { href: "/admin/roles.html", label: "Roles", perm: "roles.manage", icon: NAV_ICONS.roles },
    { href: "/admin/branches.html", label: "Branches", perm: "branches.manage", icon: NAV_ICONS.branches },
    { href: "/settings.html", label: "Meta Integration", perm: "integrations.manage", icon: NAV_ICONS.metaIntegration },
    // Direct entry point for public/subscription.html - same "company.manage"
    // gate as the "Subscription & Capacity" card on settings.html itself
    // (see that page's own load()). Without its own nav link here, this
    // page was only reachable by clicking into "Meta Integration" above and
    // noticing the card - unreachable at all for anyone who has
    // company.manage but not integrations.manage, since that's the only
    // other link in this list that lands on settings.html.
    { href: "/subscription.html", label: "Subscription & Capacity", perm: "company.manage", icon: NAV_ICONS.billing },
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

  /** "Settings" master menu - Users/Roles/Branches/Meta Integration (or a
   * permission-filtered subset). Thin wrapper over dropdownNavMenuHtml so
   * every existing call site/id ("settingsNavBtn"/"settingsNavMenu") stays
   * unchanged. */
  function settingsMenuHtml(settingsLinks, activeHref) {
    return dropdownNavMenuHtml({ id: "settingsNav", label: "Settings", icon: NAV_ICONS.settings, links: settingsLinks, activeHref });
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

    // Individual (never-agency) companies keep the original flat nav
    // unchanged: primary CRM pages + Forms/Submissions + Settings. An
    // agency identity never shows these directly - its own equivalents
    // live in the "Agency" and "Current Client" groups below instead.
    const primaryLinks = isAgencyIdentity ? [] : PRIMARY_LINKS;
    const admin = isAgencyIdentity ? [] : ADMIN_LINKS.filter((l) => hasPermission(me, l.perm));

    // Settings (Users/Roles/Branches/Meta Integration) is deliberately
    // hidden entirely while an agency user is "managing" a client (see
    // src/application/agencyClientContext.ts's header comment): those
    // endpoints always act on the caller's OWN real company, never the
    // client's, regardless of any active client context - showing them here
    // would let a user believe the "Current Client" group below also scopes
    // team/role administration for that client, which it never does. For an
    // agency's own identity (not in client context), "Users" is additionally
    // filtered out of this list since it already lives in the "Agency"
    // group - showing it in both places would be redundant.
    const settingsSource = isAgencyIdentity ? SETTINGS_LINKS.filter((l) => l.label !== "Users") : SETTINGS_LINKS;
    const settingsLinks = inClientContext ? [] : settingsSource.filter((l) => hasPermission(me, l.perm));

    // "Agency" group - the caller's own agency-level pages. Safe to gate
    // with hasPermission() here even mid client-context: me.role always
    // reflects the caller's OWN real role (handleMe derives it from the
    // JWT's auth.companyId/auth.roleId, never the client-context cookie),
    // exactly like ADMIN_LINKS above already relies on.
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

    const primaryHtml = primaryLinks.map((l) => navLinkHtml(l, activeHref)).join("");
    const sep = `<span class="nav-sep" aria-hidden="true"></span>`;
    const adminHtml = admin.length ? sep + admin.map((l) => navLinkHtml(l, activeHref)).join("") : "";
    const agencyHtml = agencyLinks.length
      ? sep + dropdownNavMenuHtml({ id: "agencyNav", label: "Agency", icon: NAV_ICONS.agency, links: agencyLinks, activeHref })
      : "";
    const clientHtml = clientLinks.length
      ? sep + dropdownNavMenuHtml({ id: "clientNav", label: clientLabel, icon: NAV_ICONS.branches, links: clientLinks, activeHref })
      : "";
    const settingsHtml = settingsLinks.length
      ? `${admin.length || agencyHtml || clientHtml ? "" : sep}` + settingsMenuHtml(settingsLinks, activeHref)
      : "";

    const displayName = me?.user?.fullName ?? "";
    const roleName = me?.role?.name ?? "";
    const companyName = me?.company?.name ?? "RUTA";
    const avatarInitials = initials(displayName);

    nav.innerHTML = `
      <div class="shell-inner">
        <div class="shell-brand">
          <a href="/dashboard.html" class="brand-link" aria-label="${escapeHtml(companyName)} home">
            ${BRAND_MARK_SVG}
            <span class="brand-word">RUTA</span>
            <span class="brand-tag">Lead Management</span>
          </a>
          <span class="brand-by">by Empiryx</span>
        </div>

        <button class="nav-burger" id="navBurger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobileDrawer">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.5 5h15M2.5 10h15M2.5 15h15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>

        <div class="shell-center">${primaryHtml}${adminHtml}${agencyHtml}${clientHtml}${settingsHtml}</div>

        <div class="shell-right">
          <div class="agency-context-switch" id="agencyContextSlot" style="display:none"></div>
          <div class="branch-switch" id="branchSwitchSlot" style="display:none"></div>

          <div class="menu-wrap">
            <button class="icon-btn" id="notifBtn" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5c-2.5 0-4.2 1.9-4.2 4.4v2.4c0 .5-.2 1.2-.5 1.7l-.9 1.4c-.5.8 0 1.9 1 2.1 2.9.7 6.3.7 9.2 0 .9-.2 1.4-1.3.9-2.1l-.9-1.4c-.3-.5-.5-1.2-.5-1.7V7.9c0-2.5-1.8-4.4-4.1-4.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M11.6 17a1.7 1.7 0 0 1-3.2 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
            <div class="dropdown notif-dropdown" id="notifMenu" hidden>
              <div class="dropdown-title">Notifications</div>
              <div class="dropdown-empty">You're all caught up</div>
            </div>
          </div>

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
    loadBranchSwitcher(me);
    loadAgencyContextSwitcher(me);
  }

  /** Mirrors the desktop nav's groups exactly (see renderNav above), just
   * rendered as labeled, stacked sections instead of a horizontal bar +
   * dropdowns - a drawer has no header-width constraint, so "Agency" and
   * "Current Client" can each get a plain section label rather than a
   * dropdown trigger. */
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
        <div class="branch-switch branch-switch-mobile" id="branchSwitchSlotMobile" style="display:none"></div>
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
    document.getElementById("userMenu")?.setAttribute("hidden", "");
    document.getElementById("userTrigger")?.setAttribute("aria-expanded", "false");
    document.getElementById("settingsNavMenu")?.setAttribute("hidden", "");
    document.getElementById("settingsNavBtn")?.setAttribute("aria-expanded", "false");
    document.getElementById("agencyNavMenu")?.setAttribute("hidden", "");
    document.getElementById("agencyNavBtn")?.setAttribute("aria-expanded", "false");
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
    document.getElementById("userTrigger")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("userTrigger", "userMenu");
    });
    document.getElementById("settingsNavBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("settingsNavBtn", "settingsNavMenu");
    });
    document.getElementById("agencyNavBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("agencyNavBtn", "agencyNavMenu");
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
  // honor this and which never do). Unlike the branch switcher below,
  // switching here is a FULL-PAGE NAVIGATION, not a live re-filter -
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

  async function exitClientContext() {
    try {
      await apiJson("/api/agency/context/exit", { method: "POST" });
    } catch {
      // Best-effort - even if this particular request fails, navigating to
      // the agency dashboard is harmless: that page's own auth guard talks
      // to a real agency company either way, and the next protected page's
      // own live re-validation (resolveActiveClientContext) is what
      // actually decides whether any lingering cookie still counts, not
      // this client-side call succeeding.
    }
    window.location.href = "/agency-dashboard.html";
  }

  function clientOptionsHtml(clients, selectedId) {
    if (!clients.length) return `<option value="">No clients assigned</option>`;
    const placeholder = `<option value="">Select a client…</option>`;
    const opts = clients
      .map((c) => `<option value="${c.id}"${c.id === selectedId ? " selected" : ""}>${escapeHtml(c.name)}</option>`)
      .join("");
    return placeholder + opts;
  }

  function wireAgencyContextSelect(sel) {
    if (!sel) return;
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      enterClientContext(sel.value);
    });
  }

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
    const optionsHtml = clientOptionsHtml(info.clients, info.clientContextId);

    if (desktopSlot) {
      desktopSlot.style.display = "";
      desktopSlot.classList.toggle("in-context", inContext);
      desktopSlot.innerHTML = `
        <span class="agency-context-badge">${inContext ? "Managing" : escapeHtml(info.agencyName)}</span>
        <select class="agency-context-select" aria-label="Client">${optionsHtml}</select>
        <button type="button" class="agency-context-exit"${inContext ? "" : ' style="display:none"'}>Exit</button>
      `;
      wireAgencyContextSelect(desktopSlot.querySelector(".agency-context-select"));
      if (inContext) desktopSlot.querySelector(".agency-context-exit")?.addEventListener("click", exitClientContext);
    }

    if (mobileSlot) {
      mobileSlot.style.display = "";
      mobileSlot.classList.toggle("in-context", inContext);
      mobileSlot.innerHTML = `
        <div class="agency-context-mobile-agency">${escapeHtml(info.agencyName)}</div>
        <div class="agency-context-mobile-status">${
          inContext ? `Managing:<strong>${escapeHtml(info.clientContextName || "")}</strong>` : "Current Client"
        }</div>
        <select class="agency-context-select" aria-label="Client">${optionsHtml}</select>
        ${inContext ? `<button type="button" class="agency-context-exit">Exit to Agency</button>` : ""}
      `;
      wireAgencyContextSelect(mobileSlot.querySelector(".agency-context-select"));
      if (inContext) mobileSlot.querySelector(".agency-context-exit")?.addEventListener("click", exitClientContext);
    }
  }

  /** Called from renderNav with the same `me` (GET /api/auth/me result)
   * every page already fetches - reads `me.agency`/`me.clientContext`
   * (see api/auth/handler.ts's handleMe) rather than making its own probe
   * request, then fetches the actual client list separately since /api/me
   * intentionally stays a cheap, no-extra-DB-fanout endpoint. Renders
   * immediately with just the agency name/current state so the switcher
   * shell never waits on the clients fetch to appear, then re-renders once
   * the list resolves (or hides gracefully on failure - never blocks the
   * rest of the shell, same convention as loadBranchSwitcher below). */
  async function loadAgencyContextSwitcher(me) {
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
    try {
      const data = await apiJson("/api/agency/dashboard");
      agencyContextInfo.clients = (data.clients || []).map((c) => ({ id: c.id, name: c.name }));
    } catch {
      agencyContextInfo.clients = [];
    }
    renderAgencyContextSwitcher();
  }

  // ---------------------------------------------------------------------
  // Branch switcher: a global "[ All Branches ▼ ]" control in the app shell
  // (desktop nav + mobile drawer, kept in sync) for multi-branch access.
  // Populated from GET /api/branches/mine, which already returns exactly
  // the branches this user is allowed to see (every active branch for an
  // unrestricted user, or just their own membership for a restricted one -
  // see src/application/branchAccess.ts) - so this control can only ever
  // offer choices the backend would accept; it narrows what's already
  // visible, it doesn't grant anything on its own. Hidden entirely when the
  // user has 0 or 1 accessible branches - "a user who only has one branch
  // should not need to select it repeatedly".
  //
  // Selection is per-user (localStorage key includes the user id) so it
  // persists across reloads without leaking between accounts on a shared
  // machine, and is broadcast via a "setu:branchchange" window event so any
  // page can opt in with App.onBranchChange(fn) - pages that never call it
  // are simply unaffected, exactly like campaignSelect's existing filter
  // pattern in pipeline.html.
  // ---------------------------------------------------------------------

  let branchSwitcherState = { userId: null, selectedId: "" };
  // Cached result of the one GET /api/branches/mine fetch per page load -
  // null until it resolves. Page-level toolbars (Pipeline, Dashboard) call
  // mountBranchFilter() which either renders immediately (data already
  // here) or queues itself in pendingMounts until loadBranchSwitcher's
  // fetch completes - so a page can request its own toolbar control before
  // or after App.renderNav() without caring which happens first.
  let branchSwitcherData = null;
  const builtinMounts = [
    { container: () => document.getElementById("branchSwitchSlot"), allLabel: null },
    { container: () => document.getElementById("branchSwitchSlotMobile"), allLabel: null },
  ];
  const pendingMounts = [];

  function branchStorageKey(userId) {
    return `setu_branch_${userId}`;
  }

  function getStoredBranchId(userId) {
    try {
      return localStorage.getItem(branchStorageKey(userId)) || "";
    } catch {
      return "";
    }
  }

  function setStoredBranchId(userId, branchId) {
    try {
      if (branchId) localStorage.setItem(branchStorageKey(userId), branchId);
      else localStorage.removeItem(branchStorageKey(userId));
    } catch {
      /* private browsing / storage disabled - selection just won't survive a reload */
    }
  }

  function getSelectedBranchId() {
    return branchSwitcherState.selectedId || null;
  }

  /** The raw { scope, branches } this user is allowed to see, as last
   * fetched by the switcher (null until that fetch resolves) - branches[].id
   * is what getSelectedBranchId()/branchId query params expect, and
   * branches[].isPrimary (restricted scope only) is there so a page like
   * "+ Add Customer" can default a picker to the user's primary branch
   * instead of just the first one in the list. */
  function getMyBranches() {
    return branchSwitcherData;
  }

  function onBranchChange(handler) {
    window.addEventListener("setu:branchchange", (e) => handler(e.detail.branchId));
  }

  function applySelectedBranch(userId, branchId, { silent } = {}) {
    branchSwitcherState = { userId, selectedId: branchId || "" };
    setStoredBranchId(userId, branchId);
    document.querySelectorAll(".branch-switch-select").forEach((sel) => {
      if (sel.value !== branchSwitcherState.selectedId) sel.value = branchSwitcherState.selectedId;
    });
    if (!silent) {
      window.dispatchEvent(new CustomEvent("setu:branchchange", { detail: { branchId: branchSwitcherState.selectedId || null } }));
    }
  }

  function renderBranchSwitcherInto(container, branches, allLabel, userId, opts = {}) {
    if (!container) return;
    const sel = document.createElement("select");
    sel.className = "branch-switch-select";
    if (opts.selectId) sel.id = opts.selectId;
    sel.setAttribute("aria-label", opts.fieldLabel || "Branch");
    sel.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + branches.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
    sel.value = branchSwitcherState.selectedId;
    sel.addEventListener("change", () => applySelectedBranch(userId, sel.value));
    container.innerHTML = "";
    // A page-level toolbar mount (e.g. next to Pipeline's Campaign filter)
    // wants a visible <label> matching that field's own styling; the
    // nav-shell mounts pass no fieldLabel and rely on the select's
    // aria-label instead, exactly as before this option existed.
    if (opts.fieldLabel) {
      const lab = document.createElement("label");
      if (opts.selectId) lab.setAttribute("for", opts.selectId);
      lab.textContent = opts.fieldLabel;
      container.appendChild(lab);
    }
    container.appendChild(sel);
    container.style.display = "";
  }

  function defaultAllLabel() {
    return branchSwitcherData?.scope === "all" ? "All Branches" : "All my branches";
  }

  function renderMount(mount) {
    const container = typeof mount.container === "function" ? mount.container() : mount.container;
    if (!container) return;
    const branches = branchSwitcherData?.branches ?? [];
    if (branches.length <= 1) {
      container.style.display = "none";
      return;
    }
    renderBranchSwitcherInto(container, branches, mount.allLabel || defaultAllLabel(), branchSwitcherState.userId, {
      fieldLabel: mount.fieldLabel,
      selectId: mount.selectId,
    });
  }

  function renderAllMounts() {
    builtinMounts.forEach(renderMount);
    pendingMounts.forEach(renderMount);
  }

  /** Lets any page add its own "[ All Branches ▼ ]" control (e.g. the
   * Pipeline toolbar next to the Campaign filter, or the Dashboard header) -
   * kept in sync with the nav-level switcher and every other mounted
   * instance for free (same shared state, same "setu:branchchange" event).
   * Safe to call before App.renderNav()'s branch fetch has resolved - it
   * queues and renders as soon as data is ready - and hides itself the same
   * way the nav switcher does when the user has 0 or 1 accessible branches. */
  function mountBranchFilter(container, opts = {}) {
    if (!container) return;
    const mount = { container, allLabel: opts.allLabel || null, fieldLabel: opts.fieldLabel || null, selectId: opts.selectId || null };
    pendingMounts.push(mount);
    if (branchSwitcherData) renderMount(mount);
  }

  async function loadBranchSwitcher(me) {
    if (!me?.user?.id) return;
    try {
      const data = await apiJson("/api/branches/mine");
      branchSwitcherData = data;

      if (!data.branches || data.branches.length <= 1) {
        branchSwitcherState = { userId: me.user.id, selectedId: "" };
        renderAllMounts(); // hides every mounted control, built-in or page-level
        return;
      }

      const stored = getStoredBranchId(me.user.id);
      const validStored = data.branches.some((b) => b.id === stored) ? stored : "";
      branchSwitcherState = { userId: me.user.id, selectedId: validStored };
      if (validStored !== stored) setStoredBranchId(me.user.id, validStored);

      renderAllMounts();

      // A restored (non-default) selection is broadcast so any page that
      // already loaded its initial (unfiltered) data re-fetches scoped to
      // it - the alternative would be every page having to await this
      // async call before its own first load, which would slow down the
      // common (no restriction / no prior selection) case for everyone.
      if (validStored) {
        window.dispatchEvent(new CustomEvent("setu:branchchange", { detail: { branchId: validStored } }));
      }
    } catch {
      // Never let this block the rest of the shell - just hide every switcher.
      branchSwitcherData = { scope: "all", branches: [] };
      renderAllMounts();
    }
  }

  return {
    api,
    apiJson,
    requireAuth,
    hasPermission,
    logout,
    renderNav,
    escapeHtml,
    initials,
    getSelectedBranchId,
    getMyBranches,
    onBranchChange,
    mountBranchFilter,
    enterClient,
  };
})();
