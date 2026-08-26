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
      // one generic banner message.
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { fieldErrors: data.fieldErrors });
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
      window.location.href = "/login.html?next=" + encodeURIComponent(window.location.pathname);
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
  };

  const PRIMARY_LINKS = [
    { href: "/dashboard.html", label: "Dashboard", icon: NAV_ICONS.dashboard },
    { href: "/campaigns.html", label: "Campaigns", icon: NAV_ICONS.campaigns },
    { href: "/pipeline.html", label: "Pipeline", icon: NAV_ICONS.pipeline },
  ];

  const ADMIN_LINKS = [
    { href: "/forms.html", label: "Forms", perm: "forms.view", icon: NAV_ICONS.forms },
    { href: "/submissions.html", label: "Submissions", perm: "submissions.view", icon: NAV_ICONS.submissions },
    { href: "/admin/users.html", label: "Users", perm: "users.manage", icon: NAV_ICONS.users },
    { href: "/admin/roles.html", label: "Roles", perm: "roles.manage", icon: NAV_ICONS.roles },
    { href: "/admin/branches.html", label: "Branches", perm: "branches.manage", icon: NAV_ICONS.branches },
    { href: "/settings.html", label: "Settings", perm: "integrations.manage", icon: NAV_ICONS.settings },
  ];

  function navLinkHtml(link, activeHref, extraClass) {
    const active = link.href === activeHref;
    const icon = link.icon ? `<span class="nav-link-icon">${link.icon}</span>` : "";
    return `<a href="${link.href}" class="${extraClass || "nav-link"}${active ? " active" : ""}"${active ? ' aria-current="page"' : ""}>${icon}${link.label}</a>`;
  }

  function renderNav(me, activeHref) {
    const nav = document.getElementById("topnav");
    if (!nav) return;
    nav.classList.add("topnav");

    const admin = ADMIN_LINKS.filter((l) => hasPermission(me, l.perm));
    const primaryHtml = PRIMARY_LINKS.map((l) => navLinkHtml(l, activeHref)).join("");
    const adminHtml = admin.length
      ? `<span class="nav-sep" aria-hidden="true"></span>` + admin.map((l) => navLinkHtml(l, activeHref)).join("")
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

        <div class="shell-center">${primaryHtml}${adminHtml}</div>

        <div class="shell-right">
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

    renderMobileDrawer(me, activeHref, admin);
    wireShellInteractions();
    loadBranchSwitcher(me);
  }

  function renderMobileDrawer(me, activeHref, admin) {
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

    drawer.innerHTML = `
      <div class="mobile-drawer-inner">
        <div class="mobile-user-row">
          <span class="avatar avatar-lg">${escapeHtml(initials(displayName))}</span>
          <div><div class="user-name">${escapeHtml(displayName)}</div>${roleName ? `<div class="user-role">${escapeHtml(roleName)}</div>` : ""}</div>
        </div>
        <div class="branch-switch branch-switch-mobile" id="branchSwitchSlotMobile" style="display:none"></div>
        <div class="mobile-nav-group">${groupHtml(PRIMARY_LINKS)}</div>
        ${admin.length ? `<div class="mobile-nav-divider"></div><div class="mobile-nav-group">${groupHtml(admin)}</div>` : ""}
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
  };
})();
