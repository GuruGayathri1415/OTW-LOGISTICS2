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
if (!Array.isArray(db.employees)) db.employees = [];
if (!Array.isArray(db.vendorMembers)) db.vendorMembers = [];
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

function employee() {
  ensureEmployees();
  return (
    layout(
      "Employees",
      "View and manage company employees, roles and departments.",
      '<button class="primary" id="addEmployeeBtn">+ Add Employee</button>',
    ) +
    `<div class="cards">
      ${stat("Total Employees", db.employees.length, "empStatTotal")}
      ${stat("Active", db.employees.filter((e) => e.status === "Active").length, "empStatActive")}
      ${stat("Inactive", db.employees.filter((e) => e.status !== "Active").length, "empStatInactive")}
    </div>
    <div class="card">
      <input class="search" id="employeeSearch" placeholder="Search employee name, ID, role, department or phone..." autocomplete="off">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Name</th>
              <th>Role</th>
              <th>Department</th>
              <th>Phone</th>
              <th>Email</th>
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

function paintEmployees(q = "") {
  ensureEmployees();
  const body = $("#employeeRows");
  if (!body) return;
  const term = String(q || "").trim().toLowerCase();
  const list = !term
    ? db.employees
    : db.employees.filter((e) =>
        [e.id, e.name, e.role, e.department, e.phone, e.email, e.status]
          .join(" ")
          .toLowerCase()
          .includes(term),
      );
  body.innerHTML = list.length
    ? list
        .map(
          (e) =>
            `<tr>
              <td><b>${esc(e.id)}</b></td>
              <td>${esc(e.name)}</td>
              <td>${esc(e.role || "—")}</td>
              <td>${esc(e.department || "—")}</td>
              <td>${esc(e.phone || "—")}</td>
              <td>${esc(e.email || "—")}</td>
              <td><span class="badge ${e.status === "Active" ? "success" : "danger"}">${esc(e.status || "Active")}</span></td>
              <td>
                <div class="mini-actions">
                  <button class="btn-sm" onclick="editEmployee('${esc(e.id)}')">Edit</button>
                  <button class="btn-sm danger" onclick="deleteEmployee('${esc(e.id)}')">Delete</button>
                </div>
              </td>
            </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" class="empty">${term ? "No matching employees." : "No employees yet. Click + Add Employee."}</td></tr>`;
}

function bindEmployee() {
  ensureEmployees();
  $("#addEmployeeBtn")?.addEventListener("click", () => employeeModal());
  $("#employeeSearch")?.addEventListener("input", (e) =>
    paintEmployees(e.target.value),
  );
  paintEmployees();
}

function employeeModal(emp = null) {
  ensureEmployees();
  const editing = !!emp;
  const defaultId =
    emp?.id || "EMP-" + String(db.employees.length + 1).padStart(4, "0");
  openModal(`
    <h3>${editing ? "Edit Employee" : "Add Employee"}</h3>
    <form id="employeeForm" class="form-grid">
      <div class="field"><label>Employee ID *</label><input id="empId" required value="${esc(defaultId)}"></div>
      <div class="field"><label>Name *</label><input id="empName" required value="${esc(emp?.name || "")}"></div>
      <div class="field"><label>Role</label><input id="empRole" placeholder="e.g. Operations Executive" value="${esc(emp?.role || "")}"></div>
      <div class="field"><label>Department</label><input id="empDept" placeholder="e.g. Logistics, Support" value="${esc(emp?.department || "")}"></div>
      <div class="field"><label>Phone</label><input id="empPhone" inputmode="numeric" maxlength="15" value="${esc(emp?.phone || "")}"></div>
      <div class="field"><label>Email</label><input id="empEmail" type="email" value="${esc(emp?.email || "")}"></div>
      <div class="field"><label>Status</label><select id="empStatus"><option ${!emp || emp.status === "Active" ? "selected" : ""}>Active</option><option ${emp?.status === "Inactive" ? "selected" : ""}>Inactive</option></select></div>
      <div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button type="submit" class="primary">${editing ? "Save Changes" : "Save Employee"}</button></div>
    </form>
  `);

  $("#employeeForm").onsubmit = (e) => {
    e.preventDefault();
    const record = {
      id: $("#empId").value.trim(),
      name: $("#empName").value.trim(),
      role: $("#empRole").value.trim(),
      department: $("#empDept").value.trim(),
      phone: $("#empPhone").value.trim(),
      email: $("#empEmail").value.trim(),
      status: $("#empStatus").value,
    };
    if (!record.id || !record.name)
      return toast("Employee ID and Name are required.");
    if (editing) {
      Object.assign(emp, record);
    } else {
      if (
        db.employees.some((x) => x.id.toLowerCase() === record.id.toLowerCase())
      ) {
        return toast("This Employee ID already exists.");
      }
      db.employees.unshift(record);
    }
    save();
    closeModal();
    render("employee");
    toast(editing ? "Employee updated" : "Employee added");
  };
}

window.editEmployee = (id) => {
  const emp = (db.employees || []).find((x) => x.id === id);
  if (emp) employeeModal(emp);
};

window.deleteEmployee = (id) => {
  if (!confirm("Delete this employee?")) return;
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