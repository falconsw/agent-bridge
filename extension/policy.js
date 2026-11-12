// URL policy applied to every agent tab: the user's blocked patterns (popup) and the run's
// allowed domains (--allow on the bridge). Both are set by the user, outside the model's reach:
// no tool argument can change them, so a page cannot talk the agent into widening them.
// Pure functions (no chrome.*): the bridge CLI and the tests import this file too.

/** Blocked URL patterns: comma-separated globs over host + path (enterprise-style policy). */
export function matchesBlocked(url, patterns) {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return false;
  }
  const target = host + path;
  return patterns.some((pattern) => {
    const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`(^|//|\\.)${escaped.replace(/^\^/, "")}`, "i").test(target) || new RegExp(`^${escaped}$`, "i").test(target);
  });
}

const ALLOW_ENTRY = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(\/[^\s*]*)?\*?$/;
const bare = (host) => host.toLowerCase().replace(/^www\./, "");

/**
 * Parses "ads.google.com, *.example.com, github.com/falconsw/" into normalized entries.
 * Throws on anything it cannot match strictly: an allow list must fail closed.
 */
export function parseAllow(input) {
  return String(input ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^[a-z]+:\/\//, ""))
    .filter(Boolean)
    .map((entry) => {
      if (!ALLOW_ENTRY.test(entry)) throw new Error(`invalid --allow entry: ${entry}`);
      return entry.replace(/\*$/, "").replace(/\/$/, "");
    });
}

/**
 * True when `url` is inside the allow list (an empty list allows everything).
 * `example.com` is that host only (www. ignored), `*.example.com` adds its subdomains,
 * and `example.com/app` also requires the path to start with /app.
 * Unlike the blocked patterns this never matches loosely: `example.com` does not cover
 * `example.com.evil.net` or `evil.net/example.com`.
 */
export function matchesAllowed(url, allow) {
  if (!allow?.length) return true;
  if (!url || url === "about:blank") return true; // a tab before its first load
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = bare(u.hostname);
  return allow.some((entry) => {
    if (typeof entry !== "string") return false;
    const slash = entry.indexOf("/");
    const pattern = slash < 0 ? entry : entry.slice(0, slash);
    const path = slash < 0 ? "" : entry.slice(slash);
    const wild = pattern.startsWith("*.");
    const domain = bare(wild ? pattern.slice(2) : pattern);
    if (!domain) return false;
    if (host !== domain && !(wild && host.endsWith(`.${domain}`))) return false;
    return !path || u.pathname === path || u.pathname.startsWith(`${path}/`);
  });
}

/** Why `url` is off limits: "blocked" | "notAllowed" | null. */
export function denyReason(url, { blockPatterns = [], allow = [] } = {}) {
  if (matchesBlocked(url, blockPatterns)) return "blocked";
  return matchesAllowed(url, allow) ? null : "notAllowed";
}
