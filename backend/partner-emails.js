// Emails to Franchise / Vendor applicants: application submitted, approved (with the portal login), rejected, and a
// new temporary password from the admin. Pure functions (no network, no database) so the wording can be tested.
// Each returns {subject, text, html}. Every value typed by an applicant or admin is escaped in the HTML version and
// kept on one line in the subject, so it cannot change the email's structure.

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const oneLine = (v) =>
  String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const kindOf = (app) =>
  String(app?.type || "").toLowerCase() === "vendor" ? "Vendor" : "Franchise";
const dateText = (iso) => {
  const d = new Date(iso || Date.now());
  return isNaN(d)
    ? ""
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
};

// The application details repeated back to the applicant (only fields they filled in).
function detailRows(app) {
  const kind = kindOf(app);
  const place = [app.locality, app.city, app.district, app.state].filter(Boolean).join(", ");
  return [
    [`${kind} Application ID`, app.appId],
    ["Application type", kind],
    ["Name", app.name],
    ["Mobile number", app.mobile],
    ["WhatsApp number", app.whatsapp && app.whatsapp !== app.mobile ? app.whatsapp : ""],
    ["Email", app.email],
    ["Location", place],
    ["PIN code", app.pincode],
  ].filter(([, v]) => oneLine(v));
}

