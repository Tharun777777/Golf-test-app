const express = require("express");
const session = require("express-session");
const path    = require("path");
const os      = require("os");

const app  = express();
const PORT = process.env.PORT || 3000;

// Hardcoded users — login is by company email address.
// Org ID is NOT stored per-user. It's derived from the domain after "@",
// the same way a real company would map an email domain to a tenant/org —
// so anyone at the same company automatically gets the same org, with no
// per-user config needed.
const USERS = {
  "tharun@google.com":     { password: "golf123" },
  "tharun@benevolate.com": { password: "golf123" }
};

// Domain -> Org ID mapping. This is now only the FALLBACK source of truth —
// used if ADMIN_API_URL is not set, or the admin panel can't be reached.
// The preferred source is the admin panel's live org-for-domain lookup
// below, so adding/changing a domain mapping there takes effect immediately
// with no redeploy of this app.
const DOMAIN_ORG_MAP = {
  "google.com":     "1",
  "benevolate.com": "2"
};

// ─── Admin panel lookups ──────────────────────────────────────────────────
// Preferred source of truth: the CI/CD admin panel's live endpoints
// (the "Authorized Beta Organizations" table). Set ADMIN_API_URL to the
// admin panel's reachable base URL (e.g. https://admin.benevolaite.com) to
// use it — adding/removing/remapping an org there then takes effect
// immediately, with no redeploy of this app.
//
// Fallback source: the static maps below (DOMAIN_ORG_MAP / BETA_ORG_IDS
// env var / AUTHORIZED_BETA_ORGS). These are used automatically if
// ADMIN_API_URL is not set, or if the admin panel can't be reached (e.g.
// it's only running locally and hasn't been deployed yet) — so login/
// routing never breaks either way.
const ADMIN_API_URL = (process.env.ADMIN_API_URL || "").replace(/\/$/, "");
const ADMIN_API_TIMEOUT_MS = 2000;

// Static fallback list of authorized org IDs — e.g. "2" for @benevolate.com.
const AUTHORIZED_BETA_ORGS = (process.env.BETA_ORG_IDS || "2")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Resolves a login email to an org ID. Tries the live admin panel first
// (same pattern as isBetaOrg below), falls back to the static
// DOMAIN_ORG_MAP on any failure (not configured, network error, timeout,
// bad response, domain not mapped there, etc.). This is the ONLY place
// that decides which org an email belongs to.
async function orgIdForEmail(email) {
  const domain = (email || "").split("@")[1];
  if (!domain) return null;

  if (ADMIN_API_URL) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ADMIN_API_TIMEOUT_MS);
      const resp = await fetch(
        `${ADMIN_API_URL}/api/public/org-for-domain?domain=${encodeURIComponent(domain)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        if (data.orgId) return data.orgId;
        // Admin panel reached fine and just doesn't have this domain mapped —
        // that's a real answer (no org), not a failure, so don't fall back.
        return null;
      }
      console.warn(`[org-lookup] admin API returned HTTP ${resp.status}, falling back to static map`);
    } catch (err) {
      console.warn(`[org-lookup] admin API unreachable (${err.message}), falling back to static map`);
    }
  }

  return DOMAIN_ORG_MAP[domain] || null;
}

const ENV_COOKIE_NAME = "__env";

// Decide whether an org should get the beta cookie. Tries the live admin
// panel first (if configured), falls back to the static list on any
// failure (not configured, network error, timeout, bad response, etc.).
async function isBetaOrg(orgId) {
  if (!orgId) return { isBeta: false, source: "none" };

  if (ADMIN_API_URL) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ADMIN_API_TIMEOUT_MS);
      const resp = await fetch(
        `${ADMIN_API_URL}/api/public/is-beta-org?orgId=${encodeURIComponent(orgId)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        return { isBeta: !!data.isBeta, source: "admin-api" };
      }
      console.warn(`[beta-check] admin API returned HTTP ${resp.status}, falling back to static list`);
    } catch (err) {
      console.warn(`[beta-check] admin API unreachable (${err.message}), falling back to static list`);
    }
  }

  return { isBeta: AUTHORIZED_BETA_ORGS.includes(orgId), source: "static-list" };
}

// Minimal cookie reader — avoids pulling in cookie-parser for one cookie.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: "golf-demo-secret-key",
  resave: false,
  saveUninitialized: false
}));

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect("/login");
}

// ── Routes ──────────────────────────────────────────

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const account = USERS[username];
  if (account && account.password === password) {
    req.session.user = username;
    req.session.orgId = await orgIdForEmail(username);

    // This is the piece that feeds the ALB's cookie-based routing rule:
    // authorized org -> __env=beta (green), everyone else -> no cookie (blue/prod).
    try {
      const { isBeta, source } = await isBetaOrg(req.session.orgId);
      req.session.betaSource = source;
      if (isBeta) {
        res.cookie(ENV_COOKIE_NAME, "beta", { path: "/" });
      } else {
        res.clearCookie(ENV_COOKIE_NAME, { path: "/" });
      }
    } catch (err) {
      // Should not happen (isBetaOrg already catches internally), but never
      // block login over a routing-cookie decision.
      console.error("[beta-check] unexpected error, defaulting to prod:", err);
      res.clearCookie(ENV_COOKIE_NAME, { path: "/" });
    }

    return res.redirect("/");
  }
  res.render("login", { error: "Invalid username or password" });
});

app.get("/logout", (req, res) => {
  res.clearCookie(ENV_COOKIE_NAME, { path: "/" });
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireLogin, (req, res) => {
  res.render("home", { user: req.session.user, page: "home" });
});

app.get("/courses", requireLogin, (req, res) => {
  res.render("courses", { user: req.session.user, page: "courses" });
});

app.get("/scores", requireLogin, (req, res) => {
  res.render("scores", { user: req.session.user, page: "scores" });
});

app.get("/release-test", requireLogin, (req, res) => {
  const cookies = parseCookies(req);
  const envCookie = cookies[ENV_COOKIE_NAME] || null;
  res.render("release-test", {
    user: req.session.user,
    page: "release-test",
    orgId: req.session.orgId || null,
    envCookie,
    isBeta: envCookie === "beta",
    buildVersion: process.env.BUILD_VERSION || "local",
    hostname: os.hostname(),
    authorizedOrgs: AUTHORIZED_BETA_ORGS,
    adminApiUrl: ADMIN_API_URL || null,
    betaSource: req.session.betaSource || "unknown"
  });
});

// Health check for ALB / ECS
app.get("/health", (req, res) => res.json({ status: "ok", version: process.env.BUILD_VERSION || "local" }));

app.listen(PORT, () => {
  console.log(`Golf Demo App running on http://localhost:${PORT}`);
});
