const KEY = "owl_logistics_v1";
// Admin accounts and passwords now live on the server (backend/auth.js); nothing secret is kept in this file.
const seed = {
  riders: [],
  employees: [],
  hubs: [],
  work: [], // Daily Work starts empty; records are added by the admin (or imported) only
  documents: [],
  payments: [],
  partners: [],
  messages: [],
  excelSync: { lastSync: "", fileName: "", rows: 0, records: 0, history: [] },
};
let db =
  JSON.parse(localStorage.getItem(KEY) || "null") || structuredClone(seed);
if (!Array.isArray(db.vendorMembers)) db.vendorMembers = [];
if (!Array.isArray(db.employees)) db.employees = [];
if (!Array.isArray(db.partners)) db.partners = [];
// Admin access is restricted to exactly the four authorized accounts.
// Older versions copied admin passwords into browser storage; remove them.
delete db.users;
try {
  localStorage.removeItem("owl_session");
  localStorage.removeItem("owl_auth_verified");
} catch (e) {}
// Backward-compatible defaults for data created before Excel Payments import.
db.excelSync = db.excelSync || {
  lastSync: "",
  fileName: "",
  rows: 0,
  records: 0,
  history: [],
};
db.payments = Array.isArray(db.payments) ? db.payments : [];
db.weeklyPayments = Array.isArray(db.weeklyPayments) ? db.weeklyPayments : [];
if (!Array.isArray(db.riders)) db.riders = [];
// Hub records now live on the server (see hub-management.js). Keep a copy of any hub data this browser still holds,
// until it has been moved to the server, so nothing is lost. db.hubs is only a copy of what the server returned.
if (
  !localStorage.getItem("owl_hubs_server_v1") &&
  Array.isArray(db.hubs) &&
  db.hubs.length &&
  !localStorage.getItem("owl_hubs_legacy_v1")
)
  localStorage.setItem("owl_hubs_legacy_v1", JSON.stringify(db.hubs));
db.hubs = [];

const save = () =>
  localStorage.setItem(KEY, JSON.stringify({ ...db, hubs: undefined })); // hub records are kept on the server
if (!Array.isArray(db.work)) db.work = [];
// Daily Work: this browser may still hold the old sample rows and records imported from Excel. They are removed once,
// here. Records added after this point are not affected, because this runs only once per browser.
const WORK_CLEARED_KEY = "owl_work_cleared_v2";
if (!localStorage.getItem(WORK_CLEARED_KEY)) {
  db.work = [];
  save();
  localStorage.setItem(WORK_CLEARED_KEY, "1");
}
// Preserve existing rider records on startup; do not clear the Riders list automatically.
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
let currentUser = null;
function toast(m) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = m;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}
function esc(v = "") {
  return String(v).replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
}
function uid(p) {
  return p + "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}
function openModal(html) {
  $("#modal .modal-box")?.classList.remove("modal-wide");
  $("#modalBody").innerHTML = html;
  $("#modal").classList.remove("hidden");
}
function closeModal() {
  $("#modal").classList.add("hidden");
}
window.closeModal = closeModal;
function showAuth() {
  $("#authView").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#authLoginRegister").classList.remove("hidden");
  showSignInForm();
}
function showApp() {
  $("#authView").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userLabel").textContent = currentUser.name + " • Admin";
  render("dashboard");
  if (new URLSearchParams(location.search).has("drive"))
    history.replaceState(null, "", location.pathname);
  startPartnerPolling();
  startSupportAlertPolling();
  loadWeeklyPayments();
  if (typeof initHubs === "function") initHubs().catch(() => {});
  checkPasswordHelpRequests();
}

// ---------- Live Red Alert on Support Sidebar Button ----------
let supportAlertTimer = null;
let knownOpenSupportCount = null;
let supportAlertOpenCount = 0;

function updateSupportNavRedAlert(openCount) {
  supportAlertOpenCount = Number(openCount || 0);
  const btn = document.querySelector('.nav[data-page="support"]');
  if (!btn) return;

  btn.classList.toggle("support-has-alert", supportAlertOpenCount > 0);

  const existingBadges = btn.querySelectorAll(
    ".support-red-alert, .support-red-badge",
  );
  if (supportAlertOpenCount <= 0) {
    existingBadges.forEach((el) => el.remove());
    return;
  }

  let badge = btn.querySelector(".support-red-alert");
  existingBadges.forEach((el) => {
    if (el !== badge) el.remove();
  });

  if (!badge) {
    badge = document.createElement("span");
    badge.className = "support-red-alert";
    btn.appendChild(badge);
  }
  badge.textContent =
    supportAlertOpenCount > 99 ? "99+" : String(supportAlertOpenCount);
  badge.title = `${supportAlertOpenCount} open support ticket${supportAlertOpenCount === 1 ? "" : "s"}`;
}

function showSupportRedPopup(count) {
  const existing = document.getElementById("supportRedPopupBanner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "supportRedPopupBanner";
  banner.setAttribute("role", "alert");
  banner.style.cssText = [
    "position:fixed",
    "top:16px",
    "right:16px",
    "z-index:10000",
    "background:#dc2626",
    "color:#ffffff",
    "padding:12px 16px",
    "border-radius:10px",
    "box-shadow:0 10px 25px rgba(220,38,38,0.4)",
    "font-weight:600",
    "font-size:13.5px",
    "cursor:pointer",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "max-width:380px",
  ].join(";");

  banner.innerHTML =
    `<span>🚨 New Support Ticket Raised (${esc(count)} open) — Click to open Support</span>` +
    `<button type="button" aria-label="Dismiss" style="background:transparent;border:0;color:#fff;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;">✕</button>`;

  banner.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") {
      banner.remove();
      return;
    }
    render("support");
    $("#sidebar")?.classList.remove("open");
    banner.remove();
  });

  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 9000);
}

async function checkSupportTicketsAlert({ notifyOnIncrease = true } = {}) {
  if (!currentUser || currentUser.role !== "admin") return;
  try {
    const base =
      window.OTW_API_BASE ||
      (location.protocol === "file:" || ["5500", "5501"].includes(location.port)
        ? "http://localhost:8080"
        : location.origin);

    const r = await fetch(`${base}/api/admin/support/tickets`, {
      credentials: "include",
      cache: "no-store",
    });
    if (r.status === 401) return sessionEnded();
    if (!r.ok) return;

    const payload = await r.json().catch(() => ({}));
    const list = Array.isArray(payload)
      ? payload
      : payload.tickets || payload.items || payload.rows || [];

    const openCount = list.filter((t) => {
      const st = String(t.status || t.ticketStatus || "open")
        .trim()
        .toLowerCase();
      return st !== "resolved" && st !== "closed";
    }).length;

    updateSupportNavRedAlert(openCount);

    if (
      notifyOnIncrease &&
      knownOpenSupportCount !== null &&
      openCount > knownOpenSupportCount
    ) {
      showSupportRedPopup(openCount);
      toast(`New support ticket raised (${openCount} open)`);
    }
    knownOpenSupportCount = openCount;
  } catch (_) {
    // Ignore transient network errors during background polling
  }
}

function startSupportAlertPolling() {
  stopSupportAlertPolling();
  knownOpenSupportCount = null;
  checkSupportTicketsAlert({ notifyOnIncrease: false });
  supportAlertTimer = setInterval(
    () => checkSupportTicketsAlert({ notifyOnIncrease: true }),
    15000,
  );
}

function stopSupportAlertPolling() {
  if (supportAlertTimer) {
    clearInterval(supportAlertTimer);
    supportAlertTimer = null;
  }
}

function strongPassword(p) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(p);
}
$$(".password-toggle").forEach(
  (b) =>
    (b.onclick = () => {
      const i = document.getElementById(b.dataset.target);
      if (!i) return;
      i.type = i.type === "password" ? "text" : "password";
      b.textContent = i.type === "password" ? "Show" : "Hide";
    }),
);
// ---------- Admin sign-in (checked by the server; sessions use a secure cookie) ----------
const AUTH_API =
  (window.OTW_API_BASE ||
    (location.protocol === "file:" || ["5500", "5501"].includes(location.port)
      ? "http://localhost:8080"
      : location.origin)) + "/api/auth";
async function authCall(path, body, method = "POST") {
  const r = await fetch(AUTH_API + path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body:
      method === "GET"
        ? undefined
        : JSON.stringify({ portal: "admin", ...(body || {}) }),
  });
  let out = {};
  try {
    out = await r.json();
  } catch (e) {}
  return { ok: r.ok, status: r.status, ...out };
}
let pendingCurrentPassword = "";
function setUserFromAccount(a) {
  currentUser = {
    name: a.name || a.email,
    email: a.email || a.loginId,
    role: "admin",
    loginId: a.loginId,
    isSuperAdmin: !!a.isSuperAdmin,
  };
}
function showSetPassword(knownCurrent = "") {
  pendingCurrentPassword = knownCurrent;
  $("#authView").classList.remove("hidden");
  $("#app").classList.add("hidden");
  ["#loginForm", "#forgotForm", "#resetForm"].forEach((id) =>
    $(id)?.classList.add("hidden"),
  );
  $("#setPasswordForm").classList.remove("hidden");
  $("#spCurrentWrap").classList.toggle("hidden", !!knownCurrent);
  $("#spCurrent").required = !knownCurrent;
  $("#spMessage").textContent = "";
  $("#spNew").value = "";
  $("#spConfirm").value = "";
  $("#spCurrent").value = "";
  (knownCurrent ? $("#spNew") : $("#spCurrent")).focus();
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button.primary"),
    password = $("#loginPassword").value;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const out = await authCall("/login", {
      loginId: $("#loginIdentity").value.trim(),
      password,
      remember: $("#remember").checked,
    });
    if (!out.ok) return toast(out.error || "Could not sign in.");
    setUserFromAccount(out.account);
    $("#loginPassword").value = "";
    if (out.account.mustChangePassword) return showSetPassword(password);
    showApp();
  } catch (err) {
    toast(
      "Cannot reach the server. Start it with START-WINDOWS.bat and open http://localhost:8080/dashboard/",
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Login to Admin Panel";
  }
};
$("#setPasswordForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#spMessage"),
    np = $("#spNew").value;
  msg.textContent = "";
  if (np !== $("#spConfirm").value) {
    msg.textContent = "The two new passwords do not match.";
    return;
  }
  const out = await authCall("/change-password", {
    currentPassword: pendingCurrentPassword || $("#spCurrent").value,
    newPassword: np,
  }).catch(() => ({ ok: false, error: "Cannot reach the server." }));
  if (!out.ok) {
    msg.textContent = out.error || "Could not change the password.";
    if (out.status === 401) {
      showAuth();
    }
    return;
  }
  pendingCurrentPassword = "";
  setUserFromAccount(out.account);
  $("#setPasswordForm").classList.add("hidden");
  toast("Password saved");
  showApp();
};
$("#spCancel").onclick = async () => {
  await authCall("/logout").catch(() => {});
  pendingCurrentPassword = "";
  showAuth();
};
$("#logoutBtn").onclick = async () => {
  stopPartnerPolling();
  stopSupportAlertPolling();
  updateSupportNavRedAlert(0);
  await authCall("/logout").catch(() => {});
  currentUser = null;
  showAuth();
};
function sessionEnded() {
  if (!currentUser) return;
  stopPartnerPolling();
  stopSupportAlertPolling();
  updateSupportNavRedAlert(0);
  currentUser = null;
  closeModal();
  showAuth();
  toast("Your session has ended. Please sign in again.");
}
let resetToken = "";
function takeResetLink() {
  const m = location.hash.match(/^#reset=([A-Za-z0-9_-]{20,})$/);
  if (!m) return false;
  resetToken = m[1];
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}
takeResetLink();
window.addEventListener("hashchange", () => {
  if (takeResetLink()) showResetForm();
});
function showSignInForm() {
  ["#setPasswordForm", "#forgotForm", "#resetForm"].forEach((id) =>
    $(id)?.classList.add("hidden"),
  );
  $("#loginForm").classList.remove("hidden");
}
let forgotByEmail = true;
function setForgotMode(byEmail) {
  forgotByEmail = byEmail;
  const hint = $("#forgotForm .hint");
  if (hint)
    hint.textContent = byEmail
      ? "Enter the email registered for your admin account. We will send a reset link to that email."
      : "Reset emails are not available on this server right now. Enter your admin email and your Super Admin will be asked to give you a temporary password.";
  const btn = $("#forgotSubmit");
  if (btn && !btn.disabled)
    btn.textContent = byEmail ? "Send reset link" : "Ask the Super Admin";
}
function showForgotForm() {
  $("#loginForm").classList.add("hidden");
  $("#resetForm").classList.add("hidden");
  $("#forgotForm").classList.remove("hidden");
  $("#forgotEmail").value = $("#loginIdentity").value.trim();
  $("#forgotMessage").textContent = "";
  $("#forgotMessage").className = "form-message";
  $("#forgotEmail").focus();
  authCall("/forgot-password/options", null, "GET")
    .then((out) => {
      if (out && out.ok) setForgotMode(!!out.email);
    })
    .catch(() => {});
}
function showResetForm() {
  $("#authView").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#authLoginRegister").classList.remove("hidden");
  ["#loginForm", "#forgotForm", "#setPasswordForm"].forEach((id) =>
    $(id)?.classList.add("hidden"),
  );
  $("#resetForm").classList.remove("hidden");
  $("#resetMessage").textContent = "";
  $("#resetNew").value = "";
  $("#resetConfirm").value = "";
  $("#resetNew").focus();
}
["#resetNew", "#resetConfirm"].forEach((id) =>
  $(id)?.addEventListener("input", () => ($("#resetMessage").textContent = "")),
);
if ($("#forgotLink")) $("#forgotLink").onclick = showForgotForm;
if ($("#forgotBack")) $("#forgotBack").onclick = showSignInForm;
if ($("#resetCancel"))
  $("#resetCancel").onclick = () => {
    resetToken = "";
    showSignInForm();
  };
let forgotTimer = null;
$("#forgotForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#forgotMessage"),
    btn = $("#forgotSubmit");
  const idle = () => {
    btn.disabled = false;
    btn.textContent = forgotByEmail ? "Send reset link" : "Ask the Super Admin";
  };
  msg.className = "form-message";
  msg.textContent = "";
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const out = await authCall("/forgot-password", {
      email: $("#forgotEmail").value.trim(),
    });
    if (!out.ok) {
      msg.classList.add("error");
      msg.textContent =
        out.error || "Could not send the reset link. Please try again.";
      idle();
      return;
    }
    if (out.mode) setForgotMode(out.mode === "email");
    msg.classList.add("success");
    msg.textContent = out.message;
    let wait = 60;
    btn.textContent = `Wait ${wait}s`;
    clearInterval(forgotTimer);
    forgotTimer = setInterval(() => {
      wait--;
      if (wait <= 0) {
        clearInterval(forgotTimer);
        idle();
      } else btn.textContent = `Wait ${wait}s`;
    }, 1000);
  } catch (err) {
    msg.classList.add("error");
    msg.textContent =
      "Cannot reach the server. Check your connection and try again.";
    idle();
  }
};
$("#resetForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#resetMessage"),
    btn = e.target.querySelector("button.primary");
  msg.textContent = "";
  if ($("#resetNew").value !== $("#resetConfirm").value) {
    msg.textContent = "The two passwords do not match.";
    return;
  }
  if (!resetToken) {
    msg.textContent =
      "This reset link is no longer valid. Request a new one from the sign-in page.";
    return;
  }
  btn.disabled = true;
  try {
    const out = await authCall("/reset-password", {
      token: resetToken,
      newPassword: $("#resetNew").value,
    });
    if (!out.ok) {
      msg.textContent = out.error || "Could not save the new password.";
      return;
    }
    resetToken = "";
    showSignInForm();
    toast("Password saved. Sign in with your new password.");
  } catch (err) {
    msg.textContent =
      "Cannot reach the server. Check your connection and try again.";
  } finally {
    btn.disabled = false;
  }
};
if (resetToken) {
  showResetForm();
} else {
  (async () => {
    try {
      const out = await authCall("/me?portal=admin", null, "GET");
      if (!out.ok) return;
      setUserFromAccount(out.account);
      if (out.account.mustChangePassword) showSetPassword("");
      else showApp();
    } catch (e) {}
  })();
}

if ($("#menuBtn"))
  $("#menuBtn").onclick = () => $("#sidebar")?.classList.toggle("open");
$$(".nav").forEach(
  (n) =>
    (n.onclick = () => {
      render(n.dataset.page);
      $("#sidebar")?.classList.remove("open");
    }),
);

function layout(title, sub, actions = "") {
  return `<div class="page-head"><div class="page-title-brand"><img src="logo.jpg" class="page-logo" alt="On The Way Logistics logo"><div><h2>${title}</h2><p>${sub}</p></div></div><div class="actions">${actions}</div></div>`;
}
function stat(label, value, id = "") {
  return `<div class="stat"><div class="label">${label}</div><div class="value"${id ? ` id="${id}"` : ""}>${value}</div></div>`;
}
let currentPage = "dashboard";
function render(page) {
  currentPage = page;
  const map = {
    dashboard: dashboard,
    employee: employee,
    riders: riders,
    hub: hub,
    support: typeof supportManagement === "function" ? supportManagement : null,
    client: client,
    documents: documents,
    payments: payments,
    whatsapp: whatsapp,
    partners: partners,
    notifications:
      typeof notificationsPage === "function" ? notificationsPage : null,
    reports: reports,
    settings: settings,
  };
  $$(".nav").forEach((n) =>
    n.classList.toggle("active", n.dataset.page === page),
  );
  const viewFn = map[page] || dashboard;
  const contentEl = $("#content");
  if (!contentEl) return;
  try {
    contentEl.innerHTML = viewFn();
  } catch (err) {
    console.error(`Render error on page "${page}":`, err);
    contentEl.innerHTML = `<div class="card"><div class="empty">Could not display ${esc(page)} right now. Try refreshing.</div></div>`;
    return;
  }
  if (page === "dashboard") bindDashboard();
  if (page === "employee") bindEmployee();
  if (page === "riders") bindRiders();
  if (page === "hub") bindHubs();
  if (page === "support" && typeof bindSupport === "function") bindSupport();
  if (page === "client") bindClient();
  if (page === "documents") bindDocuments();
  if (page === "payments") bindPayments();
  if (page === "whatsapp") bindWhatsApp();
  if (page === "partners") bindPartners();
  if (page === "settings") bindSettings();
  if (page === "notifications" && typeof bindNotifications === "function")
    bindNotifications();
  if (page === "reports") bindReports();
  if (typeof updatePartnerNavCount === "function") updatePartnerNavCount();
  if (supportAlertOpenCount > 0)
    updateSupportNavRedAlert(supportAlertOpenCount);
}
window.render = render;

function ensureEmployees() {
  if (!Array.isArray(db.employees)) db.employees = [];
}

function maskSensitive(val, keep = 4) {
  const s = String(val || "").replace(/\s+/g, "");
  if (!s) return "—";
  if (s.length <= keep) return s;
  return "X".repeat(Math.max(4, s.length - keep)) + s.slice(-keep);
}

function employee() {
  ensureEmployees();
  const active = db.employees.filter((e) => (e.status || "Active") === "Active").length;
  const onHold = db.employees.filter((e) => e.status === "On Hold").length;
  const inactive = db.employees.filter((e) => e.status === "Inactive").length;
  const verifiedDocs = db.employees.filter((e) => e.docVerification === "Verified").length;
  return (
    layout(
      "Employees",
      "Employee registration, onboarding form, documents, bank details and HR/Admin approvals.",
      '<button class="primary" id="addEmployeeBtn">+ New Employee Joining Form</button>',
    ) +
    `<div class="cards">
      ${stat("Total Employees", db.employees.length, "empStatTotal")}
      ${stat("Active", active, "empStatActive")}
      ${stat("On Hold / Inactive", onHold + inactive, "empStatInactive")}
      ${stat("Docs Verified", verifiedDocs, "empStatVerified")}
    </div>
    <div class="card">
      <div class="hub-list-toolbar">
        <div><h3>Employee Directory</h3><span class="muted">Sensitive IDs and bank account numbers are masked in routine views.</span></div>
        <select class="status-filter" id="employeeStatusFilter" aria-label="Filter by employee status">
          <option value="">All statuses</option>
          <option value="Active">Active</option>
          <option value="On Hold">On Hold</option>
          <option value="Inactive">Inactive</option>
        </select>
      </div>
      <input class="search" id="employeeSearch" placeholder="Search employee name, ID, designation, department, phone or work location..." autocomplete="off">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Full Name</th>
              <th>Designation / Role</th>
              <th>Department</th>
              <th>Mobile</th>
              <th>Work Location</th>
              <th>Doc Verification</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="employeeRows"></tbody>
        </table>
      </div>
    </div>`
  );
}