// Plain layout that reads well in Gmail on a phone: a header, the message paragraphs, an optional box, a footer.
function layout({
  title,
  paragraphs,
  box = null,
  rows = null,
  footerNote = "",
  signOffLines = ["Regards,", "On The Way Logistics"],
  supportEmail = "",
}) {
  const text = [
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(box ? [...box.map(([k, v]) => `  • ${k}: ${oneLine(v)}`), ""] : []),
    ...(rows ? ["Your application:", ...rows.map(([k, v]) => `  • ${k}: ${oneLine(v)}`), ""] : []),
    ...(footerNote ? [footerNote, ""] : []),
    ...signOffLines,
    supportEmail ? `Help: ${supportEmail}` : "",
  ]
    .join("\n")
    .trim();
  const table = (list, strong, withDot = false) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:14px 0;background:#f6f9fc;border:1px solid #dbe6f0;border-radius:8px">${list
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 12px;color:#5b6b7d;font-size:13px;width:44%;border-bottom:1px solid #e6eef5">${withDot ? "• " : ""}${esc(k)}</td><td style="padding:8px 12px;font-size:14px;color:#14263b;border-bottom:1px solid #e6eef5;${strong ? "font-weight:700;font-family:Consolas,Menlo,monospace" : "font-weight:600"}">${esc(oneLine(v))}</td></tr>`,
      )
      .join("")}</table>`;
  const signOffHtml = signOffLines
    .map((line, idx) => (idx === 0 ? esc(line) : `<strong>${esc(line)}</strong>`))
    .join("<br>");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f8">
<div style="max-width:560px;margin:0 auto;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#14263b">
<div style="background:#0b2a4a;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0"><strong style="font-size:16px;letter-spacing:.5px">ON THE WAY LOGISTICS</strong><div style="color:#f5a623;font-size:12px;margin-top:2px">Delivering trust, every mile</div></div>
<div style="background:#fff;padding:20px 18px;border-radius:0 0 10px 10px;border:1px solid #dbe6f0;border-top:0">
<h1 style="font-size:19px;margin:0 0 12px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:14px;line-height:1.55;margin:0 0 12px">${esc(p)}</p>`).join("")}
${box ? table(box, true, false) : ""}${rows ? `<p style="font-size:13px;color:#5b6b7d;margin:16px 0 0">Your application:</p>${table(rows, false, true)}` : ""}
${footerNote ? `<p style="font-size:13px;line-height:1.5;color:#5b6b7d;margin:14px 0 0">${esc(footerNote)}</p>` : ""}
<p style="font-size:14px;line-height:1.55;margin:16px 0 0">${signOffHtml}${supportEmail ? `<br><span style="font-size:13px;color:#5b6b7d">Help: ${esc(supportEmail)}</span>` : ""}</p>
</div></div></body></html>`;
  return { text, html };
}

export function submittedEmail(app, { supportEmail = "" } = {}) {
  const kind = kindOf(app);
  const { text, html } = layout({
    title: `${kind} Application Submitted`,
    paragraphs: [
      "Dear Customer,",
      `Thank you for applying to become an On The Way Logistics ${kind.toLowerCase()} partner. We received your ${kind.toLowerCase()} application on ${dateText(app.submittedAt)}.`,
      `Your ${kind.toLowerCase()} application ID is ${app.appId}. Please keep it for your records. Our team will review your application and contact you on your mobile number or this email address.`,
    ],
    rows: detailRows(app),
    footerNote:
      "If any detail above is wrong, reply to this email with the correction and your application ID. If you did not submit this application, please ignore this email.",
    supportEmail,
  });
  return { subject: `Application received: ${oneLine(app.appId)} (${kind})`, text, html };
}

// login: {portalUrl, loginId, password} - password is "" when an existing login is switched back on.
export function approvedEmail(app, { login = null, note = "", supportEmail = "" } = {}) {
  const isVendor = String(app?.type || "").toLowerCase() === "vendor";
  const kind = isVendor ? "Vendor" : "Franchise";
  const lowerKind = isVendor ? "vendor" : "franchise";

  const paragraphs = [
    `Dear ${kind},`,
    "Greetings from OnTheWay Logistics!",
    `We are pleased to inform you that your ${lowerKind} application has been reviewed and approved by our team.`,
    `We welcome you as an approved ${lowerKind} of OnTheWay Logistics and look forward to building a successful business relationship.`,
    "Kindly coordinate with our team for the next steps, onboarding formalities, and operational requirements.",
    "We appreciate your interest in working with us and look forward to a long-term association.",
  ];

  if (oneLine(note)) {
    paragraphs.push(`Note from our team: ${oneLine(note)}`);
  }

  let box = null;
  if (login && login.password) {
    paragraphs.push(`You can now sign in to the ${kind} Portal with these details:`);
    box = [
      ["Portal", login.portalUrl],
      [`${kind} ID`, login.loginId],
      ["Temporary password", login.password],
    ];
  } else if (login) {
    paragraphs.push(
      `Your ${kind} Portal login is active. Sign in with your ${kind} ID and your existing password:`,
    );
    box = [
      ["Portal", login.portalUrl],
      [`${kind} ID`, login.loginId],
    ];
  }

  const { text, html } = layout({
    title: `${kind} Application Approved`,
    paragraphs,
    box,
    footerNote:
      login && login.password
        ? "When you sign in for the first time you will be asked to choose your own password. Do not share these details with anyone."
        : login
          ? "Do not share your password with anyone."
          : "",
    signOffLines: [
      "Best Regards,",
      `${kind} Management Team`,
      "OnTheWay Logistics",
    ],
    supportEmail,
  });

  return {
    subject: `${kind} Application Approved: ${oneLine(app.appId)} - OnTheWay Logistics`,
    text,
    html,
  };
}

export function rejectedEmail(app, { note = "", supportEmail = "" } = {}) {
  const kind = kindOf(app);
  const { text, html } = layout({
    title: `${kind} Application Update`,
    paragraphs: [
      "Dear Customer,",
      `Thank you for your interest in becoming an On The Way Logistics ${kind.toLowerCase()} partner and for the time you spent on your ${kind.toLowerCase()} application ${app.appId}.`,
      "After reviewing it carefully, we are unable to approve your application at this time.",
      ...(oneLine(note) ? [`Reason: ${oneLine(note)}`] : []),
      "This decision is about this application only. You are welcome to apply again in the future if your situation changes.",
    ],
    footerNote: "If you have questions about this decision, reply to this email with your application ID.",
    supportEmail,
  });
  return { subject: `Application update: ${oneLine(app.appId)} (${kind})`, text, html };
}

// Admin "Reset password" / "Create login" for a partner whose application was already approved.
export function newPasswordEmail(app, { login, supportEmail = "" } = {}) {
  const kind = kindOf(app);
  const { text, html } = layout({
    title: `Your ${kind} Portal sign-in`,
    paragraphs: [
      "Dear Customer,",
      `On The Way Logistics has set a new temporary password for your ${kind} Portal login. Your previous password no longer works.`,
    ],
    box: [
      ["Portal", login.portalUrl],
      [`${kind} ID`, login.loginId],
      ["Temporary password", login.password],
    ],
    footerNote:
      "You will be asked to choose your own password when you sign in. If you did not ask for this, contact us. Do not share these details with anyone.",
    supportEmail,
  });
  return { subject: `Your On The Way Logistics ${kind} Portal login`, text, html };
}