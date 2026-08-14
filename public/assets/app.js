// Shared client-side helpers: an api() fetch wrapper that transparently
// refreshes the access token once on a 401 before giving up, an auth guard
// every protected page calls on load, and the top nav renderer. No build
// step, no framework - plain JS, consistent with the rest of this project's
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
      throw new Error(data.error || `Request failed (${res.status})`);
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

  const NAV_LINKS = [
    { href: "/dashboard.html", label: "Dashboard" },
    { href: "/campaigns.html", label: "Campaigns" },
    { href: "/pipeline.html", label: "Pipeline" },
    { href: "/admin/users.html", label: "Users" },
    { href: "/admin/roles.html", label: "Roles" },
  ];

  function renderNav(me, activeHref) {
    const nav = document.getElementById("topnav");
    if (!nav) return;
    const links = NAV_LINKS.filter((l) => {
      if (l.href.startsWith("/admin/")) return hasPermission(me, "users.manage") || hasPermission(me, "roles.manage");
      return true;
    })
      .map((l) => `<a href="${l.href}" class="${l.href === activeHref ? "active" : ""}">${l.label}</a>`)
      .join("");

    nav.innerHTML = `
      <div class="brand">${me?.company?.name ?? "Meta Lead Ads"}</div>
      <div class="links">${links}</div>
      <div class="right">
        <span>${me?.user?.fullName ?? ""}</span>
        <button class="link-btn" id="logoutBtn">Sign out</button>
      </div>
    `;
    document.getElementById("logoutBtn")?.addEventListener("click", logout);
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  return { api, apiJson, requireAuth, hasPermission, logout, renderNav, escapeHtml };
})();
