// Resolves a runtime configuration value, letting the UAT deployment read a
// `UAT_`-prefixed override of the same variable set in Vercel's Environment
// Variables, while Production (and local dev) keep reading the plain name.
//
// Why: this repo's Vercel project stores UAT's secrets as UAT_DATABASE_URL,
// UAT_AUTH_JWT_SECRET, etc. (mirroring the naming already used for this
// project's GitHub Actions secrets), while Production keeps the plain
// names (DATABASE_URL, AUTH_JWT_SECRET, ...). Rather than maintaining two
// full sets of identically-named variables in Vercel, every call site reads
// through `getEnv()` so the same code works against either naming scheme.
//
// Detection: Vercel automatically injects VERCEL_ENV ("production" |
// "preview" | "development") and VERCEL_GIT_COMMIT_REF (the branch being
// deployed) into every deployment - no manual configuration needed. We only
// treat a deployment as UAT when it's a preview deployment of the UAT
// branch specifically, so preview deployments of other branches (e.g. a
// feature-branch PR) are unaffected and fall back to the plain,
// production-shaped variable names.
function isUatDeployment(): boolean {
  return process.env.VERCEL_ENV === "preview" && process.env.VERCEL_GIT_COMMIT_REF === "UAT";
}

/**
 * Reads `name` from the environment. On a UAT deployment, tries
 * `UAT_<name>` first and falls back to the plain `name` if that isn't set
 * (so a variable that's only ever had one name still works on UAT).
 * Everywhere else (Production, local dev, CI), reads `name` directly.
 */
export function getEnv(name: string): string | undefined {
  if (isUatDeployment()) {
    const uatValue = process.env[`UAT_${name}`];
    if (uatValue !== undefined && uatValue !== "") return uatValue;
  }
  return process.env[name];
}