function paintEmployees(q = "", statusFilter = "") {
  ensureEmployees();
  const body = $("#employeeRows");
  if (!body) return;
  const term = String(q || "").trim().toLowerCase();
  const st = String(statusFilter || "").trim();
  const list = db.employees.filter((e) => {
    if (st && (e.status || "Active") !== st) return false;
    if (!term) return true;
    return [
      e.id,
      e.name,
      e.fatherOrSpouse,
      e.role,
      e.department,
      e.phone,
      e.email,
      e.workLocation,
      e.reportingManager,
      e.status,
      e.docVerification,
    ]
      .join(" ")
      .toLowerCase()
      .includes(term);
  });

  body.innerHTML = list.length
    ? list
        .map((e) => {
          const empStatus = e.status || "Active";
          const statusCls =
            empStatus === "Active"
              ? "success"
              : empStatus === "On Hold"
                ? "warning"
                : "danger";
          const docVer = e.docVerification || "Pending";
          const docCls =
            docVer === "Verified"
              ? "success"
              : docVer === "Rejected"
                ? "danger"
                : "warning";
          return `<tr>
              <td><b>${esc(e.id)}</b></td>
              <td><b>${esc(e.name)}</b>${e.email ? `<br><small class="muted">${esc(e.email)}</small>` : ""}</td>
              <td>${esc(e.role || "—")}</td>
              <td>${esc(e.department || "—")}</td>
              <td>${esc(e.phone || "—")}</td>
              <td>${esc(e.workLocation || "—")}</td>
              <td><span class="badge ${docCls}">${esc(docVer)}</span></td>
              <td><span class="badge ${statusCls}">${esc(empStatus)}</span></td>
              <td>
                <div class="mini-actions">
                  <button class="btn-sm" onclick="viewEmployee('${esc(e.id)}')">View Form</button>
                  <button class="btn-sm" onclick="editEmployee('${esc(e.id)}')">Edit</button>
                  <button class="btn-sm danger" onclick="deleteEmployee('${esc(e.id)}')">Delete</button>
                </div>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">${term || st ? "No matching employees." : "No employees registered yet. Click + New Employee Joining Form."}</td></tr>`;
}

function bindEmployee() {
  ensureEmployees();
  $("#addEmployeeBtn")?.addEventListener("click", () => employeeModal());
  const searchEl = $("#employeeSearch");
  const statusEl = $("#employeeStatusFilter");
  const refresh = () =>
    paintEmployees(searchEl?.value || "", statusEl?.value || "");
  searchEl?.addEventListener("input", refresh);
  statusEl?.addEventListener("change", refresh);
  refresh();
}

function employeeModal(emp = null) {
  ensureEmployees();
  const editing = !!emp;
  const defaultId =
    emp?.id || "EMP-" + String(db.employees.length + 1).padStart(4, "0");
  const c = emp?.checklist || {};
  const opt = (list, val) =>
    list
      .map(
        (x) =>
          `<option value="${esc(x)}" ${val === x ? "selected" : ""}>${esc(x)}</option>`,
      )
      .join("");

  openModal(`
    <h3>${editing ? "Edit Employee Joining Form" : "Company Employee Joining Form"}</h3>
    <p class="muted">Employee Registration &amp; Onboarding Record</p>
    <form id="employeeForm" class="form-grid">
      <h4 class="span2">1. Personal Details</h4>
      <div class="field"><label>Full Name *</label><input id="empName" required value="${esc(emp?.name || "")}"></div>
      <div class="field"><label>Employee ID *</label><input id="empId" required value="${esc(defaultId)}"></div>
      <div class="field"><label>Father's / Spouse's Name</label><input id="empFatherSpouse" value="${esc(emp?.fatherOrSpouse || "")}"></div>
      <div class="field"><label>Date of Birth</label><input id="empDob" type="date" value="${esc(emp?.dob || "")}"></div>
      <div class="field"><label>Gender</label><select id="empGender">${opt(["", "Male", "Female", "Other", "Prefer not to say"], emp?.gender || "")}</select></div>
      <div class="field"><label>Marital Status (Optional)</label><select id="empMarital">${opt(["", "Single", "Married", "Other"], emp?.maritalStatus || "")}</select></div>
      <div class="field"><label>Aadhaar Number (if required)</label><input id="empAadhaar" inputmode="numeric" maxlength="14" placeholder="12-digit Aadhaar (optional)" value="${esc(emp?.aadhaarNumber || "")}"></div>
      <div class="field"><label>PAN Number</label><input id="empPan" maxlength="10" style="text-transform:uppercase" placeholder="ABCDE1234F" value="${esc(emp?.panNumber || "")}"></div>
      <div class="field"><label>Blood Group (Optional)</label><select id="empBlood">${opt(["", "A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"], emp?.bloodGroup || "")}</select></div>
      <div class="field"><label>Nationality (Optional)</label><input id="empNationality" placeholder="e.g. Indian" value="${esc(emp?.nationality || "Indian")}"></div>

      <h4 class="span2">2. Contact Details</h4>
      <div class="field"><label>Mobile Number *</label><input id="empPhone" inputmode="numeric" maxlength="15" required value="${esc(emp?.phone || "")}"></div>
      <div class="field"><label>Alternative Number</label><input id="empAltPhone" inputmode="numeric" maxlength="15" value="${esc(emp?.altPhone || "")}"></div>
      <div class="field"><label>Email ID</label><input id="empEmail" type="email" value="${esc(emp?.email || "")}"></div>
      <div class="field"><label>Emergency Contact Name</label><input id="empEmergName" value="${esc(emp?.emergencyContactName || "")}"></div>
      <div class="field"><label>Emergency Contact Number</label><input id="empEmergPhone" inputmode="numeric" maxlength="15" value="${esc(emp?.emergencyContactPhone || "")}"></div>
      <div class="field"><label>Relationship</label><input id="empEmergRel" placeholder="e.g. Father, Spouse, Sibling" value="${esc(emp?.emergencyRelationship || "")}"></div>
      <div class="field span2"><label>Current Address</label><textarea id="empCurrAddr" rows="2">${esc(emp?.currentAddress || "")}</textarea></div>
      <div class="field span2"><label>Permanent Address</label><textarea id="empPermAddr" rows="2">${esc(emp?.permanentAddress || "")}</textarea></div>

      <h4 class="span2">3. Employment Details</h4>
      <div class="field"><label>Designation / Job Role *</label><input id="empRole" required placeholder="e.g. Hub Manager, Operations Executive" value="${esc(emp?.role || "")}"></div>
      <div class="field"><label>Department</label><input id="empDept" placeholder="e.g. Operations, Logistics, HR, Accounts" value="${esc(emp?.department || "")}"></div>
      <div class="field"><label>Date of Joining</label><input id="empJoined" type="date" value="${esc(emp?.dateOfJoining || "")}"></div>
      <div class="field"><label>Employment Type</label><select id="empType">${opt(["Full-Time", "Part-Time", "Contract", "Intern", "Probation"], emp?.employmentType || "Full-Time")}</select></div>
      <div class="field"><label>Work Location</label><input id="empWorkLoc" placeholder="e.g. Hyderabad Hub" value="${esc(emp?.workLocation || "")}"></div>
      <div class="field"><label>Reporting Manager</label><input id="empManager" value="${esc(emp?.reportingManager || "")}"></div>
      <div class="field"><label>Previous Employer (if applicable)</label><input id="empPrevEmployer" value="${esc(emp?.previousEmployer || "")}"></div>
      <div class="field"><label>Last Working Date</label><input id="empLastWorkDate" type="date" value="${esc(emp?.lastWorkingDate || "")}"></div>

      <h4 class="span2">4. Bank Details</h4>
      <div class="field"><label>Account Holder Name</label><input id="empBankHolder" value="${esc(emp?.bankHolderName || "")}"></div>
      <div class="field"><label>Bank Name</label><input id="empBankName" value="${esc(emp?.bankName || "")}"></div>
      <div class="field"><label>Account Number</label><input id="empBankAcc" inputmode="numeric" maxlength="24" value="${esc(emp?.bankAccountNumber || "")}"></div>
      <div class="field"><label>IFSC Code</label><input id="empBankIfsc" maxlength="11" style="text-transform:uppercase" value="${esc(emp?.bankIfsc || "")}"></div>
      <div class="field"><label>Branch Name</label><input id="empBankBranch" value="${esc(emp?.bankBranch || "")}"></div>
      <div class="field"><label>Account Type</label><select id="empBankType">${opt(["Savings", "Current", "Salary"], emp?.bankAccountType || "Savings")}</select></div>

      <h4 class="span2">5. Document Checklist</h4>
      <div class="field"><label class="check"><input type="checkbox" id="chkAadhaar" ${c.aadhaar ? "checked" : ""}> Aadhaar Card (if required)</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkPan" ${c.pan ? "checked" : ""}> PAN Card</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkPhoto" ${c.photo ? "checked" : ""}> Passport-Size Photograph</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkResume" ${c.resume ? "checked" : ""}> Updated Resume / CV</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkEdu" ${c.education ? "checked" : ""}> Educational Certificates</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkBank" ${c.bankProof ? "checked" : ""}> Bank Proof / Cancelled Cheque</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkExp" ${c.experienceLetter ? "checked" : ""}> Experience / Relieving Letter (if applicable)</label></div>
      <div class="field"><label class="check"><input type="checkbox" id="chkOffer" ${c.offerLetter ? "checked" : ""}> Signed Offer / Appointment Letter</label></div>

      <h4 class="span2">6. HR / Admin Use Only</h4>
      <div class="field"><label>Document Verification</label><select id="empDocVer">${opt(["Pending", "Verified", "Rejected"], emp?.docVerification || "Pending")}</select></div>
      <div class="field"><label>Background Verification (if applicable)</label><select id="empBgVer">${opt(["Pending", "Clear", "Review Required"], emp?.bgVerification || "Pending")}</select></div>
      <div class="field"><label>HR Approval Name</label><input id="empHrName" value="${esc(emp?.hrApprovalName || "")}"></div>
      <div class="field"><label>HR Approval Date</label><input id="empHrDate" type="date" value="${esc(emp?.hrApprovalDate || "")}"></div>
      <div class="field"><label>Admin Approval Name</label><input id="empAdminName" value="${esc(emp?.adminApprovalName || currentUser?.name || "")}"></div>
      <div class="field"><label>Admin Approval Date</label><input id="empAdminDate" type="date" value="${esc(emp?.adminApprovalDate || "")}"></div>
      <div class="field"><label>Employee Status</label><select id="empStatus">${opt(["Active", "Inactive", "On Hold"], emp?.status || "Active")}</select></div>
      <div class="field"><label>Declaration Date</label><input id="empDeclDate" type="date" value="${esc(emp?.declarationDate || new Date().toISOString().slice(0, 10))}"></div>
      <div class="field span2">
        <label class="check"><input type="checkbox" id="empDeclared" ${!emp || emp.declared !== false ? "checked" : ""}> Employee Declaration: Confirmed that the information and documents provided are true and correct, and agreed to inform the company of any changes to contact or bank details.</label>
      </div>

      <p class="hint span2">Privacy note: Collect only information necessary for employment and applicable legal or payroll requirements. Sensitive numbers are masked in routine views.</p>
      <div class="modal-actions span2">
        <button type="button" class="ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="primary">${editing ? "Save Changes" : "Save Joining Form"}</button>
      </div>
    </form>
  `);
  $("#modal .modal-box")?.classList.add("modal-wide");

  $("#employeeForm").onsubmit = (e) => {
    e.preventDefault();
    const record = {
      id: $("#empId").value.trim(),
      name: $("#empName").value.trim(),
      fatherOrSpouse: $("#empFatherSpouse").value.trim(),
      dob: $("#empDob").value,
      gender: $("#empGender").value,
      maritalStatus: $("#empMarital").value,
      aadhaarNumber: $("#empAadhaar").value.replace(/\D/g, "").slice(0, 12),
      panNumber: $("#empPan").value.trim().toUpperCase(),
      bloodGroup: $("#empBlood").value,
      nationality: $("#empNationality").value.trim(),

      phone: $("#empPhone").value.trim(),
      altPhone: $("#empAltPhone").value.trim(),
      email: $("#empEmail").value.trim(),
      emergencyContactName: $("#empEmergName").value.trim(),
      emergencyContactPhone: $("#empEmergPhone").value.trim(),
      emergencyRelationship: $("#empEmergRel").value.trim(),
      currentAddress: $("#empCurrAddr").value.trim(),
      permanentAddress: $("#empPermAddr").value.trim(),

      role: $("#empRole").value.trim(),
      department: $("#empDept").value.trim(),
      dateOfJoining: $("#empJoined").value,
      employmentType: $("#empType").value,
      workLocation: $("#empWorkLoc").value.trim(),
      reportingManager: $("#empManager").value.trim(),
      previousEmployer: $("#empPrevEmployer").value.trim(),
      lastWorkingDate: $("#empLastWorkDate").value,

      bankHolderName: $("#empBankHolder").value.trim(),
      bankName: $("#empBankName").value.trim(),
      bankAccountNumber: $("#empBankAcc").value.trim(),
      bankIfsc: $("#empBankIfsc").value.trim().toUpperCase(),
      bankBranch: $("#empBankBranch").value.trim(),
      bankAccountType: $("#empBankType").value,

      checklist: {
        aadhaar: $("#chkAadhaar").checked,
        pan: $("#chkPan").checked,
        photo: $("#chkPhoto").checked,
        resume: $("#chkResume").checked,
        education: $("#chkEdu").checked,
        bankProof: $("#chkBank").checked,
        experienceLetter: $("#chkExp").checked,
        offerLetter: $("#chkOffer").checked,
      },

      docVerification: $("#empDocVer").value,
      bgVerification: $("#empBgVer").value,
      hrApprovalName: $("#empHrName").value.trim(),
      hrApprovalDate: $("#empHrDate").value,
      adminApprovalName: $("#empAdminName").value.trim(),
      adminApprovalDate: $("#empAdminDate").value,
      status: $("#empStatus").value,
      declarationDate: $("#empDeclDate").value,
      declared: $("#empDeclared").checked,
      updatedAt: new Date().toISOString(),
    };
    if (!record.id || !record.name)
      return toast("Employee ID and Full Name are required.");
    if (editing) {
      Object.assign(emp, record);
    } else {
      if (
        db.employees.some((x) => x.id.toLowerCase() === record.id.toLowerCase())
      ) {
        return toast("This Employee ID already exists.");
      }
      record.createdAt = new Date().toISOString();
      db.employees.unshift(record);
    }
    save();
    closeModal();
    render("employee");
    toast(editing ? "Employee joining form updated" : "Employee joining form saved");
  };
}

window.viewEmployee = (id) => {
  const e = (db.employees || []).find((x) => x.id === id);
  if (!e) return toast("Employee not found.");
  const c = e.checklist || {};
  const item = (k, v) => `<div><b>${k}</b><p>${esc(v || "—")}</p></div>`;
  const chk = (label, ok) =>
    `<div class="field"><span>${ok ? "☑" : "☐"} ${esc(label)}</span></div>`;

  openModal(`
    <h3>Company Employee Joining Form · ${esc(e.name)} (${esc(e.id)})</h3>
    <p class="muted">Employee Registration &amp; Onboarding Record</p>

    <h4>1. Personal Details</h4>
    <div class="grid2">
      ${item("Full Name", e.name)}
      ${item("Employee ID", e.id)}
      ${item("Father's / Spouse's Name", e.fatherOrSpouse)}
      ${item("Date of Birth", e.dob)}
      ${item("Gender", e.gender)}
      ${item("Marital Status", e.maritalStatus)}
      ${item("Aadhaar Number (Masked)", maskSensitive(e.aadhaarNumber, 4))}
      ${item("PAN Number (Masked)", maskSensitive(e.panNumber, 4))}
      ${item("Blood Group", e.bloodGroup)}
      ${item("Nationality", e.nationality)}
    </div>

    <h4>2. Contact Details</h4>
    <div class="grid2">
      ${item("Mobile Number", e.phone)}
      ${item("Alternative Number", e.altPhone)}
      ${item("Email ID", e.email)}
      ${item("Emergency Contact Name", e.emergencyContactName)}
      ${item("Emergency Contact Number", e.emergencyContactPhone)}
      ${item("Relationship", e.emergencyRelationship)}
      ${item("Current Address", e.currentAddress)}
      ${item("Permanent Address", e.permanentAddress)}
    </div>

    <h4>3. Employment Details</h4>
    <div class="grid2">
      ${item("Designation / Job Role", e.role)}
      ${item("Department", e.department)}
      ${item("Date of Joining", e.dateOfJoining)}
      ${item("Employment Type", e.employmentType)}
      ${item("Work Location", e.workLocation)}
      ${item("Reporting Manager", e.reportingManager)}
      ${item("Previous Employer", e.previousEmployer)}
      ${item("Last Working Date", e.lastWorkingDate)}
    </div>

    <h4>4. Bank Details</h4>
    <div class="grid2">
      ${item("Account Holder Name", e.bankHolderName)}
      ${item("Bank Name", e.bankName)}
      ${item("Account Number (Masked)", maskSensitive(e.bankAccountNumber, 4))}
      ${item("IFSC Code", e.bankIfsc)}
      ${item("Branch Name", e.bankBranch)}
      ${item("Account Type", e.bankAccountType)}
    </div>

    <h4>5. Document Checklist</h4>
    <div class="form-grid">
      ${chk("Aadhaar Card (if required)", c.aadhaar)}
      ${chk("PAN Card", c.pan)}
      ${chk("Passport-Size Photograph", c.photo)}
      ${chk("Updated Resume / CV", c.resume)}
      ${chk("Educational Certificates", c.education)}
      ${chk("Bank Proof / Cancelled Cheque", c.bankProof)}
      ${chk("Experience / Relieving Letter (if applicable)", c.experienceLetter)}
      ${chk("Signed Offer / Appointment Letter", c.offerLetter)}
    </div>

    <h4>6. HR / Admin Use Only</h4>
    <div class="grid2">
      ${item("Document Verification", e.docVerification || "Pending")}
      ${item("Background Verification", e.bgVerification || "Pending")}
      ${item("HR Approval", [e.hrApprovalName, e.hrApprovalDate].filter(Boolean).join(" · "))}
      ${item("Admin Approval", [e.adminApprovalName, e.adminApprovalDate].filter(Boolean).join(" · "))}
      ${item("Employee Status", e.status || "Active")}
      ${item("Declaration Date", e.declarationDate)}
    </div>

    <p class="hint" style="margin-top:10px">Privacy note: Sensitive numbers (Aadhaar, PAN, Bank Account) are masked in routine views.</p>
    <div class="modal-actions">
      <button type="button" class="ghost" onclick="closeModal()">Close</button>
      <button type="button" class="primary" onclick="closeModal();editEmployee('${esc(e.id)}')">Edit Form</button>
    </div>
  `);
  $("#modal .modal-box")?.classList.add("modal-wide");
};

window.editEmployee = (id) => {
  const emp = (db.employees || []).find((x) => x.id === id);
  if (emp) employeeModal(emp);
};

window.deleteEmployee = (id) => {
  if (!confirm("Delete this employee record?")) return;
  db.employees = (db.employees || []).filter((x) => x.id !== id);
  save();
  render("employee");
  toast("Employee deleted");
};

function rrItemsArray() {
  if (typeof rrItems === "undefined") return [];
  if (Array.isArray(rrItems)) return rrItems;
  if (Array.isArray(rrItems?.items)) return rrItems.items;
  return [];
}

function rrPendingCount() {
  return rrItemsArray().filter((r) => r && r.status === "PENDING").length;
}

function dashboard() {
  const active = db.riders.filter((r) => r.status === "Active").length;
  const activeHubs = db.hubs.filter((h) => h.status !== "Inactive").length;
  const totalHubs = db.hubs.length;
  const pendingCount = rrPendingCount();
  const ws = dashboardWeeklyStats();
  const fmtN = (n) => Number(n || 0).toLocaleString("en-IN");
  const rupees = (n) =>
    "₹" +
    Number(n || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const latest = ws.latest;
  const weekSub = latest ? esc(latest.label) : "No Excel payments imported yet";
  const maxBar = Math.max(1, ...ws.series.map((x) => x.total));
  const bars = ws.series.length
    ? ws.series
        .map(
          (x) =>
            `<div class="chart-col" title="${esc(x.label)}: ${fmtN(x.total)} orders"><span style="height:${Math.max(2, Math.round((x.total / maxBar) * 100))}%"></span><small>${esc(x.short)}</small></div>`,
        )
        .join("")
    : `<div class="empty">Import the payment Excel in Payments to see orders per week.</div>`;
  const paidPct = pct(ws.paidAmount, ws.totalAmount);
  return `<div class="dashboard-shell">
  <div class="dashboard-brand-card"><img src="logo.jpg" alt="On The Way Logistics logo" class="dashboard-main-logo"></div>
  <div class="dashboard-title-row"><div><h1>Dashboard</h1><p>Welcome back! Here's your logistics overview.</p></div><button class="refresh-btn" id="dashboardRefresh">↻ Refresh</button></div>
  <div class="dashboard-stats">
    ${dashStat("TOTAL RIDERS", db.riders.length, pendingCount ? `${pendingCount} new waiting for approval (Riders page)` : "Registered riders", "blue")}
    ${dashStat("ACTIVE RIDERS", active, "Currently active", "green")}
    ${dashStat("TOTAL HUBS", totalHubs, "All delivery hubs", "purple")}
    ${dashStat("ACTIVE HUBS", activeHubs, "Operational hubs", "orange")}
    ${dashStat("LATEST WEEK ORDERS", fmtN(latest?.total), weekSub, "blue")}
    ${dashStat("PRIME ORDERS", fmtN(latest?.prime), latest ? pct(latest.prime, latest.total) + "% of the week" : "Latest imported week", "green")}
    ${dashStat("CLUB ORDERS", fmtN(latest?.club), latest ? pct(latest.club, latest.total) + "% of the week" : "Latest imported week", "orange")}
    ${dashStat("PAYMENTS PENDING", rupees(ws.pendingAmount), `${fmtN(ws.pendingCount)} rider-week(s) not yet paid`, "red")}
  </div>
  <div class="dashboard-grid">
    <div class="dashboard-card order-card"><h3>Orders per Week</h3><div class="fake-chart"><div class="chart-bars">${bars}</div></div><p class="muted" style="font-size:12px;margin-top:8px">${ws.series.length ? `Last ${ws.series.length} imported period(s), verified riders only. Source: Payments (Excel).` : ""}</p></div>
    <div class="dashboard-card rider-status-card"><h3>Payment Status</h3><div class="donut-wrap"><div class="donut" style="--p:${paidPct}"><b>${paidPct}%</b><small>Amount paid</small></div><div class="legend"><span><i class="lg green"></i>Total Amount <b>${rupees(ws.totalAmount)}</b></span><span><i class="lg blue"></i>Paid <b>${rupees(ws.paidAmount)}</b></span><span><i class="lg orange"></i>Pending <b>${rupees(ws.pendingAmount)}</b></span><span><i class="lg red"></i>Failed <b>${fmtN(ws.failedCount)}</b></span></div></div></div>
  </div>
  <div class="dashboard-grid dashboard-lower">
    <div class="dashboard-card"><h3>Quick Actions</h3><div class="quick-actions"><button data-go="riders">👤 Manage Riders</button><button data-go="hub">🏢 Manage Hubs</button><button data-go="reports">📊 Reports</button><button data-go="client">🤝 Applications · <b id="dashNewApps">${(db.partners || []).filter(isPendingPartner).length}</b> pending</button></div></div>
    <div class="dashboard-card"><h3>Hub Overview</h3><div class="hub-overview"><div><b>${totalHubs}</b><span>Total Hubs</span></div><div><b>${activeHubs}</b><span>Active Hubs</span></div><div><b>${db.riders.length}</b><span>Total Riders</span></div><div><b>${fmtN(latest?.total)}</b><span>Latest Week Orders</span></div></div></div>
  </div>
  <div class="dashboard-card recent-card"><h3>Recent Riders</h3><div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Name</th><th>Hub</th><th>Phone</th><th>Status</th></tr></thead><tbody>${db.riders
    .slice(0, 8)
    .map(
      (r) =>
        `<tr><td>${esc(r.id)}</td><td><b>${esc(r.name)}</b></td><td>${esc(r.hub || "—")}</td><td>${esc(r.phone)}</td><td><span class="badge ${r.status === "Active" ? "success" : "danger"}">${esc(r.status)}</span></td></tr>`,
    )
    .join("")}</tbody></table></div></div>
</div>`;
}
function dashboardWeeklyStats() {
  if (
    !weeklyStore.loading &&
    (!weeklyStore.loadedAt || Date.now() - weeklyStore.loadedAt > 10000)
  )
    loadWeeklyPayments();
  const n = (v) =>
    Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : 0;
  const rows = (weeklyStore.rows || []).filter(
    (r) =>
      String(r.riderId || "").trim() &&
      r.verificationStatus !== "PENDING_VERIFICATION",
  );
  const totalOf = (r) =>
    r.totalOrders === null ||
    r.totalOrders === undefined ||
    r.totalOrders === ""
      ? n(r.lm) + n(r.primary) + n(r.club)
      : n(r.totalOrders);
  const periods = new Map();
  let totalAmount = 0,
    paidAmount = 0,
    pendingAmount = 0,
    pendingCount = 0,
    failedCount = 0;
  for (const r of rows) {
    const key = r.weekStart
      ? r.weekStart + ".." + (r.weekEnd || "")
      : r.weekKey;
    if (!periods.has(key))
      periods.set(key, {
        key,
        label: r.week || key,
        start: r.weekStart || "",
        total: 0,
        prime: 0,
        club: 0,
      });
    const p = periods.get(key);
    p.total += totalOf(r);
    p.prime += n(r.primary);
    p.club += n(r.club);
    const amt = n(r.amount);
    totalAmount += amt;
    if (r.paymentStatus === "PAID") paidAmount += amt;
    else {
      pendingAmount += amt;
      pendingCount++;
    }
    if (r.paymentStatus === "FAILED") failedCount++;
  }
  const ordered = [...periods.values()].sort(
    (a, b) =>
      String(a.start).localeCompare(String(b.start)) ||
      String(a.key).localeCompare(String(b.key)),
  );
  const short = (iso, label) => {
    const d = iso ? new Date(iso + "T12:00:00") : null;
    return d && !isNaN(d)
      ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
      : String(label || "").slice(0, 10);
  };
  return {
    latest: ordered.length ? ordered[ordered.length - 1] : null,
    series: ordered
      .slice(-7)
      .map((p) => ({ ...p, short: short(p.start, p.label) })),
    totalAmount,
    paidAmount,
    pendingAmount,
    pendingCount,
    failedCount,
  };
}
function dashIcon(label) {
  const icons = {
    "TOTAL RIDERS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="9" r="2.5"></circle><path d="M3.5 19c.4-3.3 2.2-5 5.5-5s5.1 1.7 5.5 5"></path><path d="M14.5 14.5c2.9-.2 5 1.3 5.5 4.5"></path></svg>',
    "ACTIVE RIDERS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2"></circle><path d="M5 20c.6-4 2.9-6 7-6s6.4 2 7 6"></path><path d="m17 5 1.3 1.3L21 3.6"></path></svg>',
    "TOTAL HUBS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V9l8-5 8 5v11"></path><path d="M8 20v-6h8v6M9 9h.01M12 9h.01M15 9h.01"></path></svg>',
    "ACTIVE HUBS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V9l8-5 8 5v11"></path><path d="M8 20v-6h8v6"></path><path d="m8.5 10.5 2 2 5-5"></path></svg>',
    "LATEST WEEK ORDERS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"></path><circle cx="7" cy="19" r="2"></circle><circle cx="18" cy="19" r="2"></circle><path d="M14 14h7"></path></svg>',
    "PRIME ORDERS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.7 2.7L16.5 9"></path></svg>',
    "CLUB ORDERS":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
    "PAYMENTS PENDING":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 17H3L12 3z"></path><path d="M12 9v5M12 17h.01"></path></svg>',
  };
  return (
    icons[label] ||
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle></svg>'
  );
}
function dashStat(label, value, sub, tone) {
  return `<div class="dash-stat ${tone}"><div class="dash-stat-icon">${dashIcon(label)}</div><div class="dash-label">${label}</div><div class="dash-value">${value}</div><div class="dash-sub">${sub}</div></div>`;
}
function bindDashboard() {
  $$("[data-go]").forEach((b) => (b.onclick = () => render(b.dataset.go)));
  $("#dashboardRefresh")?.addEventListener("click", async () => {
    syncPartnerApplications();
    await Promise.all([
      loadWeeklyPayments(),
      typeof rrLoad === "function"
        ? rrLoad({ quiet: true })
        : Promise.resolve(),
      typeof loadHubs === "function"
        ? loadHubs({ quiet: true })
        : Promise.resolve(true),
      checkSupportTicketsAlert({ notifyOnIncrease: false }),
    ]);
    if (currentPage === "dashboard") render("dashboard");
    toast("Dashboard refreshed");
  });
}
const RIDER_PAGE_SIZES = [10, 25, 50, 100];
const riderView = { page: 1, size: 10, q: "" };
function riderMatches(r, q) {
  return (
    !q ||
    [r.name, r.id, r.phone].some((v) =>
      String(v || "")
        .toLowerCase()
        .includes(q),
    )
  );
}
function riderFilteredList() {
  const q = String(riderView.q || "")
    .trim()
    .toLowerCase();
  return db.riders.filter((r) => riderMatches(r, q));
}
function riderPageInfo(list) {
  const total = list.length,
    pages = Math.max(1, Math.ceil(total / riderView.size));
  riderView.page = Math.min(Math.max(1, riderView.page || 1), pages);
  const start = total ? (riderView.page - 1) * riderView.size : 0;
  const end = Math.min(start + riderView.size, total);
  return { total, pages, start, end, page: riderView.page };
}
function riders() {
  return (
    layout(
      "Riders",
      "View and manage delivery riders.",
      '<button class="btn primary" id="addRiderMember">+ Add New Member</button>',
    ) +
    `<div class="card hidden" id="riderPendingCard"></div>` +
    `<div class="card"><input class="search" id="riderSearch" value="${esc(riderView.q)}" placeholder="Search rider name, ID or phone..."><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Rider ID</th><th>Phone</th><th>Location</th><th>Hub</th><th>Status</th><th>Actions</th></tr></thead><tbody id="riderRows"></tbody></table></div><div id="riderPager"></div></div>`
  );
}
function riderAddedBy(r) {
  if (!r.registrationId || !r.appliedBy) return "";
  const who = [r.appliedBy, r.ownerLoginId, r.ownerName]
    .filter(Boolean)
    .join(" · ");
  return `<br><small class="muted">Added by ${esc(who)}</small>`;
}
function riderRowHtml(r) {
  return `<tr><td><b>${esc(r.name)}</b>${riderAddedBy(r)}</td><td>${esc(r.id)}</td><td>${esc(r.phone)}</td><td>${esc(r.location)}</td><td>${esc(r.hub || "—")}</td><td><span class="badge ${r.status === "Active" ? "success" : "danger"}">${r.status}</span></td><td><div class="mini-actions"><button class="btn-sm" onclick="editRider('${r.id}')">Edit</button><button class="btn-sm" onclick="viewRider('${r.id}')">View</button><button class="btn-sm danger" onclick="deleteRider('${r.id}')">Delete</button></div></td></tr>`;
}
function riderPagerHtml(info) {
  const sizeOpts = RIDER_PAGE_SIZES.map(
    (n) =>
      `<option value="${n}" ${n === riderView.size ? "selected" : ""}>${n}</option>`,
  ).join("");
  return `<nav class="rider-pagination" aria-label="Rider table pages"><div class="rider-pagination-info"><span id="riderInfo">Showing ${info.total ? info.start + 1 : 0}–${info.end} of ${info.total} riders</span><label class="rider-size">Records per page <select id="riderPageSize">${sizeOpts}</select></label></div><div class="rider-pagination-actions"><button type="button" class="btn-sm rider-page-btn" id="riderFirst" ${info.page <= 1 ? "disabled" : ""}>First</button><button type="button" class="btn-sm rider-page-btn" id="riderPrev" ${info.page <= 1 ? "disabled" : ""}>Previous</button><span class="rider-page-indicator" id="riderPageLabel" aria-live="polite">Page ${info.page} of ${info.pages}</span><button type="button" class="btn-sm primary rider-page-btn" id="riderNext" ${info.page >= info.pages ? "disabled" : ""}>Next</button><button type="button" class="btn-sm primary rider-page-btn" id="riderLast" ${info.page >= info.pages ? "disabled" : ""}>Last</button></div></nav>`;
}
function paintRiders() {
  const body = $("#riderRows");
  if (!body) return;
  const list = riderFilteredList();
  const info = riderPageInfo(list);
  const slice = list.slice(info.start, info.start + riderView.size);
  body.innerHTML = slice.length
    ? slice.map(riderRowHtml).join("")
    : `<tr><td colspan="7" class="empty">${String(riderView.q || "").trim() ? "No matching riders." : "No riders found."}</td></tr>`;
  const pager = $("#riderPager");
  if (pager) pager.innerHTML = riderPagerHtml(info);
  const go = (p) => {
    riderView.page = p;
    paintRiders();
  };
  $("#riderFirst")?.addEventListener("click", () => go(1));
  $("#riderPrev")?.addEventListener("click", () => go(info.page - 1));
  $("#riderNext")?.addEventListener("click", () => go(info.page + 1));
  $("#riderLast")?.addEventListener("click", () => go(info.pages));
  $("#riderPageSize")?.addEventListener("change", (e) => {
    riderView.size = Number(e.target.value) || 10;
    riderView.page = 1;
    paintRiders();
  });
}
function bindRiders() {
  const addMember = $("#addRiderMember");
  if (addMember) addMember.onclick = () => rrOpenForm();
  const search = $("#riderSearch");
  if (search)
    search.oninput = (e) => {
      riderView.q = e.target.value;
      riderView.page = 1;
      paintRiders();
    };
  $("#riderPendingCard")?.addEventListener("click", rrTableClick);
  paintPendingRiders();
  paintRiders();
  syncRiderMasterDirectory();
}
function paintPendingRiders() {
  const card = $("#riderPendingCard");
  if (!card) return;
  const list = rrItemsArray()
    .filter((r) => r && r.status === "PENDING")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  card.classList.toggle("hidden", !list.length);
  if (!list.length) return (card.innerHTML = "");
  const fromPartners = list.filter((r) => r.ownerLoginId).length;
  card.innerHTML = `<div class="section-head"><div><h3>⏳ Waiting for approval (${list.length})</h3><p class="muted">${fromPartners ? `${fromPartners} added by Vendors / Franchises. ` : ""}Approve a rider to move them into the Riders list below; Reject needs a reason.</p></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Rider ID</th><th>Rider Name</th><th>Mobile Number</th><th>Hub Pincode</th><th>Hub Location</th><th>Selfie</th><th>Aadhaar</th><th>Added By</th><th>Added On</th><th>Status</th><th>Action</th></tr></thead><tbody>${list.map(rrRow).join("")}</tbody></table></div>`;
}
function updateRiderNavCount() {
  const n = rrPendingCount();
  const btn = document.querySelector('.nav[data-page="riders"]');
  if (!btn) return;
  let b = btn.querySelector(".nav-count");
  if (!n) return b?.remove();
  if (!b) {
    b = document.createElement("span");
    b.className = "nav-count";
    btn.appendChild(b);
  }
  b.textContent = n;
  b.title = `${n} rider${n === 1 ? "" : "s"} waiting for approval`;
}
function normRiderMasterName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
async function syncRiderMasterDirectory() {
  if (window.__riderMasterSyncRunning) return;
  window.__riderMasterSyncRunning = true;
  let localChanged = 0,
    remoteChanged = 0;
  try {
    const masterResponse = await rrCall(
      PARTNER_API_BASE + "/api/rider-master-directory?portal=admin",
    );
    const RIDER_MASTER_DIRECTORY = masterResponse.items || [];
    const matched = [];
    for (const master of RIDER_MASTER_DIRECTORY) {
      const key = normRiderMasterName(master.name);
      const rows = db.riders.filter((r) => normRiderMasterName(r.name) === key);
      if (rows.length !== 1) continue;
      const rider = rows[0];
      if (
        db.riders.some(
          (other) => other !== rider && String(other.id) === String(master.id),
        )
      )
        continue;
      if (String(rider.id) !== master.id) {
        rider.id = master.id;
        localChanged++;
      }
      if (master.phone && String(rider.phone || "") !== master.phone) {
        rider.phone = master.phone;
        localChanged++;
      }
      matched.push(master);
      for (const list of [db.work, db.payments, db.weeklyPayments])
        if (Array.isArray(list))
          for (const item of list) {
            const nm = normRiderMasterName(
              item.riderName || item.rider || item.name || "",
            );
            if (nm === key) {
              if ("riderId" in item) item.riderId = master.id;
              if ("rider_id" in item) item.rider_id = master.id;
            }
          }
    }
    if (localChanged) {
      save();
      render("riders");
    }
    try {
      const registrationResponse = await rrCall(rrApiUrl());
      rrItems = rrExtractList(registrationResponse);
      for (const master of matched) {
        const regMatches = rrItemsArray().filter(
          (x) =>
            normRiderMasterName(x.riderName) ===
            normRiderMasterName(master.name),
        );
        if (regMatches.length !== 1) continue;
        const reg = regMatches[0];
        const nextPhone = master.phone || reg.mobileNumber;
        if (reg.riderId === master.id && reg.mobileNumber === nextPhone)
          continue;
        const fd = new FormData();
        fd.append("riderId", master.id);
        fd.append("riderName", reg.riderName);
        fd.append("mobile", nextPhone);
        fd.append("hubPincode", reg.hubPincode);
        fd.append("hubLocation", reg.hubLocation);
        const out = await rrCall(rrApiUrl("/" + encodeURIComponent(reg.id)), {
          method: "PUT",
          body: fd,
        });
        const updatedReg = rrExtractItem(out);
        if (updatedReg)
          rrItems = rrItemsArray().map((x) =>
            x.id === reg.id ? updatedReg : x,
          );
        remoteChanged++;
      }
    } catch (e) {
      /* retry remote sync next time the Riders page is opened */
    }
    if (localChanged || remoteChanged)
      toast(
        `Rider master updated: ${localChanged} local field(s), ${remoteChanged} registration(s).`,
      );
  } finally {
    window.__riderMasterSyncRunning = false;
  }
}
function riderEditModal(r, reg = null) {
  const existingSelfie = reg
    ? `<div class="hint">Current selfie: ${esc(reg.selfie?.name || "Saved securely")} · <button type="button" class="btn-sm" onclick="rrOpenDocument('${reg.id}','selfie','Rider selfie')">View</button></div>`
    : "";
  const existingAadhaar = reg
    ? `<div class="hint">Current Aadhaar: ${esc(reg.aadhaar?.name || "Saved securely")} · <button type="button" class="btn-sm" onclick="rrOpenDocument('${reg.id}','aadhaar','Aadhaar card')">Preview</button></div>`
    : "";
  openModal(`<h3>Edit Rider Details</h3>
 <p class="muted">Update the rider profile. Existing payment history is preserved. Upload new documents only when replacing the saved files.</p>
 <form id="riderEditForm" class="form-grid" novalidate>
  <div class="field"><label for="editRiderId">Rider ID *</label><input id="editRiderId" maxlength="40" required value="${esc(reg?.riderId || r.id || "")}"></div>
  <div class="field"><label for="editRiderName">Rider Name *</label><input id="editRiderName" maxlength="100" required value="${esc(reg?.riderName || r.name || "")}"></div>
  <div class="field"><label for="editRiderPhone">Mobile Number *</label><input id="editRiderPhone" inputmode="numeric" maxlength="10" required value="${esc(reg?.mobileNumber || r.phone || "")}" placeholder="10-digit mobile number"></div>
  <div class="field"><label for="editRiderPin">Hub Pincode *</label><input id="editRiderPin" inputmode="numeric" maxlength="6" required value="${esc(reg?.hubPincode || r.hubPincode || "")}" placeholder="6-digit pincode"></div>
  <div class="field span2"><label for="editRiderHub">Hub Location *</label><input id="editRiderHub" maxlength="120" required value="${esc(reg?.hubLocation || r.location || r.hub || "")}"></div>
  <div class="field span2"><label for="editRiderSelfie">Rider Selfie / Screenshot ${reg ? "(optional replacement)" : "*"}</label>${existingSelfie}<input id="editRiderSelfie" type="file" accept="image/jpeg,image/png,image/webp" ${reg ? "" : "required"}><small class="hint">JPG, PNG or WEBP image, up to 5 MB.</small></div>
  <div class="field span2"><label for="editRiderAadhaar">Aadhaar Card ${reg ? "(optional replacement)" : "*"}</label>${existingAadhaar}<input id="editRiderAadhaar" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" ${reg ? "" : "required"}><small class="hint">JPG, PNG, WEBP or PDF, up to 5 MB. A masked Aadhaar is recommended.</small></div>
  <p id="editRiderError" class="form-message error span2" role="alert"></p>
  <div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary" id="editRiderSave">Save Changes</button></div>
 </form>`);
  const phone = $("#editRiderPhone");
  phone.oninput = () =>
    (phone.value = phone.value.replace(/\D/g, "").slice(0, 10));
  const pin = $("#editRiderPin");
  pin.oninput = () => (pin.value = pin.value.replace(/\D/g, "").slice(0, 6));
  $("#riderEditForm").onsubmit = async (e) => {
    e.preventDefault();
    const v = {
      id: $("#editRiderId").value.trim(),
      name: $("#editRiderName").value.replace(/\s+/g, " ").trim(),
      mobile: $("#editRiderPhone").value.trim(),
      pin: $("#editRiderPin").value.trim(),
      hub: $("#editRiderHub").value.replace(/\s+/g, " ").trim(),
    };
    const fail = (m) => {
      $("#editRiderError").textContent = m;
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{1,39}$/.test(v.id))
      return fail(
        "Enter a valid Rider ID (2–40 letters, numbers, dashes or slashes).",
      );
    if (!v.name || /\d/.test(v.name)) return fail("Enter a valid rider name.");
    if (!/^[6-9]\d{9}$/.test(v.mobile))
      return fail("Enter a valid 10-digit mobile number.");
    if (!/^[1-9]\d{5}$/.test(v.pin))
      return fail("Enter a valid 6-digit hub pincode.");
    if (v.hub.length < 2) return fail("Enter the hub location.");
    const duplicate = db.riders.find(
      (x) => x !== r && String(x.id).toLowerCase() === v.id.toLowerCase(),
    );
    if (duplicate)
      return fail("This Rider ID is already assigned to another rider.");
    const selfie = $("#editRiderSelfie").files[0],
      aadhaar = $("#editRiderAadhaar").files[0];
    if (!reg && (!selfie || !aadhaar))
      return fail("Upload both the rider selfie and Aadhaar card.");
    const btn = $("#editRiderSave");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const fd = new FormData();
      fd.append("riderId", v.id);
      fd.append("riderName", v.name);
      fd.append("mobile", v.mobile);
      fd.append("hubPincode", v.pin);
      fd.append("hubLocation", v.hub);
      if (selfie) fd.append("selfie", selfie, selfie.name);
      if (aadhaar) fd.append("aadhaar", aadhaar, aadhaar.name);
      let savedRegistration = null;
      if (reg) {
        const out = await rrCall(rrApiUrl("/" + encodeURIComponent(reg.id)), {
          method: "PUT",
          body: fd,
        });
        savedRegistration = rrExtractItem(out);
      } else {
        const created = await rrCall(rrApiUrl(), { method: "POST", body: fd });
        const createdItem = rrExtractItem(created);
        const approved = await rrCall(
          rrApiUrl("/" + encodeURIComponent(createdItem.id) + "/status"),
          {
            method: "POST",
            body: {
              status: "APPROVED",
              remarks: "Admin verified and updated active rider profile.",
            },
          },
        );
        savedRegistration = rrExtractItem(approved);
      }
      if (savedRegistration)
        rrItems = [
          savedRegistration,
          ...rrItemsArray().filter((x) => x.id !== savedRegistration.id),
        ];
      const oldName = r.name;
      Object.assign(r, {
        id: v.id,
        name: v.name,
        phone: v.mobile,
        location: v.hub,
        hub: v.hub,
        hubPincode: v.pin,
        provisional: false,
      });
      const matchesName = (x) =>
        normRiderMasterName(x?.riderName || x?.rider || x?.name || "") ===
        normRiderMasterName(oldName);
      for (const collection of [db.work, db.payments, db.weeklyPayments]) {
        if (!Array.isArray(collection)) continue;
        for (const item of collection) {
          if (matchesName(item)) {
            if ("riderId" in item) item.riderId = v.id;
            if ("rider_id" in item) item.rider_id = v.id;
            if ("rider" in item && item.rider === oldName) item.rider = v.name;
            if ("riderName" in item) item.riderName = v.name;
          }
        }
      }
      save();
      closeModal();
      render("riders");
      toast(`Rider ${v.name} updated. Payment history preserved.`);
    } catch (err) {
      fail(err.message || "Could not save rider details.");
      btn.disabled = false;
      btn.textContent = "Save Changes";
      toast("Rider update failed: " + (err.message || "Please try again."));
    }
  };
}
window.editRider = async (id) => {
  const r = db.riders.find((x) => String(x.id) === String(id));
  if (!r) return toast("Rider not found.");
  try {
    if (typeof rrLoad === "function") await rrLoad({ quiet: true });
  } catch (e) {}
  const byName = normRiderMasterName(r.name);
  const reg = rrItemsArray().find(
    (x) =>
      normRiderMasterName(x.riderName) === byName ||
      String(x.riderId) === String(r.id),
  );
  riderEditModal(r, reg || null);
};
window.deleteRider = (id) => {
  const r = db.riders.find((x) => x.id === id);
  const registered = r && r.registrationId;
  const question = registered
    ? "This rider is an approved Rider Registration. Removing them here only hides them from this list in this browser. To remove them for every admin, ban or manage the application in Client > Client Members.\n\nHide this rider here?"
    : "Delete this rider?";
  if (confirm(question)) {
    if (registered) {
      if (!Array.isArray(db.hiddenRegistrations)) db.hiddenRegistrations = [];
      db.hiddenRegistrations.push(r.registrationId);
    }
    db.riders = db.riders.filter((x) => x.id !== id);
    save();
    render("riders");
  }
};
function normalizeRiderLinkId(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
}
window.viewRider = async (id) => {
  const r = db.riders.find(
    (x) => normalizeRiderLinkId(x.id) === normalizeRiderLinkId(id),
  );
  if (!r) return toast("Rider not found.");
  const riderKey = normalizeRiderLinkId(r.id);
  let registration = null,
    weekly = [];
  try {
    await Promise.all([
      typeof rrLoad === "function"
        ? rrLoad({ quiet: true })
        : Promise.resolve(),
      loadAdminDocs(),
    ]);
    registration =
      rrItemsArray().find(
        (x) => normalizeRiderLinkId(x.riderId) === riderKey,
      ) || null;
  } catch (e) {}
  try {
    const out = await weeklyRequest("?q=" + encodeURIComponent(r.id));
    weekly = (out.records || []).filter(
      (x) => normalizeRiderLinkId(x.riderId) === riderKey,
    );
  } catch (e) {
    weekly = weeklyStore.rows.filter(
      (x) => normalizeRiderLinkId(x.riderId) === riderKey,
    );
  }
  const daily = (db.payments || [])
    .filter((x) => normalizeRiderLinkId(x.riderId) === riderKey)
    .sort((a, b) =>
      String(b.isoDate || b.date || "").localeCompare(
        String(a.isoDate || a.date || ""),
      ),
    );
  const docs = docsOfRider(r);
  const total = weekly.reduce((n, x) => n + Number(x.amount || 0), 0),
    dailyTotal = daily.reduce((n, x) => n + Number(x.amount || 0), 0);
  const badgeHtml =
    typeof rrStatusBadge === "function"
      ? rrStatusBadge(registration?.status)
      : esc(registration?.status || "");
  const docLinks = registration
    ? `<div class="rr-doc-buttons"><button type="button" class="btn-sm" id="profileSelfie">View rider selfie / screenshot</button><button type="button" class="btn-sm" id="profileAadhaar">Preview Aadhaar</button></div><p class="hint">Registration status: ${badgeHtml} · Secure documents are available to signed-in admins.</p>`
    : '<p class="hint">No secure registration documents are linked to this Rider ID yet.</p>';
  const weeklyRows =
    weekly
      .map(
        (x) =>
          `<tr><td>${esc(x.week || weeklyWeekText(x) || "—")}</td><td>${weeklyNum(x.days)}</td><td>${weeklyNum(x.totalOrders)}</td><td>${weeklyAmt(x.amount)}</td><td>${esc(x.verificationStatus || "VERIFIED")}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="empty">No weekly payment records linked to this Rider ID.</td></tr>';
  const dailyRows =
    daily
      .map(
        (x) =>
          `<tr><td>${esc(x.date || x.isoDate || "—")}</td><td>${esc(x.week || "—")}</td><td>${weeklyAmt(x.amount)}</td><td>${esc(x.status || "—")}</td><td>${esc(x.source || "—")}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="empty">No daily payment records linked to this Rider ID.</td></tr>';
  const localDocs =
    docs
      .map(
        (x) =>
          `<tr><td>${esc(x.type || "Document")}</td><td>${esc(x.file || "—")}</td><td>${esc(x.date || "—")}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="3" class="empty">No additional Documents-module uploads linked to this Rider ID.</td></tr>';
  openModal(`<h3>${esc(r.name)} · ${esc(r.id)}</h3>
  <div class="grid2"><div><b>Rider ID</b><p>${esc(r.id)}</p></div><div><b>Rider Name</b><p>${esc(r.name)}</p></div><div><b>Mobile Number</b><p>${esc(r.phone || registration?.mobileNumber || "—")}</p></div><div><b>Hub Location</b><p>${esc(r.location || r.hub || registration?.hubLocation || "—")}</p></div><div><b>Hub Pincode</b><p>${esc(registration?.hubPincode || r.hubPincode || "—")}</p></div><div><b>Status</b><p>${esc(r.status || registration?.status || "—")}</p></div></div>
  <h4>Rider Documents · Rider ID ${esc(r.id)}</h4>${docLinks}
  <div class="table-wrap"><table class="table"><thead><tr><th>Other document</th><th>File</th><th>Date</th></tr></thead><tbody>${localDocs}</tbody></table></div>
  <h4>Weekly Payment History</h4><p class="muted">${weekly.length} records · Total ₹${total.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
  <div class="table-wrap"><table class="table"><thead><tr><th>Week</th><th>Days</th><th>Orders</th><th>Amount</th><th>Link status</th></tr></thead><tbody>${weeklyRows}</tbody></table></div>
  <h4>Daily Payment History</h4><p class="muted">${daily.length} records · Total ₹${dailyTotal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
  <div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Week</th><th>Amount</th><th>Status</th><th>Source</th></tr></thead><tbody>${dailyRows}</tbody></table></div>
  <div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Close</button><button type="button" class="primary" id="profileGoDocuments">Open Documents</button><button type="button" class="primary" id="profileGoPayments">Open Payments</button></div>`);
  if (registration) {
    $("#profileSelfie")?.addEventListener("click", () =>
      rrOpenDocument(registration.id, "selfie", `Selfie · ${r.name} (${r.id})`),
    );
    $("#profileAadhaar")?.addEventListener("click", () =>
      rrOpenDocument(
        registration.id,
        "aadhaar",
        `Aadhaar · ${r.name} (${r.id})`,
      ),
    );
  }
  $("#profileGoDocuments")?.addEventListener("click", () => {
    docSearch.query = r.id;
    closeModal();
    render("documents");
  });
  $("#profileGoPayments")?.addEventListener("click", () => {
    weeklyStore.query = r.id;
    weeklyStore.page = 1;
    closeModal();
    render("payments");
  });
};
const docSearch = { query: "" };
let adminDocs = [],
  adminDocsLoaded = false;
async function loadAdminDocs() {
  try {
    const r = await fetch(PARTNER_API_BASE + "/api/admin/rider-documents", {
      credentials: "include",
    });
    if (r.status === 401) return sessionEnded();
    const out = await r.json().catch(() => ({}));
    if (!r.ok)
      throw new Error(out.error || "Request failed (" + r.status + ")");
    adminDocs = Array.isArray(out.items) ? out.items : [];
    adminDocsLoaded = true;
  } catch (e) {
    toast("Could not load rider documents: " + e.message);
  }
}
function docsOfRider(r) {
  const key = normalizeRiderLinkId(r.id);
  const docsList = Array.isArray(adminDocs) ? adminDocs : [];
  const server = docsList
    .filter((d) => d && normalizeRiderLinkId(d.riderId) === key)
    .map((d) => ({
      id: d.id,
      type: d.type,
      file: d.name,
      date: d.createdAt
        ? new Date(d.createdAt).toLocaleDateString("en-IN")
        : "",
      server: true,
    }));
  const legacy = (db.documents || [])
    .filter((d) => (d.riderId ? d.riderId === r.id : d.rider === r.name))
    .map((d) => ({ ...d, legacy: true }));
  return [...server, ...legacy];
}
function docRowHtml(d) {
  if (d.server)
    return `<div class="uploaded-doc"><span><b>${esc(d.type)}</b> • ${esc(d.file)}</span><span><small>${esc(d.date)}</small> <button class="btn-sm" onclick="viewDoc('${esc(d.id)}')">View</button> <button class="btn-sm danger" onclick="deleteDoc('${esc(d.id)}')">Delete</button></span></div>`;
  return `<div class="uploaded-doc legacy-doc"><span><b>${esc(d.type)}</b> • ${esc(d.file)} <small class="muted">(file not stored by the older version; please upload it again)</small></span><span><small>${esc(d.date)}</small> <button class="btn-sm danger" onclick="deleteDoc('${esc(d.id)}')">Remove</button></span></div>`;
}
function docTypeAliases(type) {
  const t = String(type || "").toLowerCase();
  const out = [];
  if (t.includes("aadhaar") || t.includes("aadhar"))
    out.push("aadhaar", "aadhar", "aadhaar card", "id proof");
  if (t === "pan" || t.includes("pan"))
    out.push("pan card", "permanent account number");
  if (t.includes("driving") || t.includes("licen"))
    out.push("driving license", "driving licence", "dl");
  if (t === "rc" || t.includes("rc"))
    out.push("rc book", "registration certificate", "vehicle registration");
  if (t.includes("bank") || t.includes("passbook"))
    out.push("passbook", "bank passbook", "bank account");
  if (t.includes("insurance"))
    out.push("insurance", "insurance document", "policy");
  if (t.includes("other")) out.push("other documents", "other");
  return out;
}
function docMatches(d, raw, q) {
  const hay = [d.type, ...docTypeAliases(d.type), d.file, d.date]
    .map((v) => String(v ?? ""))
    .join(" | ")
    .toLowerCase();
  return hay.includes(raw) || (q && normText(hay).includes(q));
}
function docRiderMatches(r, raw, q) {
  const hay = [r.name, r.id]
    .map((v) => String(v ?? ""))
    .join(" | ")
    .toLowerCase();
  return hay.includes(raw) || (q && normText(hay).includes(q));
}
function documentSections() {
  const raw = String(docSearch.query || "")
    .trim()
    .toLowerCase();
  const ridersList = Array.isArray(db.riders) ? db.riders : [];
  if (!raw) return ridersList.map((r) => ({ r, docs: docsOfRider(r) }));
  const q = normText(raw),
    out = [];
  ridersList.forEach((r) => {
    const all = docsOfRider(r);
    if (docRiderMatches(r, raw, q)) out.push({ r, docs: all });
    else {
      const hit = all.filter((d) => docMatches(d, raw, q));
      if (hit.length) out.push({ r, docs: hit });
    }
  });
  return out;
}
function documentsListHtml() {
  const secs = documentSections();
  const regs = rrItemsArray();
  if (!secs.length)
    return `<div class="empty" style="padding:18px 0">${String(docSearch.query || "").trim() ? "No matching riders or documents found" : "No riders yet."}</div>`;
  return secs
    .map(({ r, docs }) => {
      const reg = regs.find(
        (x) =>
          x && normalizeRiderLinkId(x.riderId) === normalizeRiderLinkId(r.id),
      );
      const extra = reg
        ? `<div class="uploaded-doc"><span><b>Rider Selfie / Screenshot</b> • ${esc(reg.selfie?.name || "Secure file")}</span><button class="btn-sm" data-reg-doc="selfie" data-reg-id="${esc(reg.id)}" data-reg-name="${esc(r.name)}">View</button></div><div class="uploaded-doc"><span><b>Aadhaar Card</b> • ${esc(reg.aadhaar?.name || "Secure file")}</span><button class="btn-sm" data-reg-doc="aadhaar" data-reg-id="${esc(reg.id)}" data-reg-name="${esc(r.name)}">Preview</button></div>`
        : "";
      return `<div class="document-rider"><div class="document-rider-head"><div><span class="document-rider-name">${esc(r.name)}</span><span class="document-id">${esc(r.id)}</span></div><button class="upload-btn" onclick="uploadRiderDoc('${r.id}')">+ Upload</button></div><div class="document-rider-body">${docs.length ? docs.map(docRowHtml).join("") : '<span class="no-docs">No additional documents uploaded.</span>'}${extra}</div></div>`;
    })
    .join("");
}
function documentsSearchHtml() {
  return `<div style="position:relative;width:380px;max-width:100%"><span aria-hidden="true" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);opacity:.65;pointer-events:none">🔍</span><input class="search" id="docSearch" type="search" placeholder="Search rider name, Rider ID or document..." aria-label="Search riders and documents" value="${esc(docSearch.query)}" autocomplete="off" style="width:100%;padding-left:38px;padding-right:38px"><button type="button" id="docSearchClear" aria-label="Clear search" title="Clear search" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:4px 6px;display:${docSearch.query ? "block" : "none"}">✕</button></div>`;
}
const DOC_UPLOAD_TYPES = [
  "Aadhaar / ID Proof",
  "PAN Card",
  "Driving Licence",
  "Bank Passbook",
  "RC Book",
  "Insurance Document",
  "Other Documents",
];
const DOC_FILE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
const SELFIE_FILE_EXT = [".jpg", ".jpeg", ".png", ".webp"];
const DOC_MAX_UPLOAD = 5 * 1024 * 1024;
const docDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN") : "");
function docMatchesSearch(hay, raw, q) {
  return hay.includes(raw) || (q && normText(hay).includes(q));
}
function uploadedDocsRows() {
  const raw = String(docSearch.query || "")
    .trim()
    .toLowerCase();
  const q = normText(raw);
  const docsList = Array.isArray(adminDocs) ? adminDocs : [];
  return docsList.filter((d) => {
    if (!d) return false;
    if (!raw) return true;
    const hay = [
      d.riderName,
      d.riderId,
      d.type,
      ...docTypeAliases(d.type),
      d.name,
      d.selfie?.name,
      docDate(d.createdAt),
    ]
      .map((v) => String(v ?? ""))
      .join(" | ")
      .toLowerCase();
    return docMatchesSearch(hay, raw, q);
  });
}
function uploadedDocsTableHtml() {
  const rows = uploadedDocsRows();
  const body = rows.length
    ? rows
        .map(
          (d) =>
            `<tr><td>${esc(d.riderName || "—")}</td><td>${esc(d.riderId)}</td><td>${esc(d.type)}</td><td>${esc(d.name)}</td>` +
            `<td>${d.selfie ? `<button type="button" class="btn-sm" onclick="viewDoc('${esc(d.id)}','selfie')">${esc(d.selfie.name)} · View</button>` : '<span class="muted">—</span>'}</td>` +
            `<td>${esc(docDate(d.createdAt))}</td>` +
            `<td class="doc-actions"><button type="button" class="btn-sm" onclick="viewDoc('${esc(d.id)}')">View</button> <button type="button" class="btn-sm" onclick="downloadDoc('${esc(d.id)}')">Download</button> <button type="button" class="btn-sm" onclick="openDocumentForm({replaceId:'${esc(d.id)}'})">Replace</button> <button type="button" class="btn-sm danger" onclick="deleteDoc('${esc(d.id)}')">Delete</button></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="empty">${String(docSearch.query || "").trim() ? "No matching documents found" : "No documents uploaded yet. Use + Upload Rider Document to add one."}</td></tr>`;
  return `<div class="card doc-table-card"><div class="section-head"><div><h3>Uploaded documents</h3><p class="muted">Each file is saved against its Rider ID. Files open only for signed-in admins.</p></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Rider Name</th><th>Rider ID</th><th>Document Type</th><th>File Name</th><th>Rider Selfie / Screenshot</th><th>Upload Date</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}
function documents() {
  return (
    layout(
      "Documents",
      "Upload Aadhaar, PAN, licence, passbook, RC, insurance and other rider documents, with an optional rider selfie.",
      `<button type="button" class="primary" id="docNewUpload">+ Upload Rider Document</button>` +
        documentsSearchHtml(),
    ) +
    `<div id="docUploadTable">${uploadedDocsTableHtml()}</div><div class="documents-card" id="documentsList">${documentsListHtml()}</div>`
  );
}
function bindDocuments() {
  const inp = $("#docSearch"),
    clr = $("#docSearchClear");
  if (!inp) return;
  const paint = () => {
    if ($("#docUploadTable"))
      $("#docUploadTable").innerHTML = uploadedDocsTableHtml();
    if ($("#documentsList"))
      $("#documentsList").innerHTML = documentsListHtml();
    if (clr) clr.style.display = docSearch.query ? "block" : "none";
  };
  inp.addEventListener("input", () => {
    docSearch.query = inp.value;
    paint();
  });
  clr?.addEventListener("click", () => {
    docSearch.query = "";
    inp.value = "";
    paint();
    inp.focus();
  });
  $("#docNewUpload")?.addEventListener("click", () => openDocumentForm());
  $("#documentsList")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-reg-doc]");
    if (!b) return;
    const reg = rrItemsArray().find((x) => x.id === b.dataset.regId);
    if (reg)
      rrOpenDocument(
        reg.id,
        b.dataset.regDoc,
        `${b.dataset.regDoc === "selfie" ? "Rider selfie" : "Aadhaar"} · ${b.dataset.regName} (${reg.riderId})`,
      );
  });
  Promise.all([
    typeof rrLoad === "function" ? rrLoad({ quiet: true }) : Promise.resolve(),
    loadAdminDocs(),
  ]).then(() => {
    if (currentPage === "documents" && $("#documentsList")) paint();
  });
}
const riderLabelOf = (id, name) => (id ? `${name || ""} (${id})`.trim() : "");
function docRiderChoices() {
  return (db.riders || [])
    .filter((r) => r.id && !r.provisional)
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}
function docFileProblem(file, exts, label, allowedText) {
  if (!file) return "";
  const name = String(file.name || "").toLowerCase();
  if (!exts.some((x) => name.endsWith(x)))
    return `The ${label} must be a ${allowedText} file.`;
  if (file.size > DOC_MAX_UPLOAD)
    return `The ${label} is larger than 5 MB. Please choose a smaller file.`;
  if (!file.size) return `The ${label} is empty. Please choose another file.`;
  return "";
}
function newSubmissionId() {
  return (
    (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
    "sub-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10)
  );
}
function upsertDocItem(item) {
  adminDocs = [item, ...adminDocs.filter((x) => x.id !== item.id)];
}

window.openDocumentForm = ({ riderId = "", replaceId = "" } = {}) => {
  const existing = replaceId ? adminDocs.find((x) => x.id === replaceId) : null;
  if (replaceId && !existing)
    return toast(
      "This document is no longer in the list. Refresh the page and try again.",
    );
  const isReplace = !!existing;
  const preset = isReplace
    ? null
    : db.riders.find((x) => x.id === riderId) || null;
  if (!isReplace && riderId && !preset)
    return toast("That rider was not found in the registered riders.");
  const riderId0 = isReplace ? existing.riderId : preset ? preset.id : "";
  const riderName0 = isReplace
    ? existing.riderName || ""
    : preset
      ? preset.name || ""
      : "";
  const typeOptions = [
    `<option value="" ${isReplace ? "hidden" : "selected"}>Choose a document type</option>`,
    ...(isReplace && !DOC_UPLOAD_TYPES.includes(existing.type)
      ? [`<option selected>${esc(existing.type)}</option>`]
      : []),
    ...DOC_UPLOAD_TYPES.map(
      (t) =>
        `<option ${isReplace && t === existing.type ? "selected" : ""}>${esc(t)}</option>`,
    ),
  ].join("");
  const riderField = isReplace
    ? `<div class="field span2"><label for="docRiderSearch">Rider</label><input id="docRiderSearch" value="${esc(riderLabelOf(riderId0, riderName0))}" disabled></div>`
    : `<div class="field span2 doc-rider-field"><label for="docRiderSearch">Rider</label><input id="docRiderSearch" type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="docRiderList" placeholder="Search by rider name or Rider ID" value="${esc(riderLabelOf(riderId0, riderName0))}"><ul id="docRiderList" class="doc-rider-list" role="listbox" hidden></ul><small class="hint">Choose a registered rider. Example: Appari Ravi Kumar (28050593)</small></div>`;
  openModal(
    `<h3>${isReplace ? "Replace Rider Document" : "Upload Rider Document"}</h3>` +
      `<form id="docForm" class="form-grid" novalidate><input type="hidden" id="docRiderId" value="${esc(riderId0)}">` +
      riderField +
      `<div class="field"><label for="dType">Document Type</label><select id="dType">${typeOptions}</select></div>` +
      `<div class="field span2"><label for="dFile">Choose File</label><div class="doc-pick"><label class="file-picker"><input type="file" id="dFile" accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf" hidden><span>Choose file</span></label><span id="dFileName" class="file-name">${isReplace ? `Current: ${esc(existing.name)}` : "No file chosen"}</span></div><small class="hint">${isReplace ? "Leave empty to keep the current file. " : ""}JPG, JPEG, PNG, WEBP or PDF, up to 5 MB.</small></div>` +
      `<div class="field span2"><label for="dSelfie">Rider Selfie / Screenshot <span class="muted">(optional)</span></label><div class="doc-pick"><label class="file-picker"><input type="file" id="dSelfie" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" hidden><span>Choose image</span></label><span id="dSelfieName" class="file-name">${isReplace && existing.selfie ? `Current: ${esc(existing.selfie.name)}` : "No file chosen"}</span></div><img id="dSelfiePreview" class="doc-selfie-preview" alt="" hidden><small class="hint">${isReplace ? "Leave empty to keep the current selfie. " : ""}JPG, JPEG, PNG or WEBP, up to 5 MB.</small></div>` +
      `<p id="docError" class="form-message error span2" role="alert"></p>` +
      `<div class="modal-actions span2"><button type="button" class="ghost" id="docCancel">Cancel</button><button type="submit" class="primary" id="docSave">${isReplace ? "Save changes" : "Upload"}</button></div></form>`,
  );
  wireDocumentForm(isReplace ? existing : null);
};

function wireDocumentForm(existing) {
  const err = (m) => ($("#docError").textContent = m || "");
  const form = $("#docForm");
  const btn = $("#docSave");
  const submissionId = newSubmissionId();
  let busy = false;
  let selfieUrl = "";
  const clearSelfieUrl = () => {
    if (selfieUrl) URL.revokeObjectURL(selfieUrl);
    selfieUrl = "";
  };
  const resetSelfiePreview = (img) => {
    clearSelfieUrl();
    if (!img) return;
    img.hidden = true;
    img.removeAttribute("src");
    img.alt = "";
  };

  if (!existing) {
    const input = $("#docRiderSearch");
    const list = $("#docRiderList");
    let shown = [];
    let hi = 0;
    const setRider = (r) => {
      $("#docRiderId").value = r ? r.id : "";
      err("");
    };
    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    };
    const draw = () => {
      const raw = input.value.trim().toLowerCase();
      const q = normText(raw);
      shown = docRiderChoices()
        .filter((r) => {
          const hay = `${r.name || ""} ${r.id}`.toLowerCase();
          return !raw || hay.includes(raw) || (q && normText(hay).includes(q));
        })
        .slice(0, 60);
      hi = Math.min(hi, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length
        ? shown
            .map(
              (r, i) =>
                `<li role="option" id="docRider-${i}" data-i="${i}" aria-selected="${i === hi}">${esc(r.name || "")} <span class="muted">(${esc(r.id)})</span></li>`,
            )
            .join("")
        : `<li class="muted">No registered rider matches. Check the name or Rider ID.</li>`;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const pick = (r) => {
      input.value = riderLabelOf(r.id, r.name);
      setRider(r);
      close();
    };
    input.addEventListener("focus", () => {
      if (!input.value.trim() || !$("#docRiderId").value) draw();
    });
    input.addEventListener("input", () => {
      setRider(null);
      hi = 0;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp"))
        return draw();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        hi =
          (hi + (e.key === "ArrowDown" ? 1 : -1) + shown.length) %
          Math.max(1, shown.length);
        draw();
      } else if (e.key === "Enter" && !list.hidden && shown[hi]) {
        e.preventDefault();
        pick(shown[hi]);
      } else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (!li) return;
      e.preventDefault();
      pick(shown[Number(li.dataset.i)]);
    });
  }

  $("#dFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    const problem = docFileProblem(
      f,
      DOC_FILE_EXT,
      "document",
      "JPG, JPEG, PNG, WEBP or PDF",
    );
    if (problem) {
      e.target.value = "";
      $("#dFileName").textContent = existing
        ? `Current: ${existing.name}`
        : "No file chosen";
      return err(problem);
    }
    $("#dFileName").textContent = f
      ? f.name
      : existing
        ? `Current: ${existing.name}`
        : "No file chosen";
    err("");
  });
  $("#dSelfie").addEventListener("change", (e) => {
    const f = e.target.files[0];
    const problem = docFileProblem(
      f,
      SELFIE_FILE_EXT,
      "Rider Selfie / Screenshot",
      "JPG, JPEG, PNG or WEBP",
    );
    const img = $("#dSelfiePreview");
    if (problem) {
      e.target.value = "";
      resetSelfiePreview(img);
      $("#dSelfieName").textContent = existing?.selfie
        ? `Current: ${existing.selfie.name}`
        : "No file chosen";
      return err(problem);
    }
    if (f) {
      clearSelfieUrl();
      selfieUrl = URL.createObjectURL(f);
      img.src = selfieUrl;
      img.alt = "Selected selfie or screenshot preview";
      img.hidden = false;
      $("#dSelfieName").textContent = f.name;
    } else {
      resetSelfiePreview(img);
      $("#dSelfieName").textContent = existing?.selfie
        ? `Current: ${existing.selfie.name}`
        : "No file chosen";
    }
    err("");
  });
  $("#docCancel").addEventListener("click", () => {
    resetSelfiePreview($("#dSelfiePreview"));
    closeModal();
  });
  $("#docForm").addEventListener("input", () => err(""));

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const type = $("#dType").value;
    const docFile = $("#dFile").files[0];
    const selfieFile = $("#dSelfie").files[0];
    const riderId = $("#docRiderId").value;
    const rider = existing ? null : db.riders.find((x) => x.id === riderId);
    if (!existing) {
      if (!rider) return err("Choose a rider from the list.");
      if (!DOC_UPLOAD_TYPES.includes(type))
        return err("Choose a document type.");
      if (!docFile) return err("Choose a document file to upload.");
    } else if (!docFile && !selfieFile && type === existing.type) {
      return err(
        "Choose a new file, a new selfie or a new document type to save.",
      );
    }
    const docProblem = docFileProblem(
      docFile,
      DOC_FILE_EXT,
      "document",
      "JPG, JPEG, PNG, WEBP or PDF",
    );
    const selfieProblem = docFileProblem(
      selfieFile,
      SELFIE_FILE_EXT,
      "Rider Selfie / Screenshot",
      "JPG, JPEG, PNG or WEBP",
    );
    if (docProblem || selfieProblem) return err(docProblem || selfieProblem);

    const fd = new FormData();
    let url = PARTNER_API_BASE + "/api/admin/rider-documents";
    let method = "POST";
    if (existing) {
      url += "/" + encodeURIComponent(existing.id);
      method = "PUT";
      if (type !== existing.type) fd.append("type", type);
    } else {
      fd.append("riderId", rider.id);
      fd.append("riderName", rider.name || "");
      fd.append("type", type);
      fd.append("submissionId", submissionId);
    }
    if (docFile) fd.append("file", docFile, docFile.name);
    if (selfieFile) fd.append("selfie", selfieFile, selfieFile.name);

    busy = true;
    btn.disabled = true;
    btn.textContent = existing ? "Saving…" : "Uploading…";
    try {
      const res = await fetch(url, {
        method,
        credentials: "include",
        body: fd,
      });
      if (res.status === 401) return sessionEnded();
      const out = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(out.error || "Upload failed (" + res.status + ")");
      upsertDocItem(out.item);
      resetSelfiePreview($("#dSelfiePreview"));
      closeModal();
      render("documents");
      toast(
        existing
          ? "Document updated"
          : out.duplicate
            ? "This document was already saved."
            : "Document uploaded",
      );
    } catch (ex) {
      busy = false;
      btn.disabled = false;
      btn.textContent = existing ? "Save changes" : "Upload";
      err(
        ex.message === "Failed to fetch"
          ? "The server is not reachable. Check that it is running and try again."
          : ex.message,
      );
    }
  };
}

