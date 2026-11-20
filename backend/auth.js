// Accounts, passwords and sign-in sessions for the admin panel and the vendor / franchise portals.
//
// - Passwords are stored only as salted scrypt hashes, never in plain text.
// - A session is a random token kept in an HttpOnly cookie; the database stores only its SHA-256 hash.
// - Each area has its own cookie, so an admin, a vendor and a franchise partner can be signed in
//   from the same browser without interfering with each other.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
export const ROLES = ["admin", "vendor", "franchise"];
const COOKIE = {
  admin: "otw_admin_session",
  vendor: "otw_vendor_session",
  franchise: "otw_franchise_session",
};
const SHORT_SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours
const LONG_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days ("Remember me" and partner portals)
const TEMP_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no 0/O, 1/l/I

export async function createAuth(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, role TEXT NOT NULL, login_id TEXT NOT NULL UNIQUE, email TEXT, name TEXT,
      password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active', application_id TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, password_changed_at TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
    CREATE TABLE IF NOT EXISTS portal_data(account_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS password_resets(
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT);
    CREATE INDEX IF NOT EXISTS password_resets_account ON password_resets(account_id);
  `);

  const existingCols = await db
    .prepare(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts'`,
    )
    .all();
  const colSet = new Set(existingCols.map((c) => c.column_name));

  // Older databases have no admin_role column. Adding it changes nobody's access: every admin keeps the
  // permissions they had; 'super_admin' only unlocks the Admin Accounts section (see ensureSuperAdmin below).
  if (!colSet.has("admin_role")) {
    await db.exec("ALTER TABLE accounts ADD COLUMN admin_role TEXT");
  }
  // Partner bans (Admin > Client > Ban): columns added to older databases; nobody is banned by the upgrade.
  for (const col of ["banned_at", "banned_until", "ban_reason", "banned_by"]) {
    if (!colSet.has(col)) {
      await db.exec(`ALTER TABLE accounts ADD COLUMN ${col} TEXT`);
    }
  }

  const now = () => new Date().toISOString();
  const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

  // ---------- passwords ----------
  async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(String(password), salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
  }
  async function verifyPassword(password, stored) {
    try {
      const [kind, N, r, p, saltB64, hashB64] = String(stored || "").split("$");
      if (kind !== "scrypt") return false;
      const expected = Buffer.from(hashB64, "base64");
      const actual = await scrypt(
        String(password),
        Buffer.from(saltB64, "base64"),
        expected.length,
        { N: Number(N), r: Number(r), p: Number(p) },
      );
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  function passwordProblem(password) {
    const p = String(password || "");
    if (p.length < 8) return "Use at least 8 characters.";
    if (p.length > 128) return "Use at most 128 characters.";
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p))
      return "Use both letters and numbers.";
    return "";
  }
  function tempPassword() {
    const pick = () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
    const group = () => Array.from({ length: 4 }, pick).join("");
    let pw;
    do {
      pw = `${group()}-${group()}-${group()}`;
    } while (passwordProblem(pw));
    return pw;
  }

  // ---------- accounts ----------
  const q = {
    byId: db.prepare("SELECT * FROM accounts WHERE id=?"),
    byLogin: db.prepare("SELECT * FROM accounts WHERE login_id=?"),
    byEmailRole: db.prepare(
      "SELECT * FROM accounts WHERE lower(email)=? AND role=?",
    ),
    byApplication: db.prepare("SELECT * FROM accounts WHERE application_id=?"),
    adminByEmailOrLogin: db.prepare(
      `SELECT * FROM accounts WHERE role='admin' AND (lower(trim(email))=? OR lower(trim(login_id))=?)`,
    ),
    insert: db.prepare(
      `INSERT INTO accounts(id,role,login_id,email,name,password_hash,must_change_password,status,application_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ),
  };

  function banInfo(a) {
    if (!a || !a.banned_at || (a.role !== "vendor" && a.role !== "franchise")) return null;
    if (a.banned_until && a.banned_until <= now()) return null;
    return {
      since: a.banned_at,
      until: a.banned_until || "",
      reason: a.ban_reason || "",
      by: a.banned_by || "",
    };
  }
  function publicAccount(a) {
    if (!a) return null;
    return {
      ban: banInfo(a),
      loginId: a.login_id,
      role: a.role,
      name: a.name || "",
      email: a.email || "",
      status: a.status,
      mustChangePassword: !!a.must_change_password,
      lastLoginAt: a.last_login_at || null,
      createdAt: a.created_at,
      isSuperAdmin: a.role === "admin" && a.admin_role === "super_admin",
    };
  }
  function normaliseLoginId(role, loginId) {
    const raw = String(loginId || "").trim();
    if (role === "admin" || raw.includes("@")) return raw.toLowerCase();
    const m = raw
      .toUpperCase()
      .replace(/\s+/g, "")
      .match(/^(VN|FP|FR)-?0*(\d{1,6})$/);
    if (!m) return raw.toUpperCase();
    const prefix = m[1] === "FR" ? "FP" : m[1];
    return `${prefix}-${m[2].padStart(6, "0")}`;
  }
  async function findForLogin(role, loginId) {
    const id = normaliseLoginId(role, loginId);
    if (!id) return { account: null };
    if (role !== "admin" && id.includes("@")) {
      const rows = await q.byEmailRole.all(id, role);
      if (rows.length > 1) return { account: null, ambiguous: true };
      return { account: rows[0] || null };
    }
    const a = await q.byLogin.get(id);
    return { account: a && a.role === role ? a : null };
  }
  async function findCandidates(role, loginId) {
    const id = normaliseLoginId(role, loginId);
    if (!id) return [];
    if (role === "admin") return q.adminByEmailOrLogin.all(id, id);
    if (id.includes("@")) return q.byEmailRole.all(id, role);
    const a = await q.byLogin.get(id);
    return a && a.role === role ? [a] : [];
  }
  async function createAccount({
    role,
    loginId,
    email = "",
    name = "",
    password,
    mustChange = true,
    applicationId = null,
  }) {
    const t = now();
    const id = crypto.randomUUID();
    await q.insert.run(
      id,
      role,
      normaliseLoginId(role, loginId),
      email,
      name,
      await hashPassword(password),
      mustChange ? 1 : 0,
      "active",
      applicationId,
      t,
      t,
    );
    return q.byId.get(id);
  }
  async function setPassword(accountId, password, { mustChange }) {
    const t = now();
    await db
      .prepare(
        "UPDATE accounts SET password_hash=?,must_change_password=?,password_changed_at=?,updated_at=? WHERE id=?",
      )
      .run(await hashPassword(password), mustChange ? 1 : 0, t, t, accountId);
  }

  // ---------- sessions ----------
  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) {
        try {
          out[part.slice(0, i).trim()] = decodeURIComponent(
            part.slice(i + 1).trim(),
          );
        } catch {
          /* ignore a malformed cookie */
        }
      }
    }
    return out;
  }
  function isHttpsRequest(req) {
    if (req.secure || process.env.COOKIE_SECURE === "true") return true;
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return forwardedProto === "https";
  }
  function cookieHeader(req, name, value, maxAgeMs) {
    const secure = isHttpsRequest(req);
    const configuredSameSite = String(process.env.COOKIE_SAME_SITE || "")
      .trim()
      .toLowerCase();
    let sameSite = "Lax";
    if (configuredSameSite === "none" && secure) sameSite = "None";
    else if (configuredSameSite === "strict") sameSite = "Strict";
    else if (configuredSameSite === "lax") sameSite = "Lax";
    else if (secure) sameSite = "None";

    let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}`;
    if (secure) c += "; Secure";
    if (maxAgeMs === 0) c += "; Max-Age=0";
    else if (maxAgeMs) c += `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
    return c;
  }
  async function startSession(req, res, account, { remember = false } = {}) {
    const token = crypto.randomBytes(32).toString("base64url");
    const life =
      account.role === "admin" && !remember
        ? SHORT_SESSION_MS
        : LONG_SESSION_MS;
    const t = now();
    await db
      .prepare(
        "INSERT INTO sessions(token_hash,account_id,role,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        sha256(token),
        account.id,
        account.role,
        t,
        new Date(Date.now() + life).toISOString(),
        t,
      );
    await db
      .prepare("UPDATE accounts SET last_login_at=? WHERE id=?")
      .run(t, account.id);
    res.append(
      "Set-Cookie",
      cookieHeader(
        req,
        COOKIE[account.role],
        token,
        account.role === "admin" && !remember ? null : life,
      ),
    );
  }
  async function getSession(req, role) {
    const token = parseCookies(req)[COOKIE[role]];
    if (!token) return null;
    const s = await db
      .prepare("SELECT * FROM sessions WHERE token_hash=?")
      .get(sha256(token));
    if (!s || s.role !== role || s.expires_at < now()) return null;
    const account = await q.byId.get(s.account_id);
    if (!account || account.status !== "active" || account.role !== role)
      return null;
    if (banInfo(account)) return null;
    return { account, tokenHash: s.token_hash };
  }
  async function endSession(req, res, role) {
    const token = parseCookies(req)[COOKIE[role]];
    if (token) {
      await db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .run(sha256(token));
    }
    res.append("Set-Cookie", cookieHeader(req, COOKIE[role], "", 0));
  }
  async function endAllSessions(accountId, exceptTokenHash = null) {
    if (exceptTokenHash) {
      await db
        .prepare("DELETE FROM sessions WHERE account_id=? AND token_hash<>?")
        .run(accountId, exceptTokenHash);
    } else {
      await db.prepare("DELETE FROM sessions WHERE account_id=?").run(accountId);
    }
  }
  async function cleanupSessions() {
    await db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now());
    await db
      .prepare("DELETE FROM password_resets WHERE created_at<?")
      .run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
  }

  function requireRole(...roles) {
    return async (req, res, next) => {
      for (const role of roles) {
        const s = await getSession(req, role);
        if (!s) continue;
        if (s.account.must_change_password)
          return res.status(403).json({
            error: "Please set a new password first.",
            code: "PASSWORD_CHANGE_REQUIRED",
          });
        req.account = s.account;
        req.session = s;
        if (role === "admin")
          req.adminEmail = s.account.email || s.account.login_id;
        return next();
      }
      return res
        .status(401)
        .json({ error: "Please sign in again.", code: "NOT_SIGNED_IN" });
    };
  }

  // ---------- admin password reset by email ----------
  const RESET_MS = 30 * 60 * 1000;
  const RESET_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  const RESET_LIMIT_PER_WINDOW = 5;

  async function findAdminByEmail(email) {
    const e = String(email || "")
      .trim()
      .toLowerCase();
    if (!e) return null;
    const rows = (await q.adminByEmailOrLogin.all(e, e)).filter(
      (a) => a.status === "active",
    );
    return rows.length === 1 ? rows[0] : null;
  }
  async function recentResetCount(accountId, windowMs = RESET_LIMIT_WINDOW_MS) {
    const since = new Date(Date.now() - windowMs).toISOString();
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM password_resets WHERE account_id=? AND created_at>=?",
      )
      .get(accountId, since);
    return Number(row?.n || 0);
  }
  async function createPasswordReset(accountId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = now();
    await db
      .prepare(
        "UPDATE password_resets SET used_at=? WHERE account_id=? AND used_at IS NULL",
      )
      .run(t, accountId);
    await db
      .prepare(
        "INSERT INTO password_resets(token_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)",
      )
      .run(
        sha256(token),
        accountId,
        t,
        new Date(Date.now() + RESET_MS).toISOString(),
      );
    return token;
  }
  async function consumePasswordReset(token) {
    const raw = String(token || "");
    if (!/^[A-Za-z0-9_-]{20,}$/.test(raw)) return null;
    const row = await db
      .prepare("SELECT * FROM password_resets WHERE token_hash=?")
      .get(sha256(raw));
    if (!row || row.used_at || row.expires_at < now()) return null;
    const account = await q.byId.get(row.account_id);
    if (!account || account.role !== "admin" || account.status !== "active")
      return null;
    const used = await db
      .prepare(
        "UPDATE password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL",
      )
      .run(now(), row.token_hash);
    return used.changes === 1 ? account : null;
  }

  // ---------- admin account management (Super Admin) ----------
  async function ensureSuperAdmin(preferredEmail = "") {
    const admins = await db
      .prepare(`SELECT * FROM accounts WHERE role='admin' ORDER BY created_at ASC`)
      .all();
    if (!admins.length) return null;
    const wanted = String(preferredEmail || "")
      .trim()
      .toLowerCase();
    const named =
      wanted &&
      admins.find(
        (a) =>
          String(a.email || a.login_id)
            .trim()
            .toLowerCase() === wanted,
      );
    if (named && named.admin_role !== "super_admin") {
      await db
        .prepare(`UPDATE accounts SET admin_role='super_admin' WHERE id=?`)
        .run(named.id);
    }
    if (!admins.some((a) => a.admin_role === "super_admin") && !named) {
      await db
        .prepare(`UPDATE accounts SET admin_role='super_admin' WHERE id=?`)
        .run(admins[0].id);
    }
    return (
      (await db
        .prepare(
          `SELECT * FROM accounts WHERE role='admin' AND admin_role='super_admin' ORDER BY created_at ASC LIMIT 1`,
        )
        .get()) || null
    );
  }
  function isSuperAdmin(account) {
    return (
      !!account &&
      account.role === "admin" &&
      account.admin_role === "super_admin" &&
      account.status === "active"
    );
  }
  async function listAdmins() {
    const rows = await db
      .prepare(`SELECT * FROM accounts WHERE role='admin' ORDER BY created_at ASC`)
      .all();
    return rows.map((a) => ({
      loginId: a.login_id,
      name: a.name || "",
      email: (a.email || a.login_id || "").trim(),
      status: a.status,
      isSuperAdmin: a.admin_role === "super_admin",
      mustChangePassword: !!a.must_change_password,
      lastLoginAt: a.last_login_at || null,
      passwordChangedAt: a.password_changed_at || null,
      createdAt: a.created_at,
    }));
  }
  async function adminByLoginId(loginId) {
    const a = await q.byLogin.get(
      String(loginId || "")
        .trim()
        .toLowerCase(),
    );
    return a && a.role === "admin" ? a : null;
  }
  async function setAdminStatus(loginId, status, actorAccountId) {
    const a = await adminByLoginId(loginId);
    if (!a)
      return {
        ok: false,
        status: 404,
        error: "That admin account was not found.",
      };
    if (!["active", "disabled"].includes(status))
      return { ok: false, status: 400, error: "Unknown status." };
    if (status === "disabled") {
      if (a.id === actorAccountId)
        return {
          ok: false,
          status: 400,
          error: "You cannot switch off your own account.",
        };
      const othersRow = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND admin_role='super_admin' AND status='active' AND id<>?`,
        )
        .get(a.id);
      const others = Number(othersRow?.n || 0);
      if (a.admin_role === "super_admin" && !others)
        return {
          ok: false,
          status: 400,
          error:
            "This is the last active Super Admin and cannot be switched off.",
        };
    }
    await db
      .prepare("UPDATE accounts SET status=?,updated_at=? WHERE id=?")
      .run(status, now(), a.id);
    if (status === "disabled") await endAllSessions(a.id);
    return { ok: true, account: await q.byId.get(a.id) };
  }

  const ADMIN_EMAIL_RE = /^[^\s@<>()\\",;:]+@[^\s@<>()\\",;:]+\.[^\s@<>()\\",;:]+$/;
  function checkAdminName(name) {
    const n = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!n) return { error: "Enter the admin's full name.", field: "name" };
    if (n.length > 100)
      return { error: "The name is too long (100 characters at most).", field: "name" };
    return { value: n };
  }
  async function checkAdminEmail(email, exceptId = null) {
    const e = String(email ?? "").trim().toLowerCase();
    if (!e || e.length > 254 || !ADMIN_EMAIL_RE.test(e))
      return { error: "Enter a valid email address.", field: "email" };
    const clash =
      (await q.byLogin.get(e)) ||
      (await db
        .prepare(
          "SELECT * FROM accounts WHERE role='admin' AND lower(trim(email))=?",
        )
        .get(e));
    if (clash && clash.id !== exceptId)
      return {
        error: "Another account already uses this email address.",
        field: "email",
        status: 409,
      };
    return { value: e };
  }
  async function updateAdminDetails(loginId, { name, email } = {}) {
    const a = await adminByLoginId(loginId);
    if (!a)
      return { ok: false, status: 404, error: "That admin account was not found." };
    const fail = (c) => ({
      ok: false,
      status: c.status || 400,
      error: c.error,
      field: c.field,
    });
    const previousEmail = (a.email || a.login_id || "").trim().toLowerCase();
    let newName = a.name || "",
      newEmail = previousEmail;
    const changes = [];
    if (name !== undefined) {
      const c = checkAdminName(name);
      if (c.error) return fail(c);
      if (c.value !== newName) {
        newName = c.value;
        changes.push("name");
      }
    }
    if (email !== undefined) {
      const c = await checkAdminEmail(email, a.id);
      if (c.error) return fail(c);
      if (c.value !== previousEmail || c.value !== a.login_id) {
        newEmail = c.value;
        if (c.value !== previousEmail) changes.push("email");
      }
    }
    if (!changes.length && newEmail === a.login_id)
      return { ok: true, account: a, changes, previousEmail };
    const t = now();
    await db
      .prepare(
        "UPDATE accounts SET name=?,email=?,login_id=?,updated_at=? WHERE id=?",
      )
      .run(newName, newEmail, newEmail, t, a.id);
    if (changes.includes("email"))
      await db
        .prepare(
          "UPDATE password_resets SET used_at=? WHERE account_id=? AND used_at IS NULL",
        )
        .run(t, a.id);
    return { ok: true, account: await q.byId.get(a.id), changes, previousEmail };
  }
  async function addAdmin({ name, email } = {}) {
    const n = checkAdminName(name);
    if (n.error) return { ok: false, status: 400, error: n.error, field: n.field };
    const e = await checkAdminEmail(email);
    if (e.error)
      return { ok: false, status: e.status || 400, error: e.error, field: e.field };
    const password = tempPassword();
    const account = await createAccount({
      role: "admin",
      loginId: e.value,
      email: e.value,
      name: n.value,
      password,
      mustChange: true,
    });
    return { ok: true, account, password };
  }

  // ---------- partner accounts ----------
  function roleForApplication(app) {
    return String(app.type || "").toLowerCase() === "vendor"
      ? "vendor"
      : "franchise";
  }
  async function ensurePartnerAccount(app, { reset = false } = {}) {
    const role = roleForApplication(app),
      loginId = normaliseLoginId(role, app.appId);
    const email = String(app.email || "").trim(),
      name = String(app.name || "").trim();
    let account = await q.byApplication.get(app.id),
      password = null,
      created = false;
    if (!account) {
      password = tempPassword();
      account = await createAccount({
        role,
        loginId,
        email,
        name,
        password,
        mustChange: true,
        applicationId: app.id,
      });
      created = true;
    } else {
      await db
        .prepare(
          "UPDATE accounts SET role=?,login_id=?,email=?,name=?,status=?,updated_at=? WHERE id=?",
        )
        .run(role, loginId, email, name, "active", now(), account.id);
      if (account.role !== role) await endAllSessions(account.id);
      if (reset) {
        password = tempPassword();
        await setPassword(account.id, password, { mustChange: true });
        await endAllSessions(account.id);
      }
      account = await q.byId.get(account.id);
    }
    return { account, password, created };
  }
  async function syncPartnerAccount(app) {
    const account = await q.byApplication.get(app.id);
    if (!account) return null;
    const role = roleForApplication(app);
    await db
      .prepare(
        "UPDATE accounts SET role=?,login_id=?,email=?,name=?,updated_at=? WHERE id=?",
      )
      .run(
        role,
        normaliseLoginId(role, app.appId),
        String(app.email || ""),
        String(app.name || ""),
        now(),
        account.id,
      );
    if (account.role !== role) await endAllSessions(account.id);
    return q.byId.get(account.id);
  }
  async function banPartner(applicationId, { until = "", reason = "", actor = "" } = {}) {
    const account = await q.byApplication.get(applicationId);
    if (!account || (account.role !== "vendor" && account.role !== "franchise"))
      return {
        ok: false,
        status: 400,
        error: "This application has no portal login yet, so there is nothing to ban.",
      };
    let untilIso = null;
    if (String(until || "").trim()) {
      const t = Date.parse(until);
      if (!Number.isFinite(t))
        return { ok: false, status: 400, error: "The end of the ban is not a valid date." };
      if (t <= Date.now() + 60_000)
        return { ok: false, status: 400, error: "The ban must end in the future." };
      if (t > Date.now() + 5 * 366 * 86400000)
        return {
          ok: false,
          status: 400,
          error: "A ban can last at most 5 years. Choose \"Until I unban\" instead.",
        };
      untilIso = new Date(t).toISOString();
    }
    const t = now();
    await db
      .prepare(
        "UPDATE accounts SET banned_at=?,banned_until=?,ban_reason=?,banned_by=?,updated_at=? WHERE id=?",
      )
      .run(
        t,
        untilIso,
        String(reason || "").replace(/\s+/g, " ").trim().slice(0, 300),
        String(actor || "").slice(0, 254),
        t,
        account.id,
      );
    await endAllSessions(account.id);
    const saved = await q.byId.get(account.id);
    return { ok: true, account: saved, ban: banInfo(saved) };
  }
  async function unbanPartner(applicationId) {
    const account = await q.byApplication.get(applicationId);
    if (!account)
      return { ok: false, status: 400, error: "This application has no portal login." };
    await db
      .prepare(
        "UPDATE accounts SET banned_at=NULL,banned_until=NULL,ban_reason=NULL,banned_by=NULL,updated_at=? WHERE id=?",
      )
      .run(now(), account.id);
    return { ok: true, account: await q.byId.get(account.id) };
  }
  async function disablePartnerAccount(applicationId) {
    const account = await q.byApplication.get(applicationId);
    if (!account) return null;
    await db
      .prepare("UPDATE accounts SET status=?,updated_at=? WHERE id=?")
      .run("disabled", now(), account.id);
    await endAllSessions(account.id);
    return q.byId.get(account.id);
  }
  async function accountsByApplication() {
    const map = new Map();
    const rows = await db
      .prepare("SELECT * FROM accounts WHERE application_id IS NOT NULL")
      .all();
    for (const a of rows) map.set(a.application_id, publicAccount(a));
    return map;
  }

  return {
    ROLES,
    hashPassword,
    verifyPassword,
    passwordProblem,
    tempPassword,
    normaliseLoginId,
    findForLogin,
    findCandidates,
    createAccount,
    setPassword,
    publicAccount,
    startSession,
    getSession,
    endSession,
    endAllSessions,
    cleanupSessions,
    requireRole,
    ensurePartnerAccount,
    syncPartnerAccount,
    disablePartnerAccount,
    accountsByApplication,
    accountForApplication: (id) => q.byApplication.get(id),
    accountById: (id) => q.byId.get(id),
    accountByLogin: (id) => q.byLogin.get(id),
    findAdminByEmail,
    recentResetCount,
    createPasswordReset,
    consumePasswordReset,
    ensureSuperAdmin,
    isSuperAdmin,
    listAdmins,
    adminByLoginId,
    setAdminStatus,
    updateAdminDetails,
    addAdmin,
    banInfo,
    banPartner,
    unbanPartner,
    RESET_LIMIT_PER_WINDOW,
    RESET_MS,
  };
}