window.uploadRiderDoc = (id) => openDocumentForm({ riderId: id });
window.viewDoc = async (id, kind = "document") => {
  const d = adminDocs.find((x) => x.id === id);
  const selfie = kind === "selfie";
  const name = selfie ? d?.selfie?.name || "selfie" : d?.name || "document";
  try {
    const r = await fetch(
      PARTNER_API_BASE +
        "/api/admin/rider-documents/" +
        encodeURIComponent(id) +
        "/file" +
        (selfie ? "?kind=selfie" : ""),
      { credentials: "include" },
    );
    if (r.status === 401) return sessionEnded();
    if (!r.ok) {
      const out = await r.json().catch(() => ({}));
      return toast(out.error || "Could not open the file.");
    }
    const blob = await r.blob();
    rrRevokeDocument();
    rrObjectUrl = URL.createObjectURL(blob);
    const title = d
      ? `${selfie ? "Rider Selfie / Screenshot" : d.type} · ${d.riderName || d.riderId} (${d.riderId})`
      : "Rider document";
    const view =
      blob.type === "application/pdf"
        ? `<iframe src="${rrObjectUrl}" title="${esc(title)}"></iframe>`
        : `<img src="${rrObjectUrl}" alt="${esc(title)}">`;
    openModal(
      `<h3>${esc(title)}</h3><div class="rr-doc-view">${view}</div><p class="hint">${esc(name)}</p><div class="modal-actions"><a class="btn-sm" href="${rrObjectUrl}" download="${esc(name)}">Download</a><button type="button" class="ghost" onclick="rrCloseDocument()">Close</button></div>`,
    );
  } catch (e) {
    toast("Could not reach the server. Check your connection and try again.");
  }
};
window.downloadDoc = async (id, kind = "document") => {
  const d = adminDocs.find((x) => x.id === id);
  const selfie = kind === "selfie";
  try {
    const r = await fetch(
      PARTNER_API_BASE +
        "/api/admin/rider-documents/" +
        encodeURIComponent(id) +
        "/file" +
        (selfie ? "?kind=selfie" : ""),
      { credentials: "include" },
    );
    if (r.status === 401) return sessionEnded();
    if (!r.ok) {
      const out = await r.json().catch(() => ({}));
      return toast(out.error || "Could not download the file.");
    }
    const url = URL.createObjectURL(await r.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = selfie
      ? d?.selfie?.name || "selfie"
      : d?.name || "document";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast("Could not reach the server. Check your connection and try again.");
  }
};
window.deleteDoc = async (id) => {
  const d = adminDocs.find((x) => x.id === id);
  if (d) {
    if (
      !confirm(
        `Delete ${d.type} (${d.name}) of ${d.riderName || d.riderId}? This cannot be undone.`,
      )
    )
      return;
    try {
      const r = await fetch(
        PARTNER_API_BASE +
          "/api/admin/rider-documents/" +
          encodeURIComponent(id),
        { method: "DELETE", credentials: "include" },
      );
      if (r.status === 401) return sessionEnded();
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return toast(out.error || "Could not delete the document.");
      adminDocs = adminDocs.filter((x) => x.id !== id);
      render("documents");
      toast("Document deleted");
    } catch (e) {
      toast("Could not reach the server. Check your connection and try again.");
    }
    return;
  }
  db.documents = db.documents.filter((x) => x.id !== id);
  save();
  render("documents");
};
function isoWeekStart(iso) {
  const d = new Date(String(iso || "") + "T00:00:00");
  if (isNaN(d)) return "";
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}
function weekLabel(start) {
  if (!start) return "—";
  const d = new Date(start + "T00:00:00");
  const e = new Date(d);
  e.setDate(d.getDate() + 6);
  const f = (x) =>
    String(x.getDate()).padStart(2, "0") +
    "/" +
    String(x.getMonth() + 1).padStart(2, "0") +
    "/" +
    x.getFullYear();
  return f(d) + " - " + f(e);
}
function normText(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}
function excelDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && window.XLSX?.SSF) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d)
      return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  let s = String(v ?? "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return `${y}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
  }
  let d = new Date(s);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}
function displayDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}
function parseOrderPair(v) {
  if (v == null || v === "") return { lm: 0, primary: 0, club: 0 };
  let s = String(v).trim().replace(/,/g, "");
  let m = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const lm = Number(m[1]),
      primary = Number(m[2]);
    return { lm, primary, club: Math.max(0, lm - primary) };
  }
  let n = Number(s.replace(/[^0-9.-]/g, ""));
  return { lm: isFinite(n) ? n : 0, primary: 0, club: 0 };
}
function parseRate(v) {
  const s = String(v ?? "");
  const nums = [
    ...s.matchAll(/₹?\s*(\d+(?:\.\d+)?)\s*(?:Pri(?:mary)?|P)?/gi),
  ].map((m) => Number(m[1]));
  const clubMatch = s.match(/₹?\s*(\d+(?:\.\d+)?)\s*Club/i);
  let primary = nums[0] || 0,
    club = clubMatch ? Number(clubMatch[1]) : 0;
  if (!club) {
    const all = [...s.matchAll(/₹?\s*(\d+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1]),
    );
    if (all.length > 1) club = all[1];
  }
  return { primary, club };
}
function riderForExcel(id, name, hub) {
  const excelId = String(id || "").trim(),
    riderName = String(name || "").trim(),
    normalized = normText(riderName);
  const priorMap = db.riders.find(
    (x) =>
      x.provisional &&
      String(x.excelRiderId || "")
        .trim()
        .toLowerCase() === excelId.toLowerCase() &&
      normText(x.name) === normalized &&
      x.mappedRiderId,
  );
  if (priorMap)
    return {
      ...priorMap,
      id: priorMap.mappedRiderId,
      name: priorMap.mappedRiderName || priorMap.name,
      provisional: false,
    };
  let r = excelId
    ? db.riders.find(
        (x) =>
          String(x.id).trim().toLowerCase() === excelId.toLowerCase() &&
          normText(x.name) === normalized,
      )
    : null;
  if (!r && normalized) {
    const base = normText(riderName.replace(/\([^)]*\)/g, ""));
    const matches = db.riders.filter((x) => {
      const xn = normText(x.name),
        xb = normText(String(x.name).replace(/\([^)]*\)/g, ""));
      return xn === normalized || (base && xb === base);
    });
    if (matches.length === 1) r = matches[0];
  }
  if (!r) {
    const seedVal = excelId.toUpperCase() + "|" + normalized || "unknown";
    let hash = 2166136261;
    for (let i = 0; i < seedVal.length; i++) {
      hash ^= seedVal.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const provisionalKey =
      "PROVISIONAL-" + (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
    r = db.riders.find((x) => x.provisionalKey === provisionalKey);
    if (!r) {
      r = {
        name: riderName || "Unverified Excel rider",
        id: provisionalKey,
        provisionalKey,
        excelRiderId: excelId,
        provisional: true,
        phone: "",
        location: hub || "",
        hub: hub || "",
        status: "Pending Verification",
        weekly: 0,
        notes:
          "Provisional profile created from Excel. Verify against Admin Rider Registration before approval.",
      };
      db.riders.push(r);
    }
  } else if (hub && !r.hub) r.hub = hub;
  return r;
}
async function fileSha256(buf) {
  try {
    if (!window.crypto?.subtle) return "";
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch (e) {
    return "";
  }
}
async function importPaymentsExcel(file) {
  const ext = (
    String(file?.name || "")
      .split(".")
      .pop() || ""
  ).toLowerCase();
  if (!["xlsx", "xls"].includes(ext)) {
    toast("Invalid file format. Please upload an .xlsx or .xls Excel file.");
    return;
  }
  if (!window.XLSX) {
    toast(
      "Excel reader is not loaded. Check your internet connection and try again.",
    );
    return;
  }
  let result,
    parsed = null,
    layout = "";
  try {
    const buf = await file.arrayBuffer();
    parsed = PaymentExcel.parseSheets(
      PaymentExcel.sheetsFromWorkbook(XLSX, XLSX.read(buf, { type: "array" })),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    layout = parsed.layout;
    const blankIds = parsed.records.filter(
      (r) => !String(r.riderId || "").trim(),
    ).length;
    if (blankIds)
      parsed.warnings.push(
        `${blankIds} row(s) have no Rider ID in the sheet; the server matches them by name to Rider Registration.`,
      );
    const out = await weeklyRequest("/import", {
      method: "POST",
      body: {
        fileName: file.name,
        fileHash: await fileSha256(buf),
        records: parsed.records,
      },
    });
    result = out.result;
    weeklyStore.lastImport = {
      importId: result.importId,
      fileName: result.fileName,
      importedAt: new Date().toISOString(),
      total: result.total,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      amountTotal: result.amountTotal,
      weeks: result.weeks,
    };
    weeklyStore.newImportId = result.alreadyImported ? "" : result.importId;
    save();
  } catch (err) {
    console.error(err);
    toast("Excel import failed: " + (err.message || "Unknown error"));
    return;
  }
  const now = new Date().toLocaleString("en-IN");
  if (layout === "weekly")
    db.excelSync = {
      ...(db.excelSync || {}),
      lastSync: now,
      fileName: file.name,
      rows: result.total,
      records: result.total,
      history: [
        ...(db.excelSync?.history || []),
        {
          time: now,
          fileName: file.name,
          records: result.total,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
        },
      ].slice(-20),
    };
  save();
  await loadWeeklyPayments();
  render("payments");
  toast("Excel import completed.");
}
function whatsapp() {
  return (
    layout(
      "WhatsApp",
      "Prepare rider and delivery updates for WhatsApp.",
      '<button class="primary" id="newMessage">+ Create Message</button>',
    ) +
    `<div class="grid2"><div class="card"><h3>Message Templates</h3><div class="file-list"><div class="file-item"><span><b>Rider Update</b><br>Rider {name} ({phone}) has been updated.</span><button class="btn-sm" onclick="useTemplate('Rider Update')">Use</button></div><div class="file-item"><span><b>Delivery Update</b><br>Rider {name} is handling today’s deliveries.</span><button class="btn-sm" onclick="useTemplate('Delivery Update')">Use</button></div></div></div><div class="card"><h3>Recent Messages</h3>${db.messages.map((m) => `<div class="file-item"><span><b>${esc(m.type)}</b><br>${esc(m.text)}</span><small>${esc(m.date)}</small></div>`).join("") || '<div class="empty">No messages yet.</div>'}</div></div>`
  );
}
function bindWhatsApp() {
  if ($("#newMessage")) $("#newMessage").onclick = () => messageModal();
}
function useTemplate(t) {
  messageModal(t);
}
window.useTemplate = useTemplate;
function messageModal(type = "Rider Update") {
  if (!db.riders.length) return toast("Add a rider first");
  const body =
    type === "Delivery Update"
      ? "Rider {name} is handling today’s deliveries."
      : "Rider {name} ({phone}) has been updated.";
  openModal(
    `<h3>Create WhatsApp Message</h3><form id="msgForm" class="form-grid"><div class="field"><label>Rider</label><select id="mRider">${db.riders.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select></div><div class="field"><label>Template</label><select id="mType"><option>Rider Update</option><option>Delivery Update</option><option>Custom</option></select></div><div class="field span2"><label>Message</label><textarea id="mText" rows="5">${body}</textarea></div><div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save Message</button></div></form>`,
  );
  $("#msgForm").onsubmit = (e) => {
    e.preventDefault();
    const r = db.riders.find((x) => x.id === $("#mRider").value);
    const text = $("#mText")
      .value.replaceAll("{name}", r.name)
      .replaceAll("{phone}", r.phone);
    db.messages.push({
      type: $("#mType").value,
      text,
      date: new Date().toLocaleString(),
    });
    save();
    closeModal();
    render("whatsapp");
    toast(
      "Message prepared. Connect WhatsApp API/provider to send automatically.",
    );
  };
}
function partnerPrefix(type) {
  return String(type || "").toLowerCase() === "vendor" ? "VN" : "FP";
}
function nextPartnerAppId(type, excludeId = "") {
  const prefix = partnerPrefix(type);
  let max = 0;
  (Array.isArray(db.partners) ? db.partners : []).forEach((p) => {
    if (p.id === excludeId) return;
    const m = String(p.appId || "").match(
      new RegExp("^" + prefix + "-(\\d{6})$", "i"),
    );
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + "-" + String(max + 1).padStart(6, "0");
}
function normalizePartnerIds() {
  if (!Array.isArray(db.partners)) db.partners = [];
  const used = new Set();
  const counters = { FP: 0, VN: 0 };
  db.partners.forEach((p) => {
    p.type =
      String(p.type || "").toLowerCase() === "vendor" ? "Vendor" : "Franchise";
    const prefix = partnerPrefix(p.type);
    const id = String(p.appId || "");
    const m = id.match(/^(FP|VN)-(\d{6})$/i);
    if (m && !used.has(id.toUpperCase())) {
      used.add(id.toUpperCase());
      counters[prefix] = Math.max(counters[prefix], Number(m[2]));
      return;
    }
    counters[prefix]++;
    let candidate = prefix + "-" + String(counters[prefix]).padStart(6, "0");
    while (used.has(candidate)) {
      counters[prefix]++;
      candidate = prefix + "-" + String(counters[prefix]).padStart(6, "0");
    }
    p.appId = candidate;
    used.add(candidate);
  });
}
normalizePartnerIds();
(db.partners || []).forEach((p) => {
  if (p.status === "Approved") p.status = "Accepted";
});
save();
function client() {
  const all = Array.isArray(db.partners) ? db.partners : [];
  const vendors = all.filter((p) => p.type === "Vendor"),
    franchises = all.filter((p) => p.type === "Franchise");
  const members = Array.isArray(db.vendorMembers) ? db.vendorMembers : [];
  return `<div class="cards">${stat("Total Clients", vendors.length + franchises.length, "clientStatTotal")}${stat("Vendors", vendors.length, "clientStatVendors")}${stat("Franchises", franchises.length, "clientStatFranchises")}${stat("Members", members.length)}</div>
 <div class="card"><div class="section-head"><div><h3>Franchise Applications &amp; Vendor Registrations</h3><p class="muted">Two separate lists. Each has its own search, status filter and Excel export.</p></div><div class="partner-filters">${statusFilterSelect("clientStatusFilter")}<input class="hub-search" id="clientSearch" placeholder="Search vendor / franchise name, ID, phone, city... (shows their riders)" autocomplete="off"><button class="ghost" id="exportPartnerExcel" type="button">⬇ Export Excel</button></div></div>
 <div class="client-tabs"><button class="tab-btn active" data-client-tab="franchise">Franchise Applications</button><button class="tab-btn" data-client-tab="vendor">Vendor Registrations</button></div>
 <div id="clientVendorPanel" class="hidden"><div class="table-wrap"><table class="table"><thead><tr><th>Vendor ID</th><th>Name / Company</th><th>Contact</th><th>Phone</th><th>Street / Locality</th><th>Near / Landmark</th><th>City / Pincode</th><th>Status</th><th>Form</th></tr></thead><tbody id="vendorRows"></tbody></table></div></div>
 <div id="clientFranchisePanel"><div class="table-wrap"><table class="table"><thead><tr><th>Franchise ID</th><th>Name / Company</th><th>Contact</th><th>Phone</th><th>Street / Locality</th><th>Near / Landmark</th><th>City / Pincode</th><th>Status</th><th>Form</th></tr></thead><tbody id="franchiseRows"></tbody></table></div></div></div>
 <div class="card hidden" id="partnerRidersCard"></div>
 <div class="card" id="regMembersCard"><div class="section-head"><div><h3>Client Members — Rider Registrations</h3><p class="muted">Every rider registered by Admin, Franchise or Vendor appears here. New registrations start as PENDING.</p></div><div class="actions"><button class="ghost" id="regRefresh" type="button">↻ Refresh</button></div></div>
 <div class="cards"><div class="stat"><div class="label">Total</div><div class="value" id="regStatTotal">0</div></div><div class="stat"><div class="label">Pending</div><div class="value" id="regStatPending">0</div></div><div class="stat"><div class="label">Approved</div><div class="value" id="regStatApproved">0</div></div><div class="stat"><div class="label">Rejected</div><div class="value" id="regStatRejected">0</div></div></div>
 <div class="rr-filters"><input class="search" id="regFilterId" placeholder="Filter by Rider ID" autocomplete="off"><input class="search" id="regFilterName" placeholder="Filter by Rider Name" autocomplete="off"><input class="search" id="regFilterHub" placeholder="Filter by Hub Location" autocomplete="off"><select class="status-filter" id="regFilterStatus" aria-label="Filter by application status"><option value="">All statuses</option><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="BANNED">Banned</option><option value="REJECTED">Rejected</option></select></div>
 <div class="table-wrap"><table class="table reg-table"><thead><tr><th>Rider ID</th><th>Rider Name</th><th>Mobile Number</th><th>Hub Pincode</th><th>Hub Location</th><th>Selfie</th><th>Aadhaar</th><th>Applied By</th><th>Application Date</th><th>Status</th><th>Action</th></tr></thead><tbody id="regRows"></tbody></table></div>
 <p id="regEmpty" class="empty hidden"></p></div>`;
}
const PARTNER_EXPORT_COLUMNS = {
  Franchise: [
    ["Application ID", (p) => p.appId],
    ["Full Name", (p) => p.name],
    ["Date of Birth", (p) => p.dateOfBirth || ""],
    ["Email Address", (p) => p.email],
    ["Mobile Number", (p) => p.mobile],
    ["WhatsApp Number", (p) => p.whatsapp || ""],
    ["State", (p) => p.state],
    ["District", (p) => p.district],
    ["Village / City Name", (p) => p.city],
    ["Location / Area Name", (p) => p.locality || ""],
    ["PIN Code", (p) => p.pincode || ""],
    ["Full Address", (p) => p.address],
    ["Years of Experience", (p) => p.yearsOfExperience || ""],
    ["Status", (p) => partnerStatusLabel(p)],
    ["Submitted At", (p) => (p.submittedAt ? fmtDate(p.submittedAt) : "")],
  ],
  Vendor: [
    ["Application ID", (p) => p.appId],
    ["Full Name", (p) => p.name],
    ["Date of Birth", (p) => p.dateOfBirth || ""],
    ["Email Address", (p) => p.email],
    ["Mobile Number", (p) => p.mobile],
    ["WhatsApp Number", (p) => p.whatsapp || ""],
    ["State", (p) => p.state],
    ["District", (p) => p.district],
    ["Village / City Name", (p) => p.city],
    ["Location / Area Name", (p) => p.locality || ""],
    ["PIN Code", (p) => p.pincode || ""],
    ["Full Address", (p) => p.address],
    ["Years of Experience", (p) => p.yearsOfExperience || ""],
    ["Status", (p) => partnerStatusLabel(p)],
    ["Submitted At", (p) => (p.submittedAt ? fmtDate(p.submittedAt) : "")],
  ],
};
function partnerStatusLabel(p) {
  return isPendingPartner(p)
    ? "Pending"
    : p.status === "Accepted"
      ? "Approved"
      : "Rejected";
}
function activeClientType() {
  return document.querySelector(".client-tabs .tab-btn.active")?.dataset
    .clientTab === "vendor"
    ? "Vendor"
    : "Franchise";
}
const safeCell = (v) => {
  const t = String(v ?? "");
  return /^[=+\-@]/.test(t) ? "'" + t : t;
};
function exportPartnerRows(type) {
  if (!window.XLSX) {
    toast(
      "Excel export is not loaded. Check your internet connection and try again.",
    );
    return;
  }
  const rows = (window.__clientFiltered && window.__clientFiltered[type]) || [];
  const cols = PARTNER_EXPORT_COLUMNS[type];
  const data = rows.map((p) =>
    Object.fromEntries(cols.map(([h, get]) => [h, safeCell(get(p))])),
  );
  const ws = XLSX.utils.json_to_sheet(data, { header: cols.map((c) => c[0]) });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    ws,
    type === "Vendor" ? "Vendor Registrations" : "Franchise Applications",
  );
  XLSX.writeFile(
    wb,
    `${type === "Vendor" ? "vendor-registrations" : "franchise-applications"}-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
  toast(
    `Exported ${rows.length} ${type === "Vendor" ? "vendor registration" : "franchise application"}${rows.length === 1 ? "" : "s"}`,
  );
}
function banUntilText(ban) {
  return ban && ban.until
    ? "until " +
        new Date(ban.until).toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
    : "until unbanned";
}
function partnerBanButton(p) {
  if (!p.portalLogin) return "";
  return p.portalLogin.ban
    ? `<button class="btn-sm accept" onclick="unbanPartner('${esc(p.id)}')" title="Banned ${esc(banUntilText(p.portalLogin.ban))}. Let them sign in again.">✓ Unban</button>`
    : `<button class="btn-sm danger" onclick="banPartner('${esc(p.id)}')" title="Stop this ${p.type === "Vendor" ? "vendor" : "franchise"} from signing in to the portal">🚫 Ban</button>`;
}
function applyServerPartner(p, out) {
  Object.assign(p, mapServerPartner(out.application || {}));
  save();
  refreshPartnerViews();
}
window.banPartner = (id) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p || !p.portalLogin)
    return toast("This application has no portal login yet.");
  const kind = p.type === "Vendor" ? "Vendor" : "Franchise";
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  openModal(`<h3>Ban ${esc(p.appId)} · ${esc(p.name)}?</h3>
    <p>They are signed out at once and cannot sign in to the ${kind} Portal until the ban ends. The application stays ${esc(badgeLabel(p.status))}; riders, orders and payments are not changed.</p>
    <div class="form-grid">
      <div class="field"><label for="banFor">Ban for</label><select id="banFor"><option value="forever">Until I unban them</option><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="date">Until a date…</option></select></div>
      <div class="field hidden" id="banDateWrap"><label for="banDate">Banned until the end of</label><input id="banDate" type="date" min="${tomorrow}" value="${tomorrow}"></div>
      <div class="field span2"><label for="banReason">Reason (shown to them when they try to sign in)</label><textarea id="banReason" rows="3" maxlength="300" placeholder="e.g. Pending documents, please contact the office"></textarea></div>
      <p id="banError" class="form-message error span2" role="alert"></p>
      <div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="button" class="primary danger-fill" id="banConfirm">🚫 Ban login</button></div>
    </div>`);
  $("#banFor").onchange = () =>
    $("#banDateWrap").classList.toggle("hidden", $("#banFor").value !== "date");
  $("#banConfirm").onclick = async () => {
    const choice = $("#banFor").value;
    let until = "";
    if (choice === "date") {
      const d = $("#banDate").value;
      if (!d)
        return ($("#banError").textContent = "Choose the last day of the ban.");
      until = new Date(d + "T23:59:59").toISOString();
    } else if (choice !== "forever")
      until = new Date(Date.now() + Number(choice) * 86400000).toISOString();
    const btn = $("#banConfirm");
    btn.disabled = true;
    try {
      const r = await partnerApi("/" + encodeURIComponent(p.id) + "/ban", {
        method: "POST",
        body: JSON.stringify({ until, reason: $("#banReason").value.trim() }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || "Could not ban the login.");
      applyServerPartner(p, out);
      closeModal();
      toast(
        `${p.appId} banned ${banUntilText(p.portalLogin?.ban)} - signed out of the portal`,
      );
    } catch (err) {
      btn.disabled = false;
      $("#banError").textContent = err.message;
    }
  };
};
window.unbanPartner = async (id) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p) return;
  if (
    !confirm(
      `Unban ${p.appId} (${p.name})? They can sign in to the portal again with their own password.`,
    )
  )
    return;
  try {
    const r = await partnerApi("/" + encodeURIComponent(p.id) + "/unban", {
      method: "POST",
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || "Could not unban the login.");
    applyServerPartner(p, out);
    if (
      !$("#modal").classList.contains("hidden") &&
      $("#modalBody [data-view-id]")
    )
      viewPartner(p.id);
    toast(`${p.appId} unbanned - they can sign in again`);
  } catch (err) {
    toast(err.message);
  }
};
function partnerRiderGroups(list) {
  if (!window.PartnerRiders) return [];
  return PartnerRiders.ridersByPartner(
    list,
    rrItemsArray(),
    weeklyStore.rows || [],
  );
}
function partnerRidersButton(p) {
  const g = partnerRiderGroups([p])[0];
  const n = g ? g.counts.total : 0;
  if (!n && !p.portalLogin) return "";
  return `<button class="btn-sm ${n ? "primary" : ""}" onclick="showPartnerRiders('${esc(p.id)}')" title="Riders registered by this ${p.type === "Vendor" ? "vendor" : "franchise"}">🛵 Riders (${n})</button>`;
}
const RIDER_STATUS_CLASS = {
  APPROVED: "success",
  PENDING: "warning",
  REJECTED: "danger",
  BANNED: "danger",
};
const prMoney = (n) =>
  "₹" +
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
function partnerRidersGroupHtml(g) {
  const p = g.partner,
    c = g.counts;
  const kind = p.type === "Vendor" ? "vendor" : "franchise";
  const login = p.portalLogin
    ? `${esc(p.portalLogin.loginId)} · login ${p.portalLogin.ban ? `<b class="error">banned ${esc(banUntilText(p.portalLogin.ban))}</b>` : p.portalLogin.status === "active" ? "active" : "switched off"}`
    : "no portal login yet";
  const head = `<div class="pr-group-head"><div><b>${esc(p.appId)} · ${esc(p.name)}</b> <span class="badge ${p.type === "Vendor" ? "info" : "success"}">${esc(p.type)}</span><div class="muted">${login}${p.city || p.district ? " · " + esc(p.city || p.district) : ""}${p.mobile ? " · " + esc(p.mobile) : ""}</div></div><div class="pr-chips"><span><b>${c.total}</b> rider${c.total === 1 ? "" : "s"}</span><span class="ok"><b>${c.APPROVED || 0}</b> approved</span><span class="wait"><b>${c.PENDING || 0}</b> pending</span><span class="no"><b>${c.REJECTED || 0}</b> rejected</span>${c.total ? `<span><b>${prMoney(g.totals.amount)}</b> total amount</span><button class="btn-sm" onclick="exportPartnerRiders('${esc(p.id)}')">⬇ Export riders</button>` : ""}</div></div>`;
  if (!c.total)
    return `<div class="pr-group">${head}<p class="empty">${p.portalLogin ? `No riders registered by this ${kind} yet.` : "Riders can be registered once the application is approved and the portal login is created."}</p></div>`;
  const rows = g.riders
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td><td><b>${esc(r.riderId)}</b><br><small class="muted">${esc(r.applicationId || "")}</small></td><td>${esc(r.riderName)}</td><td>${esc(r.mobileNumber || "—")}</td><td>${esc(r.hubLocation || "—")}${r.hubPincode ? `<br><small class="muted">${esc(r.hubPincode)}</small>` : ""}</td><td><span class="badge ${RIDER_STATUS_CLASS[r.status] || "info"}">${esc(r.status)}</span></td><td>${esc(r.createdAt ? fmtDate(r.createdAt) : "—")}</td><td>${r.payments ? r.payments.weeks : 0}</td><td>${r.payments ? Number(r.payments.orders).toLocaleString("en-IN") : "—"}</td><td>${r.payments ? prMoney(r.payments.amount) : "—"}${r.payments && r.payments.paid ? `<br><small class="muted">paid ${prMoney(r.payments.paid)}</small>` : ""}</td><td><button class="btn-sm" onclick="closeModal();rrViewDetail('${esc(r.id)}')">View</button></td></tr>`,
    )
    .join("");
  return `<div class="pr-group">${head}<div class="table-wrap"><table class="table"><thead><tr><th>S.No</th><th>Rider ID</th><th>Rider Name</th><th>Mobile</th><th>Hub</th><th>Status</th><th>Registered</th><th>Payment Weeks</th><th>Orders</th><th>Amount</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function paintPartnerRiders(list, term) {
  const card = $("#partnerRidersCard");
  if (!card) return;
  if (!term || !list.length) {
    card.classList.add("hidden");
    card.innerHTML = "";
    return;
  }
  const MAX = 20;
  const groups = partnerRiderGroups(list.slice(0, MAX));
  const riders = groups.reduce((n, g) => n + g.counts.total, 0);
  card.classList.remove("hidden");
  card.innerHTML =
    `<div class="section-head"><div><h3>Riders of matching Vendors / Franchises</h3><p class="muted">${list.length} match${list.length === 1 ? "" : "es"} for "${esc(term)}" · ${riders} rider${riders === 1 ? "" : "s"} registered by ${list.length === 1 ? "this partner" : "them"}${list.length > MAX ? ` · showing the first ${MAX}; type more to narrow the search` : ""}. Payment figures come from the imported Excel (verified riders).</p></div></div>` +
    groups.map(partnerRidersGroupHtml).join("");
}
window.showPartnerRiders = (id) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p) return;
  const g = partnerRiderGroups([p])[0];
  openModal(
    `<h3>Riders of ${esc(p.appId)} · ${esc(p.name)}</h3>${partnerRidersGroupHtml(g)}<div class="modal-actions"><button type="button" class="primary" onclick="closeModal()">Close</button></div>`,
  );
  $("#modal .modal-box")?.classList.add("modal-wide");
};
window.exportPartnerRiders = (id) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p) return;
  if (!window.XLSX)
    return toast(
      "The Excel library did not load. Reload the page and try again.",
    );
  const g = partnerRiderGroups([p])[0];
  const rows = g.riders.map((r, i) => ({
    "S.No": i + 1,
    "Rider ID": r.riderId,
    "Rider Name": r.riderName,
    "Mobile Number": r.mobileNumber || "",
    "Hub Pincode": r.hubPincode || "",
    "Hub Location": r.hubLocation || "",
    Status: r.status,
    "Application ID": r.applicationId || "",
    Registered: r.createdAt
      ? new Date(r.createdAt).toLocaleDateString("en-IN")
      : "",
    "Payment Weeks": r.payments ? r.payments.weeks : 0,
    "Total Orders": r.payments ? r.payments.orders : 0,
    "Total Amount": r.payments ? Math.round(r.payments.amount * 100) / 100 : 0,
    "Paid Amount": r.payments ? Math.round(r.payments.paid * 100) / 100 : 0,
    "Latest Week": r.payments ? r.payments.latest : "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Riders");
  XLSX.writeFile(
    wb,
    `${p.appId}-riders-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
  toast(
    `Exported ${rows.length} rider${rows.length === 1 ? "" : "s"} of ${p.appId}`,
  );
};
function vendorRows(
  list = (Array.isArray(db.partners) ? db.partners : []).filter(
    (p) => p.type === "Vendor",
  ),
) {
  const body = $("#vendorRows");
  if (!body) return;
  body.innerHTML =
    list
      .map(
        (p) =>
          `<tr><td><b>${esc(p.appId)}</b></td><td>${esc(p.name)}</td><td>${esc(p.contact || "")}</td><td>${esc(p.mobile || p.whatsapp || "")}</td><td>${esc(p.street || p.address || "")}${p.locality && p.locality !== (p.street || p.address) ? " · " + esc(p.locality) : ""}</td><td>${esc(p.nearby || p.landmark || "")}</td><td>${esc([p.city || p.district, p.pincode].filter(Boolean).join(" · "))}</td><td>${statusBadge(p.status, p)}</td><td><div class="row-actions">${decisionButtons(p)}${partnerRidersButton(p)}${partnerBanButton(p)}<button class="btn-sm" onclick="viewPartner('${esc(p.id)}')">View form</button><button class="btn-sm" onclick="editPartner('${esc(p.id)}')">✏️ Edit</button></div></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="9" class="empty">No vendor records found.</td></tr>';
}
function franchiseRows(
  list = (Array.isArray(db.partners) ? db.partners : []).filter(
    (p) => p.type === "Franchise",
  ),
) {
  const body = $("#franchiseRows");
  if (!body) return;
  body.innerHTML =
    list
      .map(
        (p) =>
          `<tr><td><b>${esc(p.appId)}</b></td><td>${esc(p.name)}</td><td>${esc(p.contact || "")}</td><td>${esc(p.mobile || p.whatsapp || "")}</td><td>${esc(p.street || p.address || "")}${p.locality && p.locality !== (p.street || p.address) ? " · " + esc(p.locality) : ""}</td><td>${esc(p.nearby || p.landmark || "")}</td><td>${esc([p.city || p.district, p.pincode].filter(Boolean).join(" · "))}</td><td>${statusBadge(p.status, p)}</td><td><div class="row-actions">${decisionButtons(p)}${partnerRidersButton(p)}${partnerBanButton(p)}<button class="btn-sm" onclick="viewPartner('${esc(p.id)}')">View form</button><button class="btn-sm" onclick="editPartner('${esc(p.id)}')">✏️ Edit</button></div></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="9" class="empty">No franchise records found.</td></tr>';
}
function bindClient() {
  const nv = $("#newVendor"),
    nf = $("#newFranchise");
  if (nv) nv.onclick = () => partnerModal({ type: "Vendor" });
  if (nf) nf.onclick = () => partnerModal({ type: "Franchise" });
  const q = $("#clientSearch"),
    sf = $("#clientStatusFilter");
  const apply = () => {
    const term = (q?.value || "").trim().toLowerCase();
    const all = (db.partners || []).filter(statusFilterFn(sf?.value));
    const matches = (list) =>
      !term
        ? list
        : list.filter((p) =>
            [
              p.appId,
              p.type,
              p.name,
              p.contact,
              p.mobile,
              p.whatsapp,
              p.email,
              p.state,
              p.district,
              p.city,
              p.pincode,
              p.status,
              p.address,
              p.street,
              p.locality,
              p.nearby,
              p.landmark,
              p.remarks,
              p.portalLogin?.loginId,
            ]
              .join(" ")
              .toLowerCase()
              .includes(term),
          );
    const vendorList = matches(all.filter((p) => p.type === "Vendor")),
      franchiseList = matches(all.filter((p) => p.type === "Franchise"));
    window.__clientFiltered = { Vendor: vendorList, Franchise: franchiseList };
    vendorRows(vendorList);
    franchiseRows(franchiseList);
    paintPartnerRiders([...vendorList, ...franchiseList], term);
  };
  if (q) q.oninput = apply;
  if (
    !weeklyStore.loading &&
    (!weeklyStore.loadedAt || Date.now() - weeklyStore.loadedAt > 10000)
  )
    loadWeeklyPayments().then(() => {
      if (currentPage === "client" && window.__clientApply)
        window.__clientApply();
    });
  if (sf) sf.onchange = apply;
  window.__clientApply = apply;
  const exportBtn = $("#exportPartnerExcel");
  if (exportBtn)
    exportBtn.onclick = () => exportPartnerRows(activeClientType());
  apply();
  syncPartnerApplications();
  if (typeof rrBindClientPage === "function") rrBindClientPage();
  $$(".tab-btn").forEach(
    (b) =>
      (b.onclick = () => {
        $$(".tab-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const t = b.dataset.clientTab;
        $("#clientVendorPanel")?.classList.toggle("hidden", t !== "vendor");
        $("#clientFranchisePanel")?.classList.toggle(
          "hidden",
          t !== "franchise",
        );
      }),
  );
}
function partners() {
  return (
    layout(
      "Partner Applications",
      "Manage Franchise and Vendor applications.",
      '<button class="primary" id="newPartner">+ New Application</button>',
    ) +
    `<div class="cards">${stat("Total", db.partners.length, "partnerStatTotal")}${stat("Franchise", db.partners.filter((p) => p.type === "Franchise").length, "partnerStatFranchise")}${stat("Vendor", db.partners.filter((p) => p.type === "Vendor").length, "partnerStatVendor")}${stat("Pending", db.partners.filter(isPendingPartner).length, "partnerStatPending")}${stat("Accepted", db.partners.filter((p) => p.status === "Accepted").length, "partnerStatAccepted")}${stat("Rejected", db.partners.filter((p) => p.status === "Rejected").length, "partnerStatRejected")}</div><div class="card"><div class="hub-list-toolbar"><div><h3>Applications</h3><span class="muted">FP = Franchise &nbsp;|&nbsp; VN = Vendor</span></div><div class="partner-filters">${statusFilterSelect("partnerStatusFilter")}<input class="hub-search" id="partnerSearch" placeholder="Search Application ID, name, type, phone, city..." autocomplete="off"></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Application ID</th><th>Type</th><th>Name</th><th>Contact</th><th>Phone</th><th>Location</th><th>Years of Experience</th><th>Status</th><th>Actions</th></tr></thead><tbody id="partnerRows"></tbody></table></div></div>`
  );
}
function partnerRows(list = db.partners) {
  const body = $("#partnerRows");
  if (!body) return;
  body.innerHTML =
    list
      .map(
        (p) =>
          `<tr><td><b>${esc(p.appId)}</b></td><td>${esc(p.type)}</td><td>${esc(p.name)}</td><td>${esc(p.contact || "")}</td><td>${esc(p.mobile || p.whatsapp || "")}</td><td>${esc(p.district || "")}${p.district && p.city ? ", " : ""}${esc(p.city || "")}</td><td>${esc(p.yearsOfExperience || "")}</td><td>${statusBadge(p.status, p)}</td><td><div class="row-actions">${decisionButtons(p)}${partnerRidersButton(p)}${partnerBanButton(p)}<button class="btn-sm" onclick="viewPartner('${esc(p.id)}')">View form</button><button class="btn-sm partner-edit-btn" title="Edit application" onclick="editPartner('${esc(p.id)}')">✏️ Edit</button></div></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="9" class="empty">No applications found.</td></tr>';
}
const PARTNER_API_BASE =
  window.OTW_API_BASE ||
  (location.protocol === "file:" || ["5500", "5501"].includes(location.port)
    ? "http://localhost:8080"
    : location.origin);
let partnerSyncBusy = false,
  partnerSyncFailed = false,
  knownPartnerIds = null,
  partnerPollTimer = null;
const PARTNER_POLL_MS = 30000;
function mapServerPartner(a) {
  return {
    ...a,
    id: a.id,
    appId: a.appId,
    type: a.type === "Vendor" ? "Vendor" : "Franchise",
    name: a.name || a.fullName || "",
    contact: a.contact || a.fullName || "",
    mobile: a.mobile || a.contactNumber || "",
    whatsapp: a.whatsapp || a.whatsappNumber || "",
    email: a.email || a.gmail || "",
    state: a.state || "Andhra Pradesh",
    district: a.district || "",
    city: a.city || a.cityOrVillage || "",
    pincode: a.pincode || "",
    street: a.street || a.locality || "",
    locality: a.locality || a.street || "",
    nearby: a.nearby || a.landmark || "",
    landmark: a.landmark || a.nearby || "",
    education: a.education || a.educationalQualification || "",
    status: a.status === "Approved" ? "Accepted" : a.status || "New",
    address: a.address || a.fullAddress || "",
    remarks: a.remarks || "",
    submittedAt: a.submittedAt || "",
    serverSynced: true,
  };
}
function partnerApi(path = "", options = {}) {
  return fetch(PARTNER_API_BASE + "/api/partner-applications" + path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  }).then((r) => {
    if (r.status === 401) sessionEnded();
    return r;
  });
}
const PARTNER_DECIDED = ["Accepted", "Rejected"];
function isPendingPartner(p) {
  return !PARTNER_DECIDED.includes(p.status);
}
function statusFilterSelect(id) {
  return `<select id="${id}" class="status-filter" aria-label="Filter by status"><option value="">All statuses</option><option value="pending">Pending</option><option value="Accepted">Approved</option><option value="Rejected">Rejected</option></select>`;
}
function statusFilterFn(v) {
  return !v
    ? () => true
    : v === "pending"
      ? isPendingPartner
      : (p) => p.status === v;
}
function decisionButtons(p) {
  if (!isPendingPartner(p)) return "";
  const id = esc(p.id);
  return `<button class="btn-sm accept" onclick="decidePartner('${id}','Accepted')">✓ Approve</button><button class="btn-sm danger" onclick="decidePartner('${id}','Rejected')">✕ Reject</button>`;
}
function fmtDate(v) {
  const d = new Date(v);
  return isNaN(d) ? String(v || "") : d.toLocaleString();
}
window.decidePartner = (id, decision) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p) return;
  const accept = decision === "Accepted",
    undo = decision === "Pending";
  const title = undo
    ? "Undo decision"
    : accept
      ? "Approve application"
      : "Reject application";
  const text = undo
    ? `Move <b>${esc(p.appId)}</b> (${esc(p.name)}) back to <b>Under Review</b>? The current decision (${esc(p.status)}) will be cleared.`
    : `${accept ? "Approve" : "Reject"} the ${esc(p.type)} application <b>${esc(p.appId)}</b> from <b>${esc(p.name)}</b>?`;
  openModal(
    `<h3>${title}</h3><p>${text}</p>${undo ? "" : `<div class="field"><label>${accept ? "Note (optional)" : "Reason for rejection (optional)"}</label><textarea id="decisionNote" rows="3" placeholder="${accept ? "e.g. Documents verified, onboarding call on Monday" : "e.g. Area already covered by another franchise"}"></textarea></div><label class="check decision-notify"><input type="checkbox" id="decisionNotify" checked> Email the applicant${p.email ? ` (${esc(p.email)})` : ""} that the application was ${accept ? "approved, with their portal login" : "rejected"}. The note above is included in the email.</label>`}<div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="button" id="confirmDecision" class="primary ${accept ? "accept-fill" : undo ? "" : "danger-fill"}">${undo ? "Undo decision" : accept ? "✓ Approve" : "✕ Reject"}</button></div>`,
  );
  $("#decisionNote")?.focus();
  $("#confirmDecision").onclick = async () => {
    const btn = $("#confirmDecision"),
      note = ($("#decisionNote")?.value || "").trim();
    btn.disabled = true;
    btn.textContent = "Saving…";
    let creds = null,
      reenabled = false,
      mailResult = null;
    const hadLogin = !!p.portalLogin;
    try {
      if (p.serverSynced) {
        const notify = $("#decisionNotify")
          ? $("#decisionNotify").checked
          : true;
        const r = await partnerApi(
          "/" + encodeURIComponent(p.id) + "/decision",
          { method: "POST", body: JSON.stringify({ decision, note, notify }) },
        );
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || "Server responded " + r.status);
        creds = out.credentials || null;
        reenabled = !!out.loginReenabled;
        mailResult = out.applicantEmail || null;
        const app = out.application || {};
        Object.assign(p, mapServerPartner(app));
        ["decidedBy", "decidedAt", "decisionNote"].forEach((k) => {
          if (!app[k]) delete p[k];
        });
      } else {
        if (undo) {
          p.status = "Under Review";
          delete p.decidedBy;
          delete p.decidedAt;
          delete p.decisionNote;
        } else
          Object.assign(p, {
            status: decision,
            decidedBy: currentUser.email,
            decidedAt: new Date().toISOString(),
            decisionNote: note,
          });
      }
      save();
      refreshPartnerViews();
      if (creds) {
        showCredentials(creds);
        toast(`${p.appId} accepted - portal login created`);
        return;
      }
      closeModal();
      const mailNote = mailResult
        ? mailResult.sent
          ? ` · email sent to ${mailResult.to}`
          : ` · ${mailResult.reason}`
        : "";
      toast(
        (undo
          ? `${p.appId} moved back to Under Review${hadLogin ? " - portal login switched off" : ""}`
          : accept
            ? `${p.appId} accepted${reenabled ? " - their portal login works again" : ""}`
            : `${p.appId} rejected${hadLogin ? " - portal login switched off" : ""}`) +
          mailNote,
      );
    } catch (err) {
      console.warn("Could not save decision:", err);
      btn.disabled = false;
      btn.textContent = undo
        ? "Undo decision"
        : accept
          ? "✓ Accept"
          : "✕ Reject";
      toast(
        "Could not save - the server is not reachable. Start the backend and try again.",
      );
    }
  };
};
function waNumber(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 15 ? d : "";
}
function showCredentials(c, { title = "Portal login created" } = {}) {
  if (!c) return;
  const text = `Hello ${c.name},\nYour On The Way Logistics ${c.portal} login:\n${c.portalUrl}\nID: ${c.loginId}\nTemporary password: ${c.password}\nYou will be asked to choose your own password when you first sign in.`;
  const phone = waNumber(c.phone),
    mail = c.email || {};
  openModal(`<h3>${esc(title)}</h3><p><b>${esc(c.name)}</b> can now sign in to the <b>${esc(c.portal)}</b>.</p>
    <div class="cred-box"><span>Portal</span><b><a href="${esc(c.portalUrl)}" target="_blank" rel="noopener">${esc(c.portalUrl)}</a></b><span>Login ID</span><b>${esc(c.loginId)}</b><span>Temporary password</span><b class="mono" id="credPassword">${esc(c.password)}</b></div>
    <p class="cred-note">This password is shown only once. They must choose their own password the first time they sign in. If it gets lost, use <b>Reset password</b> in View form.</p>
    <div class="cred-email ${mail.sent ? "sent" : "not-sent"}">${mail.sent ? `✓ Email with these login details sent to ${esc(mail.to)}` : `✉ Not emailed: ${esc(mail.reason || "email not available")} Share the details below.`}</div>
    <div class="modal-actions"><button type="button" class="ghost" id="credCopy">📋 Copy details</button>${phone ? `<a class="btn-sm whatsapp" id="credWhatsApp" href="https://wa.me/${phone}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Send on WhatsApp</a>` : ""}<button type="button" class="primary" onclick="closeModal()">Done</button></div>`);
  $("#credCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    toast("Login details copied");
  };
}
window.partnerLogin = async (id) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p) return;
  const isReset = !!p.portalLogin;
  if (
    isReset &&
    !confirm(
      `Give ${p.name} (${p.appId}) a new temporary password? Their current password will stop working and they will be signed out.`,
    )
  )
    return;
  try {
    const r = await partnerApi("/" + encodeURIComponent(id) + "/portal-login", {
      method: "POST",
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return toast(out.error || "Could not create the login");
    Object.assign(p, mapServerPartner(out.application || {}));
    save();
    refreshPartnerViews();
    showCredentials(out.credentials, {
      title: isReset ? "New temporary password" : "Portal login created",
    });
  } catch (err) {
    toast("Could not reach the server. Start the backend and try again.");
  }
};
function badgeLabel(s) {
  return s === "Accepted" || s === "Approved"
    ? "Approved"
    : s === "Rejected"
      ? "Rejected"
      : "Pending";
}
function statusBadge(status, p = null) {
  const s = status || "New";
  const cls =
    s === "Accepted" || s === "Approved"
      ? "success"
      : s === "Rejected"
        ? "danger"
        : s === "New"
          ? "info"
          : "warning";
  const tip =
    p && p.decidedBy
      ? ` title="${esc(s)} by ${esc(p.decidedBy)} on ${esc(fmtDate(p.decidedAt))}${p.decisionNote ? " - " + esc(p.decisionNote) : ""}"`
      : "";
  const ban = p?.portalLogin?.ban;
  if (ban)
    return `<span class="badge ${cls}"${tip}>${esc(badgeLabel(s))}</span> <span class="badge danger" title="Login banned ${esc(banUntilText(ban))}${ban.reason ? " - " + esc(ban.reason) : ""}">🚫 Banned</span>`;
  return `<span class="badge ${cls}"${tip}>${esc(badgeLabel(s))}</span>${p?.portalLogin?.status === "active" && s === "Accepted" ? ' <span class="login-key" title="Portal login active">🔑</span>' : ""}`;
}
function setText(sel, v) {
  const el = $(sel);
  if (el) el.textContent = v;
}
function refreshPartnerViews() {
  const all = Array.isArray(db.partners) ? db.partners : [];
  const fr = all.filter((p) => p.type === "Franchise").length,
    vn = all.filter((p) => p.type === "Vendor").length,
    fresh = all.filter(isPendingPartner).length;
  setText("#clientStatTotal", fr + vn);
  setText("#clientStatVendors", vn);
  setText("#clientStatFranchises", fr);
  setText("#partnerStatTotal", all.length);
  setText("#partnerStatFranchise", fr);
  setText("#partnerStatVendor", vn);
  setText("#partnerStatPending", all.filter(isPendingPartner).length);
  setText(
    "#partnerStatAccepted",
    all.filter((p) => p.status === "Accepted").length,
  );
  setText(
    "#partnerStatRejected",
    all.filter((p) => p.status === "Rejected").length,
  );
  if ($("#partnerRows") && window.__partnerApply) window.__partnerApply();
  if (($("#franchiseRows") || $("#vendorRows")) && window.__clientApply)
    window.__clientApply();
  if ($("#dashNewApps")) setText("#dashNewApps", fresh);
  updatePartnerNavCount();
}
function updatePartnerNavCount() {
  const fresh = (Array.isArray(db.partners) ? db.partners : []).filter(
    isPendingPartner,
  ).length;
  ["partners", "client"].forEach((page) => {
    const btn = document.querySelector(`.nav[data-page="${page}"]`);
    if (!btn) return;
    let b = btn.querySelector(".nav-count");
    if (!fresh) {
      b?.remove();
      return;
    }
    if (!b) {
      b = document.createElement("span");
      b.className = "nav-count";
      btn.appendChild(b);
    }
    b.textContent = fresh;
    b.title =
      fresh +
      " application" +
      (fresh === 1 ? "" : "s") +
      " waiting for Accept / Reject";
  });
}
async function syncPartnerApplications() {
  if (!currentUser?.email || partnerSyncBusy) return;
  partnerSyncBusy = true;
  try {
    const response = await partnerApi();
    if (!response.ok)
      throw new Error("Dashboard API responded " + response.status);
    const mapped = (await response.json()).map(mapServerPartner);
    const ids = new Set(mapped.map((p) => p.id));
    if (knownPartnerIds) {
      const arrived = mapped.filter((p) => !knownPartnerIds.has(p.id));
      if (arrived.length === 1)
        toast(
          `New ${arrived[0].type} application ${arrived[0].appId} from ${arrived[0].name}`,
        );
      else if (arrived.length > 1)
        toast(`${arrived.length} new applications received`);
    }
    knownPartnerIds = ids;
    const localOnly = (db.partners || []).filter(
      (p) => !p.serverSynced && !ids.has(p.id),
    );
    db.partners = [...mapped, ...localOnly];
    save();
    partnerSyncFailed = false;
    refreshPartnerViews();
  } catch (err) {
    console.warn("Could not sync partner applications from backend:", err);
    if (!partnerSyncFailed && ["client", "partners"].includes(currentPage))
      toast(
        "Could not reach the server - start the backend to load website applications",
      );
    partnerSyncFailed = true;
  } finally {
    partnerSyncBusy = false;
  }
}
function startPartnerPolling() {
  stopPartnerPolling();
  knownPartnerIds = null;
  syncPartnerApplications();
  if (typeof rrLoad === "function") rrLoad({ quiet: true });
  if (typeof notifStart === "function") notifStart();
  partnerPollTimer = setInterval(() => {
    syncPartnerApplications();
    if (typeof notifLoad === "function") notifLoad({ quiet: true });
    if (typeof rrLoad === "function") rrLoad({ quiet: true });
    checkPasswordHelpRequests();
    checkSupportTicketsAlert({ notifyOnIncrease: true });
  }, PARTNER_POLL_MS);
}
function stopPartnerPolling() {
  if (typeof notifStop === "function") notifStop();
  if (partnerPollTimer) clearInterval(partnerPollTimer);
  partnerPollTimer = null;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentUser) {
    syncPartnerApplications();
    checkSupportTicketsAlert({ notifyOnIncrease: true });
  }
});
function bindPartners() {
  const b = $("#newPartner");
  if (b) b.onclick = () => partnerModal();
  const q = $("#partnerSearch"),
    sf = $("#partnerStatusFilter");
  const apply = () => {
    const term = (q?.value || "").trim().toLowerCase();
    const base = db.partners.filter(statusFilterFn(sf?.value));
    partnerRows(
      !term
        ? base
        : base.filter((p) =>
            [
              p.appId,
              p.type,
              p.name,
              p.contact,
              p.mobile,
              p.whatsapp,
              p.email,
              p.state,
              p.district,
              p.city,
              p.pincode,
              p.status,
              p.address,
              p.street,
              p.locality,
              p.nearby,
              p.landmark,
              p.remarks,
              p.portalLogin?.loginId,
            ]
              .join(" ")
              .toLowerCase()
              .includes(term),
          ),
    );
  };
  if (q) q.oninput = apply;
  if (sf) sf.onchange = apply;
  window.__partnerApply = apply;
  apply();
  syncPartnerApplications();
}
function partnerModal(p = null) {
  const originalType = p?.type || "Franchise";
  const editing = !!p?.id;
  if (!editing) p = null;
  const appId =
    p?.appId || (editing ? "" : nextPartnerAppId(originalType)) || "";
  openModal(
    `<h3>${editing ? "Edit" : "New"} Partner Application</h3><form id="partnerForm" class="form-grid"><div class="field"><label>Application ID</label><input id="paAppId" value="${esc(editing ? appId : "Assigned when saved")}" readonly></div><div class="field"><label>Partner Type</label><select id="paType"><option ${originalType === "Franchise" ? "selected" : ""}>Franchise</option><option ${originalType === "Vendor" ? "selected" : ""}>Vendor</option></select></div><div class="field"><label>Name / Company</label><input id="paName" required value="${esc(p?.name || "")}"></div><div class="field"><label>Contact Name</label><input id="paContact" value="${esc(p?.contact || "")}"></div><div class="field"><label>Mobile</label><input id="paMobile" value="${esc(p?.mobile || "")}"></div><div class="field"><label>WhatsApp</label><input id="paWhatsapp" value="${esc(p?.whatsapp || "")}"></div><div class="field"><label>Email</label><input id="paEmail" type="email" value="${esc(p?.email || "")}"></div><div class="field"><label>State</label><input id="paState" value="${esc(p?.state || "Andhra Pradesh")}"></div><div class="field"><label>District</label><input id="paDistrict" value="${esc(p?.district || "")}"></div><div class="field"><label>City / Town</label><input id="paCity" value="${esc(p?.city || "")}"></div><div class="field"><label>Street / Locality</label><input id="paStreet" value="${esc(p?.street || "")}"></div><div class="field"><label>Location / Area Name</label><input id="paArea" value="${esc(p?.locationArea || p?.locality || "")}"></div><div class="field"><label>Date of Birth</label><input id="paDob" type="date" value="${esc(p?.dateOfBirth || "")}"></div><div class="field"><label>Years of Experience</label><input id="paYears" type="number" min="0" max="10" step="1" required value="${esc(p?.yearsOfExperience || "")}"></div><div class="field"><label>Near Location / Landmark</label><input id="paNearby" value="${esc(p?.nearby || p?.landmark || "")}"></div><div class="field"><label>Pincode</label><input id="paPin" value="${esc(p?.pincode || "")}"></div><div class="field"><label>Educational Qualification</label><input id="paEdu" value="${esc(p?.education || "")}"></div><div class="field"><label>Status</label><select id="paStatus">${["New", "Contacted", "Under Review", "Documents Pending", "Accepted", "Rejected"].map((x) => `<option ${p?.status === x ? "selected" : ""}>${x}</option>`).join("")}</select></div><div class="field span2"><label>Address</label><textarea id="paAddress">${esc(p?.address || "")}</textarea></div><div class="field span2"><label>Services / Remarks</label><textarea id="paRemarks">${esc(p?.remarks || "")}</textarea></div><div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">${editing ? "Update Application" : "Save Application"}</button></div></form>`,
  );
  const typeEl = $("#paType"),
    idEl = $("#paAppId");
  typeEl.onchange = () => {
    const newType = typeEl.value;
    if (editing && newType === originalType) {
      idEl.value = p.appId;
    } else {
      idEl.value =
        editing && p.serverSynced
          ? "New ID assigned when saved"
          : editing
            ? nextPartnerAppId(newType, p.id)
            : "Assigned when saved";
    }
  };
  $("#partnerForm").onsubmit = async (e) => {
    e.preventDefault();
    const type = typeEl.value;
    const x = {
      type,
      name: $("#paName").value.trim(),
      contact: $("#paContact").value.trim(),
      mobile: $("#paMobile").value.trim(),
      whatsapp: $("#paWhatsapp").value.trim(),
      email: $("#paEmail").value.trim(),
      state: $("#paState").value.trim(),
      district: $("#paDistrict").value.trim(),
      city: $("#paCity").value.trim(),
      pincode: $("#paPin").value.trim(),
      street: $("#paStreet").value.trim(),
      locality: $("#paArea").value.trim(),
      locationArea: $("#paArea").value.trim(),
      dateOfBirth: $("#paDob").value,
      yearsOfExperience: $("#paYears").value.trim(),
      nearby: $("#paNearby").value.trim(),
      landmark: $("#paNearby").value.trim(),
      education: $("#paEdu").value.trim(),
      status: $("#paStatus").value,
      address: $("#paAddress").value,
      remarks: $("#paRemarks").value,
    };
    const backTo = ["client", "partners"].includes(currentPage)
      ? currentPage
      : "client";
    const saveBtn = e.target.querySelector("button.primary");
    if (editing && !p.serverSynced) {
      let newAppId = idEl.value;
      if (type !== originalType) newAppId = nextPartnerAppId(type, p.id);
      Object.assign(p, x, { appId: newAppId });
      normalizePartnerIds();
      save();
      closeModal();
      render(backTo);
      toast("Application updated successfully");
      return;
    }
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
    }
    try {
      const r = editing
        ? await partnerApi("/" + encodeURIComponent(p.id), {
            method: "PATCH",
            body: JSON.stringify(x),
          })
        : await partnerApi("", {
            method: "POST",
            body: JSON.stringify({
              ...x,
              fullName: x.name,
              contactName: x.contact,
            }),
          });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || "Server responded " + r.status);
      const saved = mapServerPartner(out.application || {});
      if (editing) {
        Object.assign(p, saved);
      } else {
        db.partners.unshift(saved);
        knownPartnerIds?.add(saved.id);
      }
      save();
      closeModal();
      render(backTo);
      toast(
        editing
          ? `Application ${saved.appId} updated`
          : `Application ${saved.appId} saved`,
      );
      if (out.credentials) showCredentials(out.credentials);
    } catch (err) {
      console.warn("Could not save application to server:", err);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = editing
          ? "Update Application"
          : "Save Application";
      }
      toast(
        "Could not save - the server is not reachable. Start the backend and try again.",
      );
    }
  };
}
window.editPartner = (id) => {
  const p = db.partners.find((x) => x.id === id);
  if (p) partnerModal(p);
};

function reports() {
  const attendanceEntries = Array.isArray(db.attendance)
    ? db.attendance.length
    : 0;
  return (
    layout(
      "Reports",
      "Export current rider, work, attendance and payment data.",
      '<button class="primary report-download" id="downloadExcel">Download Excel</button>',
    ) +
    `<div class="cards report-stats">
  ${stat("RIDER RECORDS", db.riders.length)}
  ${stat("WORK ENTRIES", db.work.length)}
  ${stat("ATTENDANCE ENTRIES", attendanceEntries)}
  ${stat("PAYMENT ENTRIES", db.payments.length)}
</div>
<div id="rpMount"></div>
<div class="card excel-card"><h3>Excel Integration</h3><p>Import your existing Excel workbook. Rider IDs are used as the unique key. Export creates separate sheets for Riders, Daily Work, Attendance, Documents and Payments.</p><div class="excel-import"><label class="file-picker"><input type="file" id="excelImport" accept=".xlsx,.xls,.csv"> <span>Choose File</span></label><span id="excelName" class="file-name">No file chosen</span></div></div>
`
  );
}
function bindReports() {
  if (window.OTWReports)
    window.OTWReports.mount(document.getElementById("rpMount"));
  $("#excelImport")?.addEventListener("change", (e) => {
    $("#excelName").textContent = e.target.files[0]?.name || "No file chosen";
    if (e.target.files[0])
      toast(
        "Excel file selected. Use Download Excel to export current website data.",
      );
  });
  $("#downloadExcel")?.addEventListener("click", exportExcel);
}
function exportExcel() {
  const escCell = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const table = (name, headers, rows) =>
    `<h2>${escCell(name)}</h2><table border="1"><tr>${headers.map((h) => `<th>${escCell(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((v) => `<td>${escCell(v)}</td>`).join("")}</tr>`).join("")}</table>`;
  const html = `<html><head><meta charset="UTF-8"></head><body>${table(
    "Riders",
    ["Rider Name", "Rider ID", "Phone", "Hub", "Status"],
    db.riders.map((r) => [r.name, r.id, r.phone, r.hub, r.status]),
  )}${table(
    "Daily Work",
    ["Date", "Rider", "Orders", "Work Type", "Notes"],
    db.work.map((w) => [w.date, w.rider, w.orders, w.type, w.notes]),
  )}${table(
    "Attendance",
    ["Date", "Rider", "Status"],
    (db.attendance || []).map((a) => [a.date, a.rider, a.status]),
  )}${table(
    "Documents",
    ["Rider", "Type", "File", "Date"],
    [
      ...adminDocs.map((d) => [
        d.riderName || d.riderId,
        d.type,
        d.name,
        d.createdAt ? new Date(d.createdAt).toLocaleDateString("en-IN") : "",
      ]),
      ...db.documents.map((d) => [d.rider, d.type, d.file, d.date]),
    ],
  )}${table(
    "Payments",
    ["Date", "Rider", "Week", "Amount", "Status"],
    db.payments.map((p) => [p.date, p.rider, p.week, p.amount, p.status]),
  )}</body></html>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([html], { type: "application/vnd.ms-excel" }),
  );
  a.download = "ON_THE_WAY_LOGISTICS_Report.xls";
  a.click();
  toast("Excel report downloaded");
}
function settings() {
  return (
    layout("Settings", "Manage account and local demo data.") +
    `<div class="grid2"><div class="card"><h3>Account</h3><p><b>${esc(currentUser.name)}</b></p><p>${esc(currentUser.email)}</p><form id="adminPwForm" class="pw-form"><h4>Change password</h4><label>Current password<input id="apCurrent" type="password" required autocomplete="current-password"></label><label>New password<input id="apNew" type="password" required minlength="8" autocomplete="new-password"></label><label>Confirm new password<input id="apConfirm" type="password" required minlength="8" autocomplete="new-password"></label><p class="hint">At least 8 characters, with letters and numbers. Other devices will be signed out.</p><p id="apMessage" class="form-message" role="status"></p><button class="primary">Change password</button></form></div><div class="card"><h3>Data</h3><p>Applications, rider registrations, hubs, weekly payments, reports and rider documents are saved on the server and are the same for every admin.</p><p class="hint">Daily Work entries, WhatsApp messages and manual payment adjustments are kept only in this browser. Resetting clears those from this browser; nothing on the server is changed.</p><button class="btn-sm danger" id="clearData">Reset this browser's data</button></div></div>${currentUser.isSuperAdmin ? adminAccountsCardHtml() : ""}`
  );
}
const adminAcct = {
  admins: [],
  mailReady: true,
  loaded: false,
  busy: "",
  message: "",
  error: "",
};
function adminAccountsCardHtml() {
  return `<div class="card" id="adminAccountsCard" style="margin-top:16px"><div class="section-head"><div><h3>Admin Accounts</h3><p class="muted">Only the Super Admin sees this. Edit an admin's name and email, add an admin, send a one-time reset link by email, or give a temporary password (shown once) that the admin must change at the next sign-in.</p></div><div class="actions"><button type="button" class="primary" id="adminAdd">+ Add admin</button></div></div><p id="adminAcctMail" class="form-message error"></p><p id="adminAcctMsg" class="form-message" role="status"></p><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Registered email</th><th>Role</th><th>Status</th><th>Password</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody id="adminAcctRows"><tr><td colspan="7" class="empty">Loading admin accounts…</td></tr></tbody></table></div></div>`;
}
async function adminAcctRequest(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(PARTNER_API_BASE + "/api/admin/accounts" + path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      "The server is not reachable. Check that it is running and try again.",
    );
  }
  let out = {};
  try {
    out = await r.json();
  } catch (e) {}
  if (r.status === 401) {
    sessionEnded();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!r.ok) throw new Error(out.error || "Request failed (" + r.status + ")");
  return out;
}
function adminAcctSay(text, kind) {
  const m = $("#adminAcctMsg");
  if (!m) return;
  m.className = "form-message" + (kind ? " " + kind : "");
  m.textContent = text || "";
}
function paintAdminAccounts() {
  const body = $("#adminAcctRows");
  if (!body) return;
  if (!adminAcct.admins.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="empty">No admin accounts found.</td></tr>';
    return;
  }
  body.innerHTML = adminAcct.admins
    .map((x) => {
      const self = x.loginId === currentUser.loginId,
        active = x.status === "active";
      const help = x.helpRequestedAt
        ? `<br><span class="badge warning" title="Asked on the sign-in page with Forgot password">🔑 Asked for password help ${esc(new Date(x.helpRequestedAt).toLocaleString("en-IN"))}</span>`
        : "";
      return `<tr class="${x.helpRequestedAt ? "acct-help" : ""}"><td><b>${esc(x.name || "—")}</b>${self ? ' <span class="badge">You</span>' : ""}${help}</td><td>${esc(x.email)}</td><td>${x.isSuperAdmin ? '<span class="badge success">Super Admin</span>' : "Admin"}</td><td>${active ? "Active" : '<span class="badge warning">Switched off</span>'}</td><td>${x.mustChangePassword ? '<span class="muted">Temporary - not yet changed</span>' : "Chosen by the admin"}</td><td>${x.lastLoginAt ? esc(new Date(x.lastLoginAt).toLocaleString("en-IN")) : '<span class="muted">Never</span>'}</td><td><div class="mini-actions"><button class="btn-sm" data-act="edit" data-id="${esc(x.loginId)}" title="Change the name or registered email (the email is also the sign-in ID)">Edit</button><button class="btn-sm" data-act="reset" data-id="${esc(x.loginId)}" ${active && adminAcct.mailReady ? "" : "disabled"} title="${adminAcct.mailReady ? "Email a one-time reset link to this admin" : "Reset emails cannot be sent right now (see the message above)"}">Send reset link</button>${self ? "" : `<button class="btn-sm ${x.helpRequestedAt ? "primary" : ""}" data-act="temp" data-id="${esc(x.loginId)}" ${active ? "" : "disabled"} title="Give a temporary password, shown once. Works without email.">Temporary password</button>`}${self ? "" : `<button class="btn-sm ${active ? "danger" : ""}" data-act="${active ? "disable" : "enable"}" data-id="${esc(x.loginId)}">${active ? "Switch off" : "Switch on"}</button>`}</div></td></tr>`;
    })
    .join("");
  const mailNote = $("#adminAcctMail");
  if (mailNote)
    mailNote.textContent = adminAcct.mailReady
      ? ""
      : (adminAcct.mailProblem ||
          "Reset emails cannot be sent from this server right now.") +
        " Meanwhile, use Temporary password; Forgot password requests appear here.";
  updateSettingsNavCount(
    adminAcct.admins.filter((x) => x.helpRequestedAt).length,
  );
}
function updateSettingsNavCount(n) {
  const btn = document.querySelector('.nav[data-page="settings"]');
  if (!btn) return;
  let b = btn.querySelector(".nav-count");
  if (!n) return b?.remove();
  if (!b) {
    b = document.createElement("span");
    b.className = "nav-count";
    btn.appendChild(b);
  }
  b.textContent = n;
  b.title = n + " admin" + (n === 1 ? "" : "s") + " asked for password help";
}
let knownHelpRequests = null;
async function checkPasswordHelpRequests() {
  if (!currentUser?.isSuperAdmin) return;
  try {
    const out = await adminAcctRequest("");
    adminAcct.admins = out.admins || [];
    adminAcct.mailReady = !!out.mailReady;
    adminAcct.mailProblem = out.mailProblem || "";
    const asking = adminAcct.admins.filter((x) => x.helpRequestedAt);
    updateSettingsNavCount(asking.length);
    const keys = asking.map((x) => x.loginId + "@" + x.helpRequestedAt);
    const fresh = knownHelpRequests
      ? keys.filter((k) => !knownHelpRequests.includes(k))
      : keys;
    if (fresh.length)
      toast(
        `${asking.length === 1 ? asking[0].name || asking[0].email : asking.length + " admins"} asked for password help - see Settings > Admin Accounts`,
      );
    knownHelpRequests = keys;
    if (currentPage === "settings") paintAdminAccounts();
  } catch (e) {}
}
function showTemporaryPassword(out, { isNew = false } = {}) {
  const text = `Your On The Way Logistics admin sign-in:\n${location.origin}/dashboard/\nEmail: ${out.email}\nTemporary password: ${out.password}\nYou will be asked to choose your own password when you sign in.`;
  openModal(`<h3>${isNew ? "New admin added: " : "Temporary password for "}${esc(out.name || out.email)}</h3>
    <div class="cred-box"><span>Sign in at</span><b>${esc(location.origin)}/dashboard/</b><span>Email</span><b>${esc(out.email)}</b><span>Temporary password</span><b class="mono" id="tempPassword">${esc(out.password)}</b></div>
    <p class="cred-note">This password is shown only once. Give it to the admin directly (in person or by phone). They must choose their own password when they sign in.${isNew ? "" : " Their other devices were signed out and any older reset link stopped working."}</p>
    <div class="modal-actions"><button type="button" class="ghost" id="tempCopy">📋 Copy details</button><button type="button" class="primary" onclick="closeModal()">Done</button></div>`);
  $("#tempCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    toast("Details copied");
  };
}
async function loadAdminAccounts() {
  try {
    const out = await adminAcctRequest("");
    adminAcct.admins = out.admins || [];
    adminAcct.mailReady = !!out.mailReady;
    adminAcct.mailProblem = out.mailProblem || "";
    adminAcct.loaded = true;
    paintAdminAccounts();
  } catch (e) {
    const body = $("#adminAcctRows");
    if (body)
      body.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`;
  }
}
function adminDetailsModal(x) {
  const isNew = !x;
  openModal(`<h3>${isNew ? "Add admin" : `Edit admin: ${esc(x.name || x.email)}`}</h3>
    <form id="adminDetailsForm" class="form-grid" novalidate>
      <div class="field span2"><label for="adName">Full name *</label><input id="adName" maxlength="100" autocomplete="off" value="${esc(x?.name || "")}" placeholder="e.g. Ravi Kumar"></div>
      <div class="field span2"><label for="adEmail">Email (sign-in ID) *</label><input id="adEmail" type="email" maxlength="254" autocomplete="off" inputmode="email" autocapitalize="none" spellcheck="false" value="${esc(x?.email || "")}" placeholder="name@gmail.com"><small class="hint" id="adEmailHint">${isNew ? "They sign in with this email. A temporary password is shown once after saving." : "They sign in with this email. Their password does not change. If you change the email, reset links sent to the old address stop working."}</small></div>
      <p id="adError" class="form-message error span2" role="alert"></p>
      <div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary" id="adSave">${isNew ? "Add admin" : "Save changes"}</button></div>
    </form>`);
  const emailEl = $("#adEmail"),
    hint = $("#adEmailHint"),
    baseHint = hint.textContent;
  emailEl.oninput = () => {
    const v = emailEl.value.trim();
    hint.textContent =
      v && /@/.test(v) && !/@gmail\.com$/i.test(v)
        ? baseHint +
          " Note: this is not a Gmail address; check it is the admin's correct email."
        : baseHint;
  };
  emailEl.oninput();
  $("#adName").focus();
  $("#adminDetailsForm").onsubmit = async (e) => {
    e.preventDefault();
    const fail = (m, field) => {
      $("#adError").textContent = m;
      if (field === "name") $("#adName").focus();
      if (field === "email") emailEl.focus();
    };
    const name = $("#adName").value.replace(/\s+/g, " ").trim(),
      email = emailEl.value.trim().toLowerCase();
    if (!name) return fail("Enter the admin's full name.", "name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return fail("Enter a valid email address.", "email");
    const btn = $("#adSave");
    btn.disabled = true;
    try {
      if (isNew) {
        const out = await adminAcctRequest("", {
          method: "POST",
          body: { name, email },
        });
        adminAcct.admins = out.admins || adminAcct.admins;
        paintAdminAccounts();
        adminAcctSay(
          `${out.name} (${out.email}) was added as an admin.`,
          "success",
        );
        showTemporaryPassword(out, { isNew: true });
      } else {
        const out = await adminAcctRequest(
          "/" + encodeURIComponent(x.loginId),
          {
            method: "PATCH",
            body: { name, email },
          },
        );
        adminAcct.admins = out.admins || adminAcct.admins;
        if (x.loginId === currentUser.loginId && out.account) {
          currentUser.name = out.account.name;
          currentUser.email = out.account.email;
          currentUser.loginId = out.account.loginId;
          $("#userLabel").textContent = currentUser.name + " • Admin";
        }
        closeModal();
        paintAdminAccounts();
        const changed = out.changes || [];
        adminAcctSay(
          changed.length
            ? `Saved. ${out.account.name} now signs in with ${out.account.email}.`
            : "Nothing was changed.",
          changed.length ? "success" : "",
        );
        toast(changed.length ? "Admin details saved" : "No changes");
      }
    } catch (err) {
      btn.disabled = false;
      fail(err.message, /email/i.test(err.message) ? "email" : "");
    }
  };
}
function bindAdminAccounts() {
  if (!currentUser?.isSuperAdmin || !$("#adminAccountsCard")) return;
  $("#adminAdd")?.addEventListener("click", () => adminDetailsModal(null));
  $("#adminAccountsCard").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const id = b.dataset.id,
      act = b.dataset.act,
      who = (adminAcct.admins.find((x) => x.loginId === id) || {}).email || id;
    if (act === "edit") {
      const x = adminAcct.admins.find((a) => a.loginId === id);
      if (x) adminDetailsModal(x);
      return;
    }
    if (act === "reset" && !confirm(`Send a password reset link to ${who}?`))
      return;
    if (
      act === "temp" &&
      !confirm(
        `Give ${who} a temporary password?\n\nTheir current password stops working, they are signed out everywhere, and they must choose a new password when they sign in.`,
      )
    )
      return;
    if (
      act === "disable" &&
      !confirm(
        `Switch off ${who}? They will be signed out and cannot sign in until you switch them on again.`,
      )
    )
      return;
    b.disabled = true;
    adminAcctSay("");
    try {
      if (act === "reset") {
        const out = await adminAcctRequest(
          "/" + encodeURIComponent(id) + "/send-reset",
          { method: "POST", body: {} },
        );
        adminAcctSay(out.message, "success");
        toast("Reset link sent");
      } else if (act === "temp") {
        const out = await adminAcctRequest(
          "/" + encodeURIComponent(id) + "/temporary-password",
          { method: "POST", body: {} },
        );
        adminAcct.admins = out.admins || adminAcct.admins;
        paintAdminAccounts();
        adminAcctSay(`Temporary password set for ${out.email}.`, "success");
        knownHelpRequests = null;
        showTemporaryPassword(out);
      } else {
        const out = await adminAcctRequest(
          "/" + encodeURIComponent(id) + "/status",
          {
            method: "POST",
            body: { status: act === "disable" ? "disabled" : "active" },
          },
        );
        adminAcct.admins = out.admins || adminAcct.admins;
        paintAdminAccounts();
        adminAcctSay(
          act === "disable" ? "Account switched off." : "Account switched on.",
          "success",
        );
      }
    } catch (err) {
      adminAcctSay(err.message, "error");
    } finally {
      b.disabled = false;
    }
  });
  loadAdminAccounts();
}
function bindSettings() {
  bindAdminAccounts();
  if ($("#adminPwForm"))
    $("#adminPwForm").onsubmit = async (e) => {
      e.preventDefault();
      const m = $("#apMessage");
      m.className = "form-message";
      if ($("#apNew").value !== $("#apConfirm").value) {
        m.textContent = "The two new passwords do not match.";
        m.classList.add("error");
        return;
      }
      const out = await authCall("/change-password", {
        currentPassword: $("#apCurrent").value,
        newPassword: $("#apNew").value,
      }).catch(() => ({ ok: false, error: "Cannot reach the server." }));
      if (!out.ok) {
        m.textContent = out.error || "Could not change the password.";
        m.classList.add("error");
        if (out.status === 401) sessionEnded();
        return;
      }
      e.target.reset();
      m.textContent = "Password changed.";
      m.classList.add("success");
      toast("Password changed");
    };
  if ($("#clearData"))
    $("#clearData").onclick = () => {
      if (
        confirm(
          "Clear the data kept only in this browser (Daily Work, WhatsApp messages, manual payment adjustments)? Server data is not changed.",
        )
      ) {
        db = structuredClone(seed);
        save();
        if (typeof rrLoad === "function") rrLoad({ quiet: true });
        toast("This browser's data was reset");
        render("dashboard");
      }
    };
}

/* ========================= Payment Management ========================= */
function ensurePaymentState() {
  if (!Array.isArray(db.autoPays)) db.autoPays = [];
  if (!Array.isArray(db.paymentTransactions)) db.paymentTransactions = [];
  if (!Array.isArray(db.paymentAudit)) db.paymentAudit = [];
  db.paymentConfig = db.paymentConfig || {
    gateway: "Razorpay",
    mode: "sandbox",
    enabled: false,
    retryCount: 2,
    retryDelayHours: 24,
    reminders: true,
  };
}
ensurePaymentState();
const formatINR = (n) => PaymentExcel.formatINR(n);
const WEEKLY_PAGE_SIZE = 25;
const weeklyStore = {
  rows: [],
  loaded: false,
  loading: false,
  error: "",
  pendingError: "",
  query: "",
  cycle: "all",
  page: 1,
  pageSize: WEEKLY_PAGE_SIZE,
  lastImport: null,
  lastReport: null,
  newImportId: "",
};
async function weeklyRequest(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(PARTNER_API_BASE + "/api/admin/weekly-payments" + path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      "The server is not reachable. Check that it is running and try again.",
    );
  }
  let out = {};
  try {
    out = await r.json();
  } catch (e) {}
  if (r.status === 401) {
    sessionEnded();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!r.ok) throw new Error(out.error || "Request failed (" + r.status + ")");
  return out;
}
async function loadWeeklyPayments() {
  weeklyStore.loading = true;
  weeklyStore.error = "";
  const before = weeklyStore.signature || "";
  try {
    const out = await weeklyRequest("");
    const list = Array.isArray(out)
      ? out
      : out.records || out.items || out.rows || out.data || [];
    weeklyStore.rows = Array.isArray(list) ? list : [];
    weeklyStore.lastImport = out.lastImport || weeklyStore.lastImport;
    weeklyStore.loaded = true;
  } catch (e) {
    weeklyStore.error = e.message;
  }
  weeklyStore.loadedAt = Date.now();
  weeklyStore.signature =
    weeklyStore.rows.length +
    "|" +
    weeklyStore.rows
      .map(
        (r) =>
          `${r.id}:${r.paymentStatus}:${r.amount}:${r.totalOrders}:${r.importedAt}`,
      )
      .join(",");
  const changed = weeklyStore.signature !== before;
  weeklyStore.pendingData = null;
  weeklyStore.pendingError = "";
  weeklyStore.loading = false;
  if (currentPage === "payments") {
    paintWeeklyPayments();
  }
  if (
    changed &&
    currentPage === "dashboard" &&
    !document.querySelector("#modal:not(.hidden)")
  )
    render("dashboard");
}
function addIsoDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number),
    t = new Date(Date.UTC(y, m - 1, d + n));
  return (
    t.getUTCFullYear() +
    "-" +
    String(t.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(t.getUTCDate()).padStart(2, "0")
  );
}
function manualWeeklyRows() {
  const map = new Map();
  db.payments
    .filter((p) => p.source === "Manual Adjustment" || p.source === "Manual")
    .forEach((p) => {
      const iso = p.isoDate || excelDate(p.date) || "",
        ws = iso
          ? PaymentExcel.mondayOf(iso)
          : String(p.week || "").slice(0, 10);
      if (!ws || !p.riderId) return;
      const key = String(p.riderId).toLowerCase() + "|" + ws;
      if (!map.has(key))
        map.set(key, {
          manual: true,
          weekKey: "d:" + ws,
          week:
            PaymentExcel.fmtDMY(ws) +
            " - " +
            PaymentExcel.fmtDMY(addIsoDays(ws, 6)),
          weekStart: ws,
          weekEnd: addIsoDays(ws, 6),
          rider: p.rider || "",
          riderId: p.riderId || "",
          days: 0,
          lm: 0,
          primary: 0,
          club: 0,
          amount: 0,
        });
      const x = map.get(key);
      x.amount += Number(p.amount || 0);
      x.lm += Number(p.lm || 0);
      x.primary += Number(p.primary || 0);
      x.club += Number(p.club || 0);
      x.days += 1;
    });
  return [...map.values()];
}
function weeklyAllRows() {
  return [...weeklyStore.rows, ...manualWeeklyRows()].sort(
    (a, b) =>
      (a.weekStart ? 0 : 1) - (b.weekStart ? 0 : 1) ||
      String(a.weekStart || "").localeCompare(String(b.weekStart || "")) ||
      String(a.sheet || "").localeCompare(String(b.sheet || "")) ||
      (a.rowNumber ?? Infinity) - (b.rowNumber ?? Infinity) ||
      String(a.rider).localeCompare(String(b.rider)),
  );
}
function weeklyFilteredRows() {
  const raw = String(weeklyStore.query || "")
      .trim()
      .toLowerCase(),
    rows = weeklyAllRows().filter(
      (p) =>
        weeklyStore.cycle === "all" ||
        (p.cycle || "weekly") === weeklyStore.cycle,
    );
  if (!raw) return rows;
  const q = normText(raw);
  return rows.filter((p) => {
    const hay = [
      p.rider,
      p.riderId,
      p.week,
      p.weekStart,
      p.weekEnd,
      p.weekStart ? PaymentExcel.fmtDMY(p.weekStart) : "",
      p.weekEnd ? PaymentExcel.fmtDMY(p.weekEnd) : "",
    ]
      .join(" | ")
      .toLowerCase();
    return hay.includes(raw) || (q && normText(hay).includes(q));
  });
}
const NA_CELL = '<span class="muted">—</span>';
const weeklyNum = (v) =>
  v === null || v === undefined || v === ""
    ? NA_CELL
    : Number(v).toLocaleString("en-IN");
const weeklyAmt = (v) =>
  v === null || v === undefined || v === ""
    ? NA_CELL
    : "<b>" + formatINR(v) + "</b>";
const weeklyWeekText = (p) =>
  p.weekStart ? weekLabel(p.weekStart) : p.week || "";
function weeklyPageCount() {
  return Math.max(
    1,
    Math.ceil(
      weeklyFilteredRows().length / (weeklyStore.pageSize || WEEKLY_PAGE_SIZE),
    ),
  );
}
function weeklyPaginationHtml() {
  const total = weeklyFilteredRows().length,
    pages = weeklyPageCount();
  const page = Math.min(Math.max(1, weeklyStore.page || 1), pages);
  const start = total ? (page - 1) * weeklyStore.pageSize + 1 : 0;
  const end = Math.min(page * weeklyStore.pageSize, total);
  return `<nav class="weekly-pagination" aria-label="Payment table pages">
    <span class="weekly-pagination-info">Showing ${start}–${end} of ${total} records</span>
    <div class="weekly-pagination-actions">
      <button type="button" class="btn-sm weekly-page-btn" id="weeklyPageBack" ${page <= 1 ? "disabled" : ""} aria-label="Previous payment page">Back</button>
      <span class="weekly-page-indicator" aria-live="polite">Page ${page} of ${pages}</span>
      <button type="button" class="btn-sm primary weekly-page-btn" id="weeklyPageNext" ${page >= pages ? "disabled" : ""} aria-label="Next payment page">Next</button>
    </div>
  </nav>`;
}
function weeklyRowsHtml() {
  if (!weeklyStore.loaded && !weeklyStore.error)
    return '<tr><td colspan="15" class="empty">Loading weekly payments…</td></tr>';
  if (weeklyStore.error && !weeklyStore.loaded)
    return `<tr><td colspan="15" class="empty">Could not load the weekly payments: ${esc(weeklyStore.error)} <button class="btn-sm" id="weeklyRetry">Try again</button></td></tr>`;
  const rows = weeklyFilteredRows();
  if (!rows.length)
    return `<tr><td colspan="15" class="empty">${weeklyStore.query ? "No matching payment records." : "No weekly payment records yet. Import your Excel file."}</td></tr>`;
  const pages = weeklyPageCount();
  weeklyStore.page = Math.min(Math.max(1, weeklyStore.page || 1), pages);
  const offset = (weeklyStore.page - 1) * weeklyStore.pageSize;
  return rows
    .slice(offset, offset + weeklyStore.pageSize)
    .map((p, i) => {
      const isNew = !!p.importId && p.importId === weeklyStore.newImportId;
      return (
        `<tr${isNew ? ' style="background:rgba(34,139,34,.08)"' : ""}>` +
        `<td>${offset + i + 1}</td>` +
        `<td>${p.riderId ? `<a href="#" class="weekly-rider-link" data-weekly-row="${offset + i}">${esc(p.riderId)}</a>` : NA_CELL}</td>` +
        `<td><a href="#" class="weekly-rider-link" data-weekly-row="${offset + i}">${esc(p.rider)}</a>${p.manual ? ' <span class="badge warning">Manual</span>' : ""}${p.verificationStatus === "PENDING_VERIFICATION" ? ' <span class="badge warning">Pending Verification</span>' : ""}${isNew ? ' <span class="badge success">New</span>' : ""}</td>` +
        `<td>${esc(weeklyWeekText(p))}${p.cycle === "15-day" ? ' <span class="badge info">15-day</span>' : ""}</td>` +
        `<td>${weeklyNum(p.days)}</td>` +
        `<td>${weeklyNum(p.totalOrders)}</td>` +
        `<td>${weeklyNum(p.lm)}</td>` +
        `<td>${weeklyNum(p.primary)}</td>` +
        `<td>${weeklyNum(p.club)}</td>` +
        `<td>${weeklyNum(p.sdd)}</td>` +
        `<td>${weeklyAmt(p.lmAmount)}</td>` +
        `<td>${weeklyAmt(p.primeAmount)}</td>` +
        `<td>${weeklyAmt(p.clubAmount)}</td>` +
        `<td>${weeklyAmt(p.sddAmount)}</td>` +
        `<td>${weeklyAmt(p.amount)}</td>` +
        `</tr>`
      );
    })
    .join("");
}
function weeklyTotalHtml() {
  const rows = weeklyFilteredRows();
  if (!rows.length) return "";
  const riders = new Set(rows.map((p) => p.riderId || normText(p.rider))).size;
  const weeks = new Set(rows.map((p) => p.weekStart || p.week || "")).size;
  const has = (k) =>
    rows.some((p) => p[k] !== null && p[k] !== undefined && p[k] !== "");
  const sum = (k) => rows.reduce((t, p) => t + (Number(p[k]) || 0), 0);
  const cnt = (k) =>
    has(k) ? Number(sum(k)).toLocaleString("en-IN") : NA_CELL;
  const amt = (k) => "<b>" + formatINR(sum(k)) + "</b>";
  return (
    `<tr class="weekly-total" style="font-weight:700;background:#f7f9fc">` +
    `<td colspan="4">All riders: ${riders} · ${weeks} week${weeks === 1 ? "" : "s"}</td><td></td>` +
    `<td>${cnt("totalOrders")}</td>` +
    `<td>${cnt("lm")}</td><td>${cnt("primary")}</td><td>${cnt("club")}</td><td>${cnt("sdd")}</td>` +
    `<td>${amt("lmAmount")}</td><td>${amt("primeAmount")}</td><td>${amt("clubAmount")}</td><td>${amt("sddAmount")}</td>` +
    `<td>${amt("amount")}</td></tr>`
  );
}
function openWeeklyRiderDetails(index) {
  const p = weeklyFilteredRows()[index];
  if (!p) {
    toast("Payment record not found");
    return;
  }
  const cnt = (v) =>
    v === null || v === undefined || v === ""
      ? NA_CELL
      : Number(v).toLocaleString("en-IN");
  const amt = (v) =>
    v === null || v === undefined || v === "" ? NA_CELL : formatINR(v);
  const rate = (v) =>
    v === null || v === undefined || v === ""
      ? NA_CELL
      : "₹" +
        Number(v).toLocaleString("en-IN", { maximumFractionDigits: 4 }) +
        " per order";
  const item = (k, v) => `<div><b>${k}</b><p>${v}</p></div>`;
  openModal(
    `<h3>${esc(p.rider || "")}</h3><p class="muted">${esc(p.riderId || "No Rider ID")} · ${esc(weeklyWeekText(p) || "—")}</p>` +
      `<div class="grid2">${item("Rider ID", p.riderId ? esc(p.riderId) : NA_CELL)}${item("Rider Name", esc(p.rider || "—"))}${item("Week", esc(weeklyWeekText(p) || "—"))}${item("Days", cnt(p.days))}` +
      `${item("Total Orders", cnt(p.totalOrders))}${item("LM Orders", cnt(p.lm))}${item("Prime Orders", cnt(p.primary))}${item("Club Orders", cnt(p.club))}${item("SDD Orders", cnt(p.sdd))}` +
      `${item("LM Rate", rate(p.lmRate))}${item("Prime Rate", rate(p.primeRate))}${item("Club Rate", rate(p.clubRate))}${item("SDD Rate", rate(p.sddRate))}` +
      `${item("LM Amount", amt(p.lmAmount))}${item("Prime Amount", amt(p.primeAmount))}${item("Club Amount", amt(p.clubAmount))}${item("SDD Amount", amt(p.sddAmount))}` +
      `${item("Total Amount (from Excel)", amt(p.amount))}${item("Payment Status", esc(p.paymentStatus || "PENDING"))}${item("Payment Reference / UTR", p.paymentRef ? esc(p.paymentRef) : NA_CELL)}${item("Adjustment Reason", p.adjustmentReason ? esc(p.adjustmentReason) : NA_CELL)}${item("Source file", esc(p.sourceFile || (p.manual ? "Manual adjustment" : "—")))}` +
      `${item("Sheet / row", esc([p.sheet, p.rowNumber].filter(Boolean).join(" · ") || "—"))}${item("Imported", esc(p.importedAt ? new Date(p.importedAt).toLocaleString("en-IN") : "—"))}</div>` +
      `<div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Close</button><button type="button" class="ghost" id="weeklyEditAdjustment">Edit Orders, Amounts &amp; Payment</button>${p.riderId ? '<button type="button" class="primary" id="weeklyOpenRiderProfile">Open Rider Profile</button>' : ""}</div>`,
  );
  $("#weeklyEditAdjustment")?.addEventListener("click", () => {
    closeModal();
    openManualAdjustmentModal(p);
  });
  $("#weeklyOpenRiderProfile")?.addEventListener("click", () => {
    closeModal();
    viewRider(p.riderId);
  });
}

// ---------- Manual Adjustment (Orders, Amounts & Payment Details) ----------
function maNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function maExtractFields(r = {}) {
  const lm = maNum(r.lm, 0);
  const primary = maNum(r.primary ?? r.primaryOrders, 0);
  const club = maNum(r.club, 0);
  const sdd = maNum(r.sdd, 0);
  const totalOrders = maNum(r.totalOrders, lm + primary + club + sdd);

  const lmAmount = maNum(r.lmAmount, 0);
  const primeAmount = maNum(r.primeAmount, 0);
  const clubAmount = maNum(r.clubAmount, 0);
  const sddAmount = maNum(r.sddAmount, 0);
  const amount = maNum(
    r.amount,
    lmAmount + primeAmount + clubAmount + sddAmount,
  );

  return {
    riderId: String(r.riderId ?? ""),
    riderName: String(r.rider ?? r.riderName ?? ""),
    week: String(r.week ?? r.weekLabel ?? ""),
    weekStart: String(r.weekStart ?? ""),
    weekEnd: String(r.weekEnd ?? ""),
    days: maNum(r.days, 0),
    totalOrders,
    lm,
    primary,
    club,
    sdd,
    lmAmount,
    primeAmount,
    clubAmount,
    sddAmount,
    amount,
    paymentStatus: String(r.paymentStatus ?? "PENDING").toUpperCase(),
    paymentRef: String(r.paymentRef ?? ""),
    reason: String(r.adjustmentReason ?? ""),
  };
}

function maPopulateForm(vals) {
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  setVal("maRiderId", vals.riderId);
  setVal("maRiderName", vals.riderName);
  setVal("maWeek", vals.week);
  setVal("maDays", vals.days);
  setVal("maTotalOrders", vals.totalOrders);
  setVal("maLmOrders", vals.lm);
  setVal("maPrimeOrders", vals.primary);
  setVal("maClubOrders", vals.club);
  setVal("maSddOrders", vals.sdd);
  setVal("maTotalAmount", vals.amount);
  setVal("maLmAmount", vals.lmAmount);
  setVal("maPrimeAmount", vals.primeAmount);
  setVal("maClubAmount", vals.clubAmount);
  setVal("maSddAmount", vals.sddAmount);
  setVal("maPaymentStatus", vals.paymentStatus || "PENDING");
  setVal("maPaymentRef", vals.paymentRef);
  setVal("maReason", vals.reason);
}

function openManualAdjustmentModal(preselectedRecord = null) {
  const rows = Array.isArray(weeklyStore?.rows) ? weeklyStore.rows : [];
  const initialId = preselectedRecord?.id ?? rows[0]?.id ?? "";
  const initialRow =
    rows.find((r) => String(r.id) === String(initialId)) ||
    preselectedRecord ||
    {};
  const f0 = maExtractFields(initialRow);

  const optionsHtml = [
    `<option value="">— New / Standalone Adjustment —</option>`,
    ...rows.map((r) => {
      const labelName = r.rider || r.riderName || r.riderId || r.id;
      const labelWeek = r.week || r.weekLabel || "";
      const labelTot = r.amount ?? 0;
      const selected =
        String(r.id) === String(initialRow.id ?? "") ? "selected" : "";
      return `<option value="${esc(r.id)}" ${selected}>${esc(labelName)}${labelWeek ? ` · ${esc(labelWeek)}` : ""} (₹${esc(labelTot)})</option>`;
    }),
  ].join("");

  const statuses = ["PENDING", "PROCESSING", "PAID", "FAILED"]
    .map(
      (st) =>
        `<option value="${st}" ${f0.paymentStatus === st ? "selected" : ""}>${st}</option>`,
    )
    .join("");

  openModal(`
    <h3>Manual Payment, Order &amp; Amount Adjustment</h3>
    <form id="manualAdjustmentForm" class="form-grid">
      <div class="field span2">
        <label for="maRecordSelect">Weekly Payment Row (select an existing row to edit orders, amounts &amp; payment details)</label>
        <select id="maRecordSelect">${optionsHtml}</select>
      </div>

      <div class="field">
        <label for="maRiderId">Rider ID</label>
        <input id="maRiderId" type="text" value="${esc(f0.riderId)}" placeholder="e.g. 2055372">
      </div>
      <div class="field">
        <label for="maRiderName">Rider Name *</label>
        <input id="maRiderName" type="text" required value="${esc(f0.riderName)}" placeholder="Rider full name">
      </div>
      <div class="field">
        <label for="maWeek">Week</label>
        <input id="maWeek" type="text" value="${esc(f0.week)}" placeholder="e.g. 24/08/2026 - 30/08/2026">
      </div>
      <div class="field">
        <label for="maDays">Days</label>
        <input id="maDays" type="number" min="0" max="31" step="1" value="${esc(f0.days)}">
      </div>

      <div class="field">
        <label for="maTotalOrders">Total Orders</label>
        <input id="maTotalOrders" type="number" min="0" step="1" value="${esc(f0.totalOrders)}">
      </div>
      <div class="field">
        <label for="maLmOrders">LM Orders</label>
        <input id="maLmOrders" type="number" min="0" step="1" value="${esc(f0.lm)}">
      </div>
      <div class="field">
        <label for="maPrimeOrders">Prime Orders</label>
        <input id="maPrimeOrders" type="number" min="0" step="1" value="${esc(f0.primary)}">
      </div>
      <div class="field">
        <label for="maClubOrders">Club Orders</label>
        <input id="maClubOrders" type="number" min="0" step="1" value="${esc(f0.club)}">
      </div>
      <div class="field">
        <label for="maSddOrders">SDD Orders</label>
        <input id="maSddOrders" type="number" min="0" step="1" value="${esc(f0.sdd)}">
      </div>

      <div class="field">
        <label for="maTotalAmount">Total Amount (₹) *</label>
        <input id="maTotalAmount" type="number" step="0.01" required value="${esc(f0.amount)}">
      </div>
      <div class="field">
        <label for="maLmAmount">LM Amount (₹)</label>
        <input id="maLmAmount" type="number" step="0.01" value="${esc(f0.lmAmount)}">
      </div>
      <div class="field">
        <label for="maPrimeAmount">Prime Amount (₹)</label>
        <input id="maPrimeAmount" type="number" step="0.01" value="${esc(f0.primeAmount)}">
      </div>
      <div class="field">
        <label for="maClubAmount">Club Amount (₹)</label>
        <input id="maClubAmount" type="number" step="0.01" value="${esc(f0.clubAmount)}">
      </div>
      <div class="field">
        <label for="maSddAmount">SDD Amount (₹)</label>
        <input id="maSddAmount" type="number" step="0.01" value="${esc(f0.sddAmount)}">
      </div>

      <div class="field">
        <label for="maPaymentStatus">Payment Status</label>
        <select id="maPaymentStatus">${statuses}</select>
      </div>
      <div class="field">
        <label for="maPaymentRef">Payment Reference / UTR</label>
        <input id="maPaymentRef" type="text" value="${esc(f0.paymentRef)}" placeholder="e.g. UTR / bank / payout ref">
      </div>
      <div class="field span2">
        <label for="maReason">Adjustment Reason / Note</label>
        <input id="maReason" type="text" value="${esc(f0.reason)}" placeholder="e.g. Order count update, bonus, or payment correction">
      </div>

      <p id="maError" class="field-error span2" role="alert"></p>
      <div class="modal-actions span2">
        <button type="button" class="ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="primary" id="maSaveBtn">Save Adjustment</button>
      </div>
    </form>
  `);

  let manualOrdersOverride = false;
  let manualAmountOverride = false;

  const selectEl = document.getElementById("maRecordSelect");
  selectEl?.addEventListener("change", () => {
    manualOrdersOverride = false;
    manualAmountOverride = false;
    const picked = rows.find((r) => String(r.id) === String(selectEl.value));
    maPopulateForm(maExtractFields(picked || {}));
  });

  document.getElementById("maTotalOrders")?.addEventListener("input", () => {
    manualOrdersOverride = true;
  });
  ["maLmOrders", "maPrimeOrders", "maClubOrders", "maSddOrders"].forEach(
    (id) => {
      document.getElementById(id)?.addEventListener("input", () => {
        if (manualOrdersOverride) return;
        const sum =
          maNum(document.getElementById("maLmOrders")?.value, 0) +
          maNum(document.getElementById("maPrimeOrders")?.value, 0) +
          maNum(document.getElementById("maClubOrders")?.value, 0) +
          maNum(document.getElementById("maSddOrders")?.value, 0);
        const totEl = document.getElementById("maTotalOrders");
        if (totEl) totEl.value = String(sum);
      });
    },
  );

  document.getElementById("maTotalAmount")?.addEventListener("input", () => {
    manualAmountOverride = true;
  });
  ["maLmAmount", "maPrimeAmount", "maClubAmount", "maSddAmount"].forEach(
    (id) => {
      document.getElementById(id)?.addEventListener("input", () => {
        if (manualAmountOverride) return;
        const sum =
          maNum(document.getElementById("maLmAmount")?.value, 0) +
          maNum(document.getElementById("maPrimeAmount")?.value, 0) +
          maNum(document.getElementById("maClubAmount")?.value, 0) +
          maNum(document.getElementById("maSddAmount")?.value, 0);
        const totEl = document.getElementById("maTotalAmount");
        if (totEl) totEl.value = sum.toFixed(2);
      });
    },
  );

  document
    .getElementById("manualAdjustmentForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("maError");
      const saveBtn = document.getElementById("maSaveBtn");
      if (errEl) errEl.textContent = "";

      const recordId = (selectEl?.value || "").trim();
      const riderId = (
        document.getElementById("maRiderId")?.value || ""
      ).trim();
      const riderName = (
        document.getElementById("maRiderName")?.value || ""
      ).trim();
      const week = (document.getElementById("maWeek")?.value || "").trim();
      const days = maNum(document.getElementById("maDays")?.value, 0);
      const totalOrders = maNum(
        document.getElementById("maTotalOrders")?.value,
        0,
      );
      const lm = maNum(document.getElementById("maLmOrders")?.value, 0);
      const primary = maNum(document.getElementById("maPrimeOrders")?.value, 0);
      const club = maNum(document.getElementById("maClubOrders")?.value, 0);
      const sdd = maNum(document.getElementById("maSddOrders")?.value, 0);

      const amount = maNum(
        document.getElementById("maTotalAmount")?.value,
        NaN,
      );
      const lmAmount = maNum(document.getElementById("maLmAmount")?.value, 0);
      const primeAmount = maNum(
        document.getElementById("maPrimeAmount")?.value,
        0,
      );
      const clubAmount = maNum(
        document.getElementById("maClubAmount")?.value,
        0,
      );
      const sddAmount = maNum(document.getElementById("maSddAmount")?.value, 0);
      const paymentStatus = (
        document.getElementById("maPaymentStatus")?.value || "PENDING"
      ).toUpperCase();
      const paymentRef = (
        document.getElementById("maPaymentRef")?.value || ""
      ).trim();
      const reason = (document.getElementById("maReason")?.value || "").trim();

      if (!riderName) {
        if (errEl) errEl.textContent = "Rider Name is required.";
        return;
      }
      if (!Number.isFinite(amount)) {
        if (errEl) errEl.textContent = "Enter a valid Total Amount.";
        return;
      }

      if (saveBtn) saveBtn.disabled = true;
      try {
        await weeklyRequest("/adjustments", {
          method: "POST",
          body: {
            recordId: recordId || undefined,
            riderId,
            riderName,
            week,
            days,
            totalOrders,
            lm,
            primary,
            club,
            sdd,
            lmAmount,
            primeAmount,
            clubAmount,
            sddAmount,
            amount,
            paymentStatus,
            paymentRef,
            reason,
          },
        });
        closeModal();
        await loadWeeklyPayments();
        toast("Manual adjustment saved");
      } catch (err) {
        if (errEl)
          errEl.textContent = err.message || "Could not save adjustment.";
        if (saveBtn) saveBtn.disabled = false;
      }
    });
}
window.openManualAdjustmentModal = openManualAdjustmentModal;

function paintWeeklyPayments() {
  const body = $("#paymentWeeklyRows");
  if (!body) return;
  body.innerHTML = weeklyRowsHtml();
  const foot = $("#paymentWeeklyTotal");
  if (foot) foot.innerHTML = weeklyTotalHtml();
  const pager = $("#weeklyPagination");
  if (pager) pager.innerHTML = weeklyPaginationHtml();
  body.querySelectorAll(".weekly-rider-link").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openWeeklyRiderDetails(Number(a.dataset.weeklyRow));
    }),
  );
  $("#weeklyRetry")?.addEventListener("click", () => {
    weeklyStore.error = "";
    paintWeeklyPayments();
    loadWeeklyPayments();
  });
  $("#weeklyPageBack")?.addEventListener("click", () => {
    if (weeklyStore.page > 1) {
      weeklyStore.page--;
      paintWeeklyPayments();
    }
  });
  $("#weeklyPageNext")?.addEventListener("click", () => {
    if (weeklyStore.page < weeklyPageCount()) {
      weeklyStore.page++;
      paintWeeklyPayments();
    }
  });
}
function payments() {
  ensurePaymentState();
  if (currentUser.role !== "admin")
    return (
      layout("Payments", "Payment details are restricted to admin access.") +
      `<div class="card"><div class="empty">Only administrators can view payment details.</div></div>`
    );
  return (
    layout(
      "Payment Management",
      "Excel rider payments and one-time payment records.",
      `<label class="primary file-picker payment-import-btn"><input type="file" id="paymentExcelImport" accept=".xlsx,.xls" hidden>📥 Import Excel</label><button class="ghost" id="addPayment">+ Manual Adjustment</button>`,
    ) +
    `<div class="card"><div class="section-head"><div><h3>Weekly Payments — Excel Automatic</h3><p class="muted">Everything here is read from the imported Excel sheet and saved on the server, so it stays after you refresh. Total Amount is the amount column of the sheet.</p></div><select class="search" id="paymentCycle" aria-label="Payment cycle" style="max-width:160px;width:100%"><option value="all">All cycles</option><option value="weekly">Weekly</option><option value="15-day">15-day</option></select><input class="search" id="paymentWeeklySearch" type="search" placeholder="Search rider name, rider ID or week..." aria-label="Search weekly payments" value="${esc(weeklyStore.query)}" autocomplete="off" style="max-width:340px;width:100%"></div><div class="table-wrap"><table class="table"><thead><tr><th>S.NO</th><th>RIDER ID</th><th>RIDER NAME</th><th>WEEK</th><th>DAYS</th><th>TOTAL ORDERS</th><th>LM ORDERS</th><th>PRIME ORDERS</th><th>CLUB ORDERS</th><th>SDD ORDERS</th><th>LM AMOUNT</th><th>PRIME AMOUNT</th><th>CLUB AMOUNT</th><th>SDD AMOUNT</th><th>TOTAL AMOUNT</th></tr></thead><tbody id="paymentWeeklyRows">${weeklyRowsHtml()}</tbody><tfoot id="paymentWeeklyTotal">${weeklyTotalHtml()}</tfoot></table></div><div id="weeklyPagination">${weeklyPaginationHtml()}</div><p id="paymentSearchEmpty" class="empty" style="display:none">No matching payment records.</p></div>`
  );
}
function bindPayments() {
  ensurePaymentState();
  const paymentSearch = $("#paymentWeeklySearch");
  const paymentCycle = $("#paymentCycle");
  if (paymentCycle) {
    paymentCycle.value = weeklyStore.cycle;
    paymentCycle.addEventListener("change", () => {
      weeklyStore.cycle = paymentCycle.value;
      weeklyStore.page = 1;
      paintWeeklyPayments();
    });
  }
  paymentSearch?.addEventListener("input", () => {
    weeklyStore.query = paymentSearch.value;
    weeklyStore.page = 1;
    paintWeeklyPayments();
  });
  $("#addPayment")?.addEventListener("click", (e) => {
    e.preventDefault();
    openManualAdjustmentModal();
  });
  loadWeeklyPayments();
  $("#paymentExcelImport")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await importPaymentsExcel(file);
    e.target.value = "";
  });
}
window.downloadPartnerDocument = async (
  applicationId,
  documentId,
  fileName,
) => {
  try {
    const response = await fetch(
      PARTNER_API_BASE +
        `/api/partner-applications/${encodeURIComponent(applicationId)}/documents/${encodeURIComponent(documentId)}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      let message = "Document download failed.";
      try {
        message = (await response.json()).error || message;
      } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "applicant-document";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message || "Could not download document.");
  }
};

window.viewPartner = (id) => {
  const p = (db.partners || []).find((x) => x.id === id);
  if (!p) return;
  const labels = {
    decisionNote: "Decision Note",
    decidedBy: "Decided By",
    decidedAt: "Decided At",
    updatedBy: "Last Updated By",
    updatedAt: "Last Updated",
    fullName: "Full Name",
    dob: "Date of Birth",
    gmail: "Email Address",
    contactNumber: "Mobile Number",
    whatsappNumber: "WhatsApp Number",
    cityOrVillage: "City / Location",
    location: "Location / Area",
    locationArea: "Location / Area Name",
    dateOfBirth: "Date of Birth",
    yearsOfExperience: "Years of Experience",
    fullAddress: "Full Address",
    address: "Full Address",
    experience: "Experience",
    companyName: "Company / Business Name",
    businessName: "Business Name",
    businessType: "Business Type",
    vehicleDetails: "Vehicle Details",
    investmentCapacity: "Investment Capacity",
    preferredLocation: "Preferred Franchise Location",
    additionalMessage: "Additional Message",
    additionalInfo: "Additional Information",
    ownerName: "Owner Name",
    submittedAt: "Submitted At",
    appId: "Application ID",
    type: "Application Type",
    status: "Status",
    pincode: "PIN Code",
    district: "District",
    state: "State",
  };
  const skip = new Set([
    "portalLogin",
    "documents",
    "emailLog",
    "banLog",
    "decisionNote",
    "decidedBy",
    "decidedAt",
    "id",
    "portalType",
    "serverSynced",
    "name",
    "contact",
    "mobile",
    "whatsapp",
    "email",
    "city",
    "street",
    "locality",
    "nearby",
    "landmark",
    "education",
    "remarks",
    "gstNumber",
    "panNumber",
    "serviceType",
  ]);
  const pretty = (k) =>
    k === "fullAddress" && p.type === "Vendor"
      ? "Complete Business Address"
      : k === "experience" && p.type === "Franchise"
        ? "Previous Business Experience"
        : labels[k] ||
          k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  const order = ["appId", "type", "status", "submittedAt"];
  if (p.fullAddress && p.fullAddress === p.address) skip.add("address");
  const keys = [
    ...order.filter((k) => p[k]),
    ...Object.keys(p).filter(
      (k) => !order.includes(k) && !skip.has(k) && p[k] !== "" && p[k] != null,
    ),
  ];
  const rows = keys
    .map(
      (k) =>
        `<div class="field"><label>${esc(pretty(k))}</label><div>${esc(["submittedAt", "updatedAt", "decidedAt"].includes(k) ? fmtDate(p[k]) : String(p[k]))}</div></div>`,
    )
    .join("");
  const pid = esc(p.id);
  const decided = !isPendingPartner(p);
  const decisionBox = decided
    ? `<div class="decision-box ${p.status === "Accepted" ? "accepted" : "rejected"}"><b>${p.status === "Accepted" ? "✓ Approved" : "✕ Rejected"}</b>${p.decidedBy ? ` by ${esc(p.decidedBy)}` : ""}${p.decidedAt ? ` on ${esc(fmtDate(p.decidedAt))}` : ""}${p.decisionNote ? `<div>${esc(p.decisionNote)}</div>` : ""}</div>`
    : `<div class="decision-box pending"><b>Waiting for decision</b> - current status: ${esc(p.status || "New")}</div>`;
  const actions = decided
    ? `<button type="button" class="ghost" onclick="decidePartner('${pid}','Pending')">↺ Undo decision</button>`
    : `<button type="button" class="primary accept-fill" onclick="decidePartner('${pid}','Accepted')">✓ Approve</button><button type="button" class="primary danger-fill" onclick="decidePartner('${pid}','Rejected')">✕ Reject</button>`;
  const lg = p.portalLogin;
  const loginState = lg
    ? lg.status !== "active"
      ? "switched off"
      : lg.mustChangePassword
        ? '<span class="muted">created - waiting for their first sign-in</span>'
        : "active" +
          (lg.lastLoginAt
            ? ` <span class="muted">· last sign-in ${esc(fmtDate(lg.lastLoginAt))}</span>`
            : "")
    : '<span class="muted">not created yet</span>';
  const loginBox = !p.serverSynced
    ? ""
    : p.status === "Accepted"
      ? `<div class="login-box"><div><b>${p.type === "Vendor" ? "Vendor" : "Franchise"} Portal login:</b> ${lg ? esc(lg.loginId) + " · " : ""}${loginState}</div><button type="button" class="btn-sm" onclick="partnerLogin('${pid}')">🔑 ${lg ? "Reset password" : "Create login"}</button></div>`
      : lg
        ? `<div class="login-box"><div><b>Portal login:</b> ${esc(lg.loginId)} · switched off while the application is ${esc(p.status)}</div></div>`
        : "";
  const banLog = Array.isArray(p.banLog) ? p.banLog : [];
  const ban = p.portalLogin?.ban;
  const banBox =
    !p.serverSynced || (!p.portalLogin && !banLog.length)
      ? ""
      : `<div class="ban-box ${ban ? "banned" : ""}"><div>${ban ? `<b>🚫 Login banned ${esc(banUntilText(ban))}</b>${ban.by ? ` · by ${esc(ban.by)}` : ""}${ban.since ? ` on ${esc(fmtDate(ban.since))}` : ""}${ban.reason ? `<div>Reason: ${esc(ban.reason)}</div>` : ""}` : "<b>Portal login not banned</b>"}${
          banLog.length
            ? `<ul>${banLog
                .slice()
                .reverse()
                .slice(0, 10)
                .map(
                  (b) =>
                    `<li>${b.action === "banned" ? "🚫 Banned" : "✓ Unbanned"} · ${esc(fmtDate(b.at))} · ${esc(b.by || "")}${b.action === "banned" ? ` · ${esc(b.until ? "until " + fmtDate(b.until) : "until unbanned")}${b.reason ? " · " + esc(b.reason) : ""}` : ""}</li>`,
                )
                .join("")}</ul>`
            : ""
        }</div>${p.portalLogin ? (ban ? `<button type="button" class="btn-sm accept" onclick="unbanPartner('${pid}')">✓ Unban</button>` : `<button type="button" class="btn-sm danger" onclick="banPartner('${pid}')">🚫 Ban login</button>`) : ""}</div>`;
  const EMAIL_KIND = {
    submitted: "Application submitted",
    approved: "Application approved",
    rejected: "Application rejected",
    login_created: "Portal login created",
    new_password: "New temporary password",
  };
  const emailLog = Array.isArray(p.emailLog) ? p.emailLog : [];
  const documentBox =
    Array.isArray(p.documents) && p.documents.length
      ? `<div class="email-log"><b>Applicant Documents</b><ul>${p.documents.map((d) => `<li>${esc(d.type)} · ${esc(d.name)} · ${(Number(d.size || 0) / 1024).toFixed(1)} KB <button type="button" class="btn-sm" onclick="downloadPartnerDocument('${pid}','${esc(d.id)}','${esc(d.name)}')">⬇ Download</button></li>`).join("")}</ul></div>`
      : `<div class="email-log"><b>Applicant Documents</b><span class="muted">No documents uploaded.</span></div>`;
  const emailBox = p.serverSynced
    ? `<div class="email-log"><b>Emails to the applicant</b>${
        emailLog.length
          ? `<ul>${emailLog
              .slice()
              .reverse()
              .map(
                (m) =>
                  `<li class="${m.sent ? "sent" : "not-sent"}">${m.sent ? "✓" : "✕"} ${esc(EMAIL_KIND[m.kind] || m.kind)} · ${esc(fmtDate(m.at))} · ${m.sent ? `sent to ${esc(m.to)}` : `not sent: ${esc(m.reason)}`}</li>`,
              )
              .join("")}</ul>`
          : `<span class="muted"> None yet.${p.source === "Admin panel" ? " (Applications entered in the admin panel get no submission email.)" : ""}</span>`
      }</div>`
    : "";
  openModal(
    `<h3 data-view-id="${pid}">${esc(p.type)} Application Form - ${esc(p.name || "")}</h3>${decisionBox}${loginBox}${banBox}${documentBox}${emailBox}<div class="form-grid">${rows}</div><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Close</button>${actions}</div>`,
  );
};

{
  const showForm = window.viewPartner;
  window.viewPartner = (id) => {
    showForm(id);
    Promise.resolve(syncPartnerApplications()).then(() => {
      if (
        !$("#modal").classList.contains("hidden") &&
        $('#modalBody h3[data-view-id="' + CSS.escape(id) + '"]')
      )
        showForm(id);
    });
  };
}

/* ========================= Rider member registrations (Admin) ========================= */
let rrItems = [];
let rrObjectUrl = null;
const RR_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const RR_MAX_BYTES = 5 * 1024 * 1024;
const RR_STATUS_CLASS = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  BANNED: "danger",
};
const RR_FORM_FIELD = {
  riderId: "rrId",
  riderName: "rrName",
  mobile: "rrMobile",
  hubPincode: "rrPin",
  hubLocation: "rrHub",
  selfie: "rrSelfie",
  aadhaar: "rrAadhaar",
};
function rrApiUrl(path = "") {
  return PARTNER_API_BASE + "/api/rider-registrations" + path + "?portal=admin";
}
function rrIsBanned(r) {
  const status = String(r?.status || "").toUpperCase();
  return status === "BANNED" || !!(r?.banned || r?.isBanned);
}
function rrExtractItem(out) {
  if (!out || typeof out !== "object") return null;
  const candidate = out.item || out.registration || out.data || null;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const status = String(candidate.status || "PENDING").toUpperCase();
    return {
      ...candidate,
      id: candidate.id || candidate._id || "",
      applicationId: candidate.applicationId || candidate.application_id || "",
      riderId: candidate.riderId || candidate.rider_id || "",
      riderName: candidate.riderName || candidate.rider_name || "",
      mobileNumber:
        candidate.mobileNumber ||
        candidate.mobile_number ||
        candidate.mobile ||
        "",
      hubPincode: candidate.hubPincode || candidate.hub_pincode || "",
      hubLocation: candidate.hubLocation || candidate.hub_location || "",
      status,
      banned: status === "BANNED" || !!(candidate.banned || candidate.isBanned),
      createdAt: candidate.createdAt || candidate.created_at || "",
    };
  }
  return null;
}
function rrExtractList(out) {
  const raw = Array.isArray(out)
    ? out
    : Array.isArray(out?.items)
      ? out.items
      : Array.isArray(out?.registrations)
        ? out.registrations
        : Array.isArray(out?.rows)
          ? out.rows
          : Array.isArray(out?.data)
            ? out.data
            : [];
  return raw.map((item) => rrExtractItem({ item })).filter(Boolean);
}
function rrStatusBadge(s) {
  return `<span class="badge ${RR_STATUS_CLASS[s] || "info"}">${esc(s)}</span>`;
}
function rrDate(v) {
  const d = new Date(v);
  return isNaN(d)
    ? ""
    : d.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function rrSize(n) {
  return n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(n / 1024)) + " KB";
}
function rrCleanMobile(value) {
  let d = String(value || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}
function rrCheckFields(v) {
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{1,39}$/.test(v.id))
    return [
      "rrId",
      "Rider ID must be 2 to 40 letters, numbers, dashes or slashes, with no spaces.",
    ];
  if (!v.name) return ["rrName", "Enter the rider name."];
  if (/\d/.test(v.name))
    return ["rrName", "The rider name cannot contain numbers."];
  if (
    !/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(v.name) ||
    (v.name.match(/\p{L}/gu) || []).length < 2
  )
    return [
      "rrName",
      "The rider name can only contain letters, spaces and . ' -",
    ];
  if (!rrCleanMobile(v.mobile))
    return [
      "rrMobile",
      "Enter a 10-digit mobile number starting with 6, 7, 8 or 9.",
    ];
  if (!/^[1-9]\d{5}$/.test(v.pin))
    return ["rrPin", "Enter the 6-digit hub pincode."];
  if (v.hub.length < 2) return ["rrHub", "Enter the hub location."];
  return null;
}
async function rrCall(url, { method = "GET", body } = {}) {
  const isForm = body instanceof FormData;
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: body && !isForm ? { "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  let out = {};
  try {
    out = await r.json();
  } catch (e) {}
  if (r.status === 401) {
    sessionEnded();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!r.ok) {
    const err = new Error(out.error || "Request failed (" + r.status + ")");
    err.field = out.field || "";
    throw err;
  }
  return out;
}
function syncRegisteredRiders() {
  if (!Array.isArray(db.hiddenRegistrations)) db.hiddenRegistrations = [];
  let changed = false;
  const lower = (v) =>
    String(v ?? "")
      .trim()
      .toLowerCase();
  for (const reg of rrItemsArray()) {
    const rid = String(reg.riderId || "").trim();
    if (!rid || db.hiddenRegistrations.includes(reg.id)) continue;
    let r =
      db.riders.find((x) => x.registrationId === reg.id) ||
      db.riders.find((x) => lower(x.id) === lower(rid));
    if (reg.status !== "APPROVED") {
      if (
        r &&
        r.registrationId === reg.id &&
        (reg.status === "REJECTED" || reg.status === "BANNED") &&
        r.status !== "Inactive"
      ) {
        r.status = "Inactive";
        changed = true;
      }
      continue;
    }
    if (!r) {
      const key = normRiderMasterName(reg.riderName);
      const prov = db.riders.filter(
        (x) => x.provisional && normRiderMasterName(x.name) === key,
      );
      if (prov.length === 1) r = prov[0];
    }
    const next = {
      id: rid,
      name: reg.riderName,
      phone: reg.mobileNumber || "",
      location: reg.hubLocation || "",
      hub: reg.hubLocation || "",
      hubPincode: reg.hubPincode || "",
      registrationId: reg.id,
      appliedBy: reg.appliedBy || "",
      ownerLoginId: reg.ownerLoginId || "",
      ownerName: reg.ownerName || "",
      provisional: false,
    };
    if (!r) {
      db.riders.push({ ...next, status: "Active", weekly: 0, notes: "" });
      changed = true;
      continue;
    }
    const oldId = String(r.id);
    if (
      r.registrationId !== reg.id ||
      r.provisional ||
      r.status === "Pending Verification" ||
      r.status === "Inactive"
    ) {
      next.status = "Active";
    }
    for (const [k, v] of Object.entries(next))
      if (r[k] !== v) {
        r[k] = v;
        changed = true;
      }
    if (oldId !== rid)
      for (const list of [db.work, db.payments, db.documents])
        if (Array.isArray(list))
          for (const item of list) {
            if (item.riderId === oldId) item.riderId = rid;
            if (item.rider_id === oldId) item.rider_id = rid;
          }
  }
  if (changed) {
    save();
    if (
      ["dashboard", "riders", "documents"].includes(currentPage) &&
      !document.querySelector("#modal:not(.hidden)")
    )
      render(currentPage);
  }
  return changed;
}
let rrKnownPending = null;
function announceNewPartnerRiders() {
  const pending = rrItemsArray().filter((r) => r && r.status === "PENDING");
  const fresh = rrKnownPending
    ? pending.filter((r) => !rrKnownPending.has(r.id) && r.ownerLoginId)
    : [];
  rrKnownPending = new Set(pending.map((r) => r.id));
  if (!fresh.length) return;
  const r = fresh[0];
  toast(
    fresh.length === 1
      ? `New rider ${r.riderName} (${r.riderId}) added by ${r.appliedBy} ${r.ownerLoginId} - waiting for approval on the Riders page`
      : `${fresh.length} new riders added by Vendors / Franchises - waiting for approval on the Riders page`,
  );
}
async function rrLoad({ quiet = false } = {}) {
  if (!currentUser) return;
  try {
    const out = await rrCall(rrApiUrl());
    const before = rrPendingCount();
    rrItems = rrExtractList(out);
    announceNewPartnerRiders();
    rrRender();
    if (
      currentPage === "dashboard" &&
      before !== rrPendingCount() &&
      !document.querySelector("#modal:not(.hidden)")
    )
      render("dashboard");
    syncRegisteredRiders();
    if (currentPage === "client" && window.__clientApply)
      window.__clientApply();
  } catch (e) {
    if (!quiet)
      toast(
        "Could not load rider registrations: " +
          (e.message === "Failed to fetch"
            ? "the server is not reachable."
            : e.message),
      );
  }
}
function rrFilters() {
  const val = (id) =>
    (document.getElementById(id)?.value || "").trim().toLowerCase();
  return {
    id: val("regFilterId"),
    name: val("regFilterName"),
    hub: val("regFilterHub"),
    status: document.getElementById("regFilterStatus")?.value || "",
  };
}
function rrRender() {
  updateRiderNavCount();
  paintPendingRiders();
  const body = document.getElementById("regRows");
  if (!body) return;
  const items = rrItemsArray().filter(
    (r) => r && r.id && (r.riderId || r.riderName || r.applicationId),
  );
  const count = (s) => items.filter((r) => r && r.status === s).length;
  const stats = {
    regStatTotal: items.length,
    regStatPending: count("PENDING"),
    regStatApproved: count("APPROVED"),
    regStatRejected: count("REJECTED"),
  };
  for (const k of Object.keys(stats)) {
    const el = document.getElementById(k);
    if (el) el.textContent = stats[k];
  }
  const f = rrFilters();
  const list = items.filter(
    (r) =>
      (!f.id ||
        String(r.riderId || "")
          .toLowerCase()
          .includes(f.id)) &&
      (!f.name ||
        String(r.riderName || "")
          .toLowerCase()
          .includes(f.name)) &&
      (!f.hub ||
        String(r.hubLocation || "")
          .toLowerCase()
          .includes(f.hub)) &&
      (!f.status || r.status === f.status),
  );
  body.innerHTML = list.map(rrRow).join("");
  const empty = document.getElementById("regEmpty");
  if (empty) {
    empty.textContent = items.length
      ? "No rider registrations match these filters."
      : "No rider registrations yet. Use “+ Add New Member” on the Riders page to register one.";
    empty.classList.toggle("hidden", list.length > 0);
  }
}
function rrRow(r) {
  if (!r || !r.id) return "";
  const id = esc(r.id);
  const status = String(r.status || "PENDING").toUpperCase();
  const banned = rrIsBanned(r);
  const displayStatus = banned ? "BANNED" : status;
  const acts = [
    `<button type="button" class="btn-sm" data-rr-act="view" data-rr-id="${id}">View</button>`,
  ];

  if (status === "PENDING") {
    acts.push(
      `<button type="button" class="btn-sm accept" data-rr-act="APPROVED" data-rr-id="${id}">✓ Approve</button>`,
      `<button type="button" class="btn-sm danger" data-rr-act="REJECTED" data-rr-id="${id}">✕ Reject</button>`,
    );
  } else if (status === "APPROVED" || banned) {
    acts.push(
      banned
        ? `<button type="button" class="btn-sm accept" data-rr-act="UNBAN" data-rr-id="${id}">✓ Unban</button>`
        : `<button type="button" class="btn-sm danger" data-rr-act="BAN" data-rr-id="${id}">🚫 Ban</button>`,
    );
  } else if (status === "REJECTED") {
    acts.push(
      `<button type="button" class="btn-sm accept" data-rr-act="APPROVED" data-rr-id="${id}">✓ Approve</button>`,
      `<button type="button" class="btn-sm danger" data-rr-act="DELETE" data-rr-id="${id}">🗑 Delete</button>`,
    );
  }

  return (
    `<tr><td><b>${esc(r.riderId || "—")}</b><br><small class="muted">${esc(r.applicationId || "")}</small></td><td>${esc(r.riderName || "—")}</td><td>${esc(r.mobileNumber || "—")}</td><td>${esc(r.hubPincode || "—")}</td><td>${esc(r.hubLocation || "—")}</td>` +
    `<td><button type="button" class="btn-sm" data-rr-doc="selfie" data-rr-id="${id}" data-rr-title="Selfie">View selfie</button></td>` +
    `<td><button type="button" class="btn-sm" data-rr-doc="aadhaar" data-rr-id="${id}" data-rr-title="Aadhaar">Preview Aadhaar</button></td>` +
    `<td>${esc(r.appliedBy || "—")}${r.ownerLoginId ? `<br><small class="muted">${esc(r.ownerLoginId)}${r.ownerName ? "<br>" + esc(r.ownerName) : ""}</small>` : ""}</td><td>${esc(rrDate(r.createdAt))}</td><td>${rrStatusBadge(displayStatus)}</td><td><div class="mini-actions">${acts.join("")}</div></td></tr>`
  );
}
function rrBindClientPage() {
  ["regFilterId", "regFilterName", "regFilterHub", "regFilterStatus"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) {
        el.oninput = rrRender;
        el.onchange = rrRender;
      }
    },
  );
  document
    .getElementById("regRefresh")
    ?.addEventListener("click", () =>
      rrLoad().then(() => toast("Rider registrations up to date")),
    );
  document.getElementById("regRows")?.addEventListener("click", rrTableClick);
  rrRender();
  rrLoad();
}
function rrTableClick(e) {
  const b = e.target.closest("button[data-rr-act],button[data-rr-doc]");
  if (!b || !b.dataset.rrId) return;
  e.preventDefault();
  e.stopPropagation();
  const item = rrItemsArray().find(
    (x) => x && String(x.id) === String(b.dataset.rrId),
  );
  if (!item) {
    toast("Registration record not found. Click Refresh and try again.");
    return;
  }
  if (b.dataset.rrDoc)
    return rrOpenDocument(
      item.id,
      b.dataset.rrDoc,
      `${b.dataset.rrTitle} · ${item.riderName || item.riderId} (${item.riderId || item.id})`,
    );
  const act = b.dataset.rrAct;
  if (act === "view") return rrViewDetail(item.id);
  if (act === "BAN" || act === "UNBAN")
    return rrConfirmBan(item, act === "BAN");
  if (act === "DELETE") return rrConfirmDelete(item);
  rrConfirmDecision(item, act);
}
function rrRevokeDocument() {
  if (rrObjectUrl) {
    URL.revokeObjectURL(rrObjectUrl);
    rrObjectUrl = null;
  }
}
async function rrOpenDocument(id, kind, title) {
  try {
    const r = await fetch(
      rrApiUrl("/" + encodeURIComponent(id) + "/files/" + kind),
      { credentials: "include" },
    );
    if (r.status === 401) return sessionEnded();
    if (!r.ok) {
      let m = "Could not open the document.";
      try {
        m = (await r.json()).error || m;
      } catch (e) {}
      return toast(m);
    }
    const blob = await r.blob();
    rrRevokeDocument();
    rrObjectUrl = URL.createObjectURL(blob);
    const view =
      blob.type === "application/pdf"
        ? `<iframe src="${rrObjectUrl}" title="${esc(title)}"></iframe>`
        : `<img src="${rrObjectUrl}" alt="${esc(title)}">`;
    openModal(
      `<h3>${esc(title)}</h3><div class="rr-doc-view">${view}</div><p class="hint">Shown only to you. Close this window when you are done.</p><div class="modal-actions"><button type="button" class="ghost" onclick="rrCloseDocument()">Close</button></div>`,
    );
  } catch (e) {
    toast("Could not reach the server. Check your connection and try again.");
  }
}
window.rrCloseDocument = () => {
  rrRevokeDocument();
  closeModal();
};
function rrConfirmBan(item, ban = true) {
  openModal(`<h3>${ban ? "Ban" : "Unban"} approved rider?</h3>
    <p>${ban ? "Ban" : "Unban"} <b>${esc(item.riderName)}</b> (Rider ID <b>${esc(item.riderId)}</b>, application ${esc(item.applicationId)})?</p>
    <div class="field span2"><label for="rrBanRemarks">${ban ? "Reason for ban *" : "Remarks (optional)"}</label><textarea id="rrBanRemarks" rows="3" maxlength="500" placeholder="${ban ? "e.g. Policy violation or inactive account" : "e.g. Issue resolved"}"></textarea></div>
    <p id="rrDecisionError" class="form-message error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="button" id="rrConfirm" class="primary ${ban ? "danger-fill" : "accept-fill"}">${ban ? "🚫 Ban Rider" : "✓ Unban Rider"}</button></div>`);
  $("#rrBanRemarks")?.focus();
  $("#rrConfirm").onclick = async () => {
    const remarks = $("#rrBanRemarks").value.trim();
    if (ban && !remarks) {
      $("#rrDecisionError").textContent =
        "Enter the reason for banning this rider.";
      return;
    }
    const btn = $("#rrConfirm");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const nextStatus = ban ? "BANNED" : "APPROVED";
      const out = await rrCall(
        rrApiUrl("/" + encodeURIComponent(item.id) + "/status"),
        { method: "POST", body: { status: nextStatus, remarks } },
      );
      const updatedItem = rrExtractItem(out) ||
        out.item || {
          ...item,
          status: nextStatus,
          banned: ban,
        };
      rrItems = rrItemsArray().map((x) => (x.id === item.id ? updatedItem : x));
      closeModal();
      rrRender();
      if (!syncRegisteredRiders() && currentPage === "riders") paintRiders();
      toast(
        `${item.riderName} (${item.riderId}) ${ban ? "banned" : "unbanned"}`,
      );
    } catch (e) {
      $("#rrDecisionError").textContent = e.message;
      btn.disabled = false;
      btn.textContent = ban ? "🚫 Ban Rider" : "✓ Unban Rider";
      toast("Could not update ban status: " + e.message);
    }
  };
}
function rrConfirmDelete(item) {
  openModal(`<h3>Delete rejected rider application?</h3>
    <p>Permanently delete <b>${esc(item.riderName)}</b> (Rider ID <b>${esc(item.riderId)}</b>, application ${esc(item.applicationId)})? This removes the rejected application and its uploaded documents.</p>
    <p id="rrDecisionError" class="form-message error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="button" id="rrConfirm" class="primary danger-fill">🗑 Delete Permanently</button></div>`);
  $("#rrConfirm").onclick = async () => {
    const btn = $("#rrConfirm");
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await rrCall(rrApiUrl("/" + encodeURIComponent(item.id)), {
        method: "DELETE",
      });
      rrItems = rrItemsArray().filter((x) => x.id !== item.id);
      if (Array.isArray(db.hiddenRegistrations)) {
        db.hiddenRegistrations = db.hiddenRegistrations.filter(
          (id) => id !== item.id,
        );
      }
      db.riders = db.riders.filter(
        (r) =>
          r.registrationId !== item.id && String(r.id) !== String(item.riderId),
      );
      save();
      closeModal();
      rrRender();
      if (currentPage === "riders") paintRiders();
      toast(`${item.applicationId} deleted`);
    } catch (e) {
      $("#rrDecisionError").textContent = e.message;
      btn.disabled = false;
      btn.textContent = "🗑 Delete Permanently";
      toast("Could not delete registration: " + e.message);
    }
  };
}
function rrConfirmDecision(item, status) {
  const approve = status === "APPROVED";
  openModal(`<h3>${approve ? "Approve" : "Reject"} rider application?</h3>
    <p>${approve ? "Approve" : "Reject"} <b>${esc(item.riderName)}</b> (Rider ID <b>${esc(item.riderId)}</b>, application ${esc(item.applicationId)}, applied by ${esc(item.appliedBy)})?</p>
    <div class="field span2"><label for="rrRemarks">${approve ? "Remarks (optional)" : "Reason for rejection *"}</label><textarea id="rrRemarks" rows="3" maxlength="500" placeholder="${approve ? "e.g. Documents verified" : "e.g. Aadhaar photo is not readable"}"></textarea></div>
    <p id="rrDecisionError" class="form-message error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="button" id="rrConfirm" class="primary ${approve ? "accept-fill" : "danger-fill"}">${approve ? "✓ Approve" : "✕ Reject"}</button></div>`);
  $("#rrRemarks")?.focus();
  $("#rrConfirm").onclick = async () => {
    const remarks = $("#rrRemarks").value.trim();
    if (!approve && !remarks) {
      $("#rrDecisionError").textContent =
        "Enter the reason for rejecting this application.";
      return;
    }
    const btn = $("#rrConfirm");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const out = await rrCall(
        rrApiUrl("/" + encodeURIComponent(item.id) + "/status"),
        { method: "POST", body: { status, remarks } },
      );
      const updatedItem = rrExtractItem(out) || out.item;
      rrItems = rrItemsArray().map((x) => (x.id === item.id ? updatedItem : x));
      closeModal();
      rrRender();
      if (!syncRegisteredRiders() && currentPage === "riders") paintRiders();
      toast(`${item.applicationId} ${approve ? "approved" : "rejected"}`);
    } catch (e) {
      $("#rrDecisionError").textContent = e.message;
      btn.disabled = false;
      btn.textContent = approve ? "✓ Approve" : "✕ Reject";
      toast("Could not save the decision: " + e.message);
    }
  };
}
async function rrViewDetail(id) {
  try {
    const out = await rrCall(rrApiUrl("/" + encodeURIComponent(id)));
    const r = rrExtractItem(out) || out.item;
    rrItems = rrItemsArray().map((x) => (x.id === r.id ? r : x));
    const status = String(r.status || "PENDING").toUpperCase();
    const banned = rrIsBanned(r);
    const history = (r.history || [])
      .map(
        (h) =>
          `<tr><td>${esc(rrDate(h.at))}</td><td>${esc(h.fromStatus ? h.fromStatus + " → " : "")}${esc(h.toStatus)}</td><td>${esc(h.actor)}</td><td>${esc(h.remarks || "—")}</td></tr>`,
      )
      .join("");
    let modalActions = `<button type="button" class="ghost" onclick="closeModal()">Close</button>`;
    if (status === "PENDING") {
      modalActions +=
        `<button type="button" class="primary accept-fill" data-rr-decide="APPROVED">✓ Approve</button>` +
        `<button type="button" class="primary danger-fill" data-rr-decide="REJECTED">✕ Reject</button>`;
    } else if (status === "APPROVED" || banned) {
      modalActions += banned
        ? `<button type="button" class="primary accept-fill" data-rr-ban="UNBAN">✓ Unban</button>`
        : `<button type="button" class="primary danger-fill" data-rr-ban="BAN">🚫 Ban</button>`;
    } else if (status === "REJECTED") {
      modalActions +=
        `<button type="button" class="primary accept-fill" data-rr-decide="APPROVED">✓ Approve</button>` +
        `<button type="button" class="primary danger-fill" data-rr-delete="1">🗑 Delete</button>`;
    }
    openModal(`<h3>${esc(r.riderName)} · ${esc(r.riderId)}</h3>
      <div class="grid2">
        <div><b>Application ID</b><p>${esc(r.applicationId)}</p></div>
        <div><b>Status</b><p>${rrStatusBadge(banned ? "BANNED" : status)}</p></div>
        <div><b>Mobile number</b><p>${esc(r.mobileNumber)}</p></div>
        <div><b>Hub pincode</b><p>${esc(r.hubPincode)}</p></div>
        <div><b>Hub location</b><p>${esc(r.hubLocation)}</p></div>
        <div><b>Applied by</b><p>${esc(r.appliedBy)}${r.ownerLoginId ? " · " + esc(r.ownerLoginId) + (r.ownerName ? " · " + esc(r.ownerName) : "") : ""}</p></div>
        <div><b>Application date</b><p>${esc(rrDate(r.createdAt))}</p></div>
        <div><b>Approved by</b><p>${esc(r.approvedBy || "—")}${r.approvalDate ? " · " + esc(rrDate(r.approvalDate)) : ""}</p></div>
        ${r.decisionRemarks ? `<div class="span2"><b>${status === "REJECTED" ? "Rejection reason" : status === "BANNED" ? "Ban reason" : "Approval remarks"}</b><p>${esc(r.decisionRemarks)}</p></div>` : ""}
      </div>
      <div class="rr-doc-buttons"><button type="button" class="btn-sm" data-rr-doc="selfie" data-rr-title="Selfie · ${esc(r.riderName)}">View selfie</button><button type="button" class="btn-sm" data-rr-doc="aadhaar" data-rr-title="Aadhaar · ${esc(r.riderName)}">Preview Aadhaar</button></div>
      <h4>History</h4>
      <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Change</th><th>By</th><th>Remarks</th></tr></thead><tbody>${history || '<tr><td colspan="4" class="empty">No history.</td></tr>'}</tbody></table></div>
      <div class="modal-actions">${modalActions}</div>`);
    $("#modalBody")
      .querySelectorAll("[data-rr-doc]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            rrOpenDocument(r.id, b.dataset.rrDoc, b.dataset.rrTitle)),
      );
    $("#modalBody")
      .querySelectorAll("[data-rr-decide]")
      .forEach(
        (b) => (b.onclick = () => rrConfirmDecision(r, b.dataset.rrDecide)),
      );
    $("#modalBody")
      .querySelectorAll("[data-rr-ban]")
      .forEach(
        (b) => (b.onclick = () => rrConfirmBan(r, b.dataset.rrBan === "BAN")),
      );
    $("#modalBody")
      .querySelectorAll("[data-rr-delete]")
      .forEach((b) => (b.onclick = () => rrConfirmDelete(r)));
  } catch (e) {
    toast(e.message);
  }
}
function rrOpenForm() {
  openModal(`<h3>Add New Member</h3>
    <p class="muted">Register a rider with both documents. The application is saved at once and appears in Client Members as <b>PENDING</b>.</p>
    <form id="rrForm" class="form-grid" novalidate>
      <div class="field"><label for="rrId">Rider ID *</label><input id="rrId" maxlength="40" autocomplete="off" placeholder="e.g. 28274601"></div>
      <div class="field"><label for="rrName">Rider Name *</label><input id="rrName" maxlength="100" autocomplete="off"></div>
      <div class="field"><label for="rrMobile">Mobile Number *</label><input id="rrMobile" inputmode="numeric" maxlength="16" autocomplete="off" placeholder="10-digit mobile number"></div>
      <div class="field"><label for="rrPin">Hub Pincode *</label><input id="rrPin" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="6-digit pincode"></div>
      <div class="field span2"><label for="rrHub">Hub Location *</label><input id="rrHub" maxlength="120" autocomplete="off"></div>
      <div class="field span2"><label for="rrSelfie">Rider Selfie / Screenshot *</label><input id="rrSelfie" type="file" accept="image/jpeg,image/png,image/webp"><small class="hint">JPG, PNG or WEBP image, up to 5 MB.</small><div id="rrSelfiePreview" class="rr-preview"></div><p id="rrOcrNote" class="autofill-status" role="status"></p></div>
      <div class="field span2"><label for="rrAadhaar">Aadhaar Card *</label><input id="rrAadhaar" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"><small class="hint">JPG, PNG, WEBP or PDF, up to 5 MB. A masked Aadhaar (last 4 digits visible) is recommended.</small><div id="rrAadhaarPreview" class="rr-preview"></div></div>
      <p id="rrFormError" class="form-message error span2" role="alert"></p>
      <div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="submit" class="primary" id="rrSubmit">Save / Submit</button></div>
    </form>`);
  const pin = $("#rrPin");
  pin.oninput = () => {
    pin.value = pin.value.replace(/\D/g, "").slice(0, 6);
  };
  $("#rrSelfie").onchange = (e) => {
    rrPickFile(e.target, $("#rrSelfiePreview"), "selfie");
    if (e.target.files[0]) rrAutoFillFromScreenshot(e.target.files[0]);
  };
  ["rrId", "rrName", "rrMobile"].forEach((id) =>
    $("#" + id)?.addEventListener("input", (ev) =>
      ev.target.classList.remove("autofilled"),
    ),
  );
  $("#rrAadhaar").onchange = (e) =>
    rrPickFile(e.target, $("#rrAadhaarPreview"), "aadhaar");
  $("#rrForm").onsubmit = rrSubmitForm;
  $("#rrId")?.focus();
}
function rrFormFail(field, message) {
  const el = document.getElementById(RR_FORM_FIELD[field] || field);
  $("#rrFormError").textContent = message || "Could not save the rider.";
  if (el && el.focus) el.focus();
}
async function rrAutoFillFromScreenshot(file) {
  const idEl = $("#rrId"),
    nameEl = $("#rrName"),
    mobileEl = $("#rrMobile"),
    note = $("#rrOcrNote");
  if (!file || !idEl || !nameEl || !note) return;
  if (!RR_IMAGE_TYPES.includes(file.type) || file.size > RR_MAX_BYTES) return;
  if (
    idEl.value.trim() &&
    nameEl.value.trim() &&
    (!mobileEl || mobileEl.value.trim())
  )
    return;
  note.className = "autofill-status busy";
  note.textContent =
    "Reading the Rider ID, name, and mobile from the screenshot…";
  try {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const r = await fetch(
      PARTNER_API_BASE + "/api/read-rider-screenshot?portal=admin",
      { method: "POST", credentials: "include", body: fd },
    );
    const out = await r.json().catch(() => ({}));
    if (!document.body.contains(idEl)) return;
    if (!r.ok) throw new Error(out.error || "");
    const filled = [];
    if (out.read?.partnerId && !idEl.value.trim()) {
      idEl.value = out.read.partnerId;
      idEl.classList.add("autofilled");
      filled.push("Rider ID");
    }
    if (out.read?.name && !nameEl.value.trim()) {
      nameEl.value = out.read.name;
      nameEl.classList.add("autofilled");
      filled.push("Rider Name");
    }
    const cleanMobile = rrCleanMobile(out.read?.mobile || "");
    if (cleanMobile && mobileEl && !mobileEl.value.trim()) {
      mobileEl.value = cleanMobile;
      mobileEl.classList.add("autofilled");
      filled.push("Mobile Number");
    }
    note.className = "autofill-status " + (filled.length ? "ok" : "warn");
    note.textContent = filled.length
      ? `${filled.join(", ")} filled in from the screenshot. Please check before saving.`
      : out.read?.partnerId || out.read?.name || cleanMobile
        ? ""
        : "No Partner ID was found in this image. Please type the details.";
  } catch (e) {
    if (!document.body.contains(note)) return;
    note.className = "autofill-status warn";
    note.textContent =
      "The screenshot could not be read automatically. Please type the details.";
  }
}
function rrPickFile(input, box, kind) {
  const f = input.files[0];
  box.innerHTML = "";
  $("#rrFormError").textContent = "";
  if (!f) return;
  const allowed =
    kind === "selfie" ? RR_IMAGE_TYPES : [...RR_IMAGE_TYPES, "application/pdf"];
  if (!allowed.includes(f.type)) {
    input.value = "";
    return rrFormFail(
      kind === "selfie" ? "rrSelfie" : "rrAadhaar",
      kind === "selfie"
        ? "The selfie must be a JPG, PNG or WEBP image."
        : "The Aadhaar card must be a JPG, PNG, WEBP image or PDF.",
    );
  }
  if (f.size > RR_MAX_BYTES) {
    input.value = "";
    return rrFormFail(
      kind === "selfie" ? "rrSelfie" : "rrAadhaar",
      "That file is larger than 5 MB. Please choose a smaller file.",
    );
  }
  const url = URL.createObjectURL(f);
  box.innerHTML =
    (f.type === "application/pdf"
      ? '<span class="rr-pdf">PDF</span>'
      : `<img src="${url}" alt="Preview of ${esc(f.name)}">`) +
    `<span class="rr-file-name"><b>${esc(f.name)}</b><small>${esc(rrSize(f.size))}</small></span><button type="button" class="btn-sm" data-rr-preview>Preview</button>`;
  box.querySelector("[data-rr-preview]").onclick = () =>
    window.open(url, "_blank", "noopener");
}
async function rrSubmitForm(e) {
  e.preventDefault();
  const v = {
    id: $("#rrId").value.trim(),
    name: $("#rrName").value.replace(/\s+/g, " ").trim(),
    mobile: $("#rrMobile").value.trim(),
    pin: $("#rrPin").value.trim(),
    hub: $("#rrHub").value.replace(/\s+/g, " ").trim(),
  };
  const problem = rrCheckFields(v);
  if (problem) return rrFormFail(problem[0], problem[1]);
  const selfie = $("#rrSelfie").files[0],
    aadhaar = $("#rrAadhaar").files[0];
  if (!selfie)
    return rrFormFail("rrSelfie", "Upload the rider selfie or screenshot.");
  if (!aadhaar) return rrFormFail("rrAadhaar", "Upload the Aadhaar card.");
  const fd = new FormData();
  fd.append("riderId", v.id);
  fd.append("riderName", v.name);
  fd.append("mobile", rrCleanMobile(v.mobile));
  fd.append("hubPincode", v.pin);
  fd.append("hubLocation", v.hub);
  fd.append("selfie", selfie, selfie.name);
  fd.append("aadhaar", aadhaar, aadhaar.name);
  const btn = $("#rrSubmit");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const out = await rrCall(rrApiUrl(), { method: "POST", body: fd });
    const savedItem = rrExtractItem(out);
    if (savedItem) {
      rrItems = [
        savedItem,
        ...rrItemsArray().filter((x) => x && x.id !== savedItem.id),
      ];
    }
    closeModal();
    toast(
      `${savedItem?.applicationId || savedItem?.riderId || "Registration"} saved as ${savedItem?.status || "PENDING"}. Showing in Client Members.`,
    );
    render("client");
    setTimeout(
      () =>
        document
          .getElementById("regMembersCard")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      60,
    );
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Save / Submit";
    rrFormFail(err.field, err.message);
    toast("Not saved: " + err.message);
  }
}
