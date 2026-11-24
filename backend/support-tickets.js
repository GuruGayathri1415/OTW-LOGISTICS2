// Support tickets, events, and attachments backed by the async PostgreSQL adapter (`db-adapter.js`)
// and Supabase Storage (with local disk fallback when Supabase Storage is not configured).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SUPPORT_PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export const SUPPORT_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
];

export const TICKET_NO_PATTERN =
  /\b(?:TKT|SUP|OTW)-\d{4,10}\b|\bTKT-[A-F0-9]{6}\b/i;

export function sameAddress(a, b) {
  const left = String(a || "")
    .trim()
    .toLowerCase();
  const right = String(b || "")
    .trim()
    .toLowerCase();
  return Boolean(left) && left === right;
}

const ALLOWED_STATUSES = new Set(SUPPORT_STATUSES);
const ALLOWED_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const TEXT_LIMITS = {
  name: 160,
  email: 254,
  phone: 20,
  subject: 240,
  description: 10000,
};

export class SupportError extends Error {
  constructor(message, status = 400, field = "") {
    super(message);
    this.name = "SupportError";
    this.status = status;
    this.field = field;
  }
}

export function partnerPortalType(role) {
  const r = String(role || "").toLowerCase();
  return r === "vendor" || r === "franchise" ? r : "";
}

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "",
);
const SUPABASE_SUPPORT_BUCKET = String(
  process.env.SUPABASE_SUPPORT_BUCKET || "support-tickets",
);
const useSupabaseStorage = Boolean(SUPABASE_URL && SUPABASE_KEY);

function encodeStoragePath(objectPath) {
  return String(objectPath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

async function uploadToSupabase(objectPath, buffer, mime) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_SUPPORT_BUCKET)}/${encodeStoragePath(objectPath)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      "Content-Type": mime || "application/octet-stream",
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new SupportError(
      `Could not store support photo in Supabase (${res.status}): ${errText || res.statusText}`,
      500,
    );
  }
}

async function downloadFromSupabase(objectPath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_SUPPORT_BUCKET)}/${encodeStoragePath(objectPath)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new SupportError(
      `Could not load support photo from Supabase (${res.status})`,
      500,
    );
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function createSupportService({ db, uploadDir }) {
  const supportUploadRoot = path.join(uploadDir, "support-tickets");
  fs.mkdirSync(supportUploadRoot, { recursive: true, mode: 0o700 });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets(
      id TEXT PRIMARY KEY,
      ticket_code TEXT UNIQUE NOT NULL,
      subject TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      requester_role TEXT,
      requester_id TEXT,
      requester_name TEXT,
      requester_email TEXT,
      assigned_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets(status, updated_at);
    CREATE INDEX IF NOT EXISTS support_tickets_requester ON support_tickets(requester_id, created_at);

    CREATE TABLE IF NOT EXISTS support_ticket_events(
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'message',
      actor_role TEXT,
      actor_id TEXT,
      actor_name TEXT,
      body TEXT,
      meta TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS support_ticket_events_ticket ON support_ticket_events(ticket_id, created_at);

    CREATE TABLE IF NOT EXISTS support_ticket_attachments(
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      event_id TEXT,
      original_name TEXT,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      stored_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS support_ticket_attachments_ticket ON support_ticket_attachments(ticket_id);
  `);

  const cols = await db
    .prepare(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'support_ticket_events'`,
    )
    .all();
  if (!cols.some((c) => c.name === "message_id")) {
    await db.exec(
      "ALTER TABLE support_ticket_events ADD COLUMN message_id TEXT",
    );
  }

  const nowIso = () => new Date().toISOString();

  function cleanText(value, maxLen = 4000) {
    return String(value ?? "")
      .trim()
      .slice(0, maxLen);
  }

  function makeTicketCode() {
    const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `TKT-${suffix}`;
  }

  async function getTicketById(ticketId) {
    return db
      .prepare("SELECT * FROM support_tickets WHERE id=?")
      .get(String(ticketId || ""));
  }

  async function getTicketByCode(ticketCode) {
    return db
      .prepare("SELECT * FROM support_tickets WHERE upper(ticket_code)=?")
      .get(
        String(ticketCode || "")
          .trim()
          .toUpperCase(),
      );
  }

  async function resolveTicket(idOrCode) {
    const raw = String(idOrCode || "").trim();
    if (!raw) return null;
    return (await getTicketById(raw)) || (await getTicketByCode(raw));
  }

  async function ticketForMessageRefs(refs = []) {
    const list = Array.isArray(refs) ? refs : [refs];
    const candidates = [
      ...new Set(
        list
          .flatMap((v) => String(v || "").split(/[\s,]+/))
          .map((s) => cleanText(s.replace(/^<|>$/g, ""), 300))
          .filter(Boolean),
      ),
    ];
    for (const ref of candidates) {
      const variants = [...new Set([ref, `<${ref}>`])];
      for (const idCandidate of variants) {
        const ev = await db
          .prepare(
            "SELECT ticket_id FROM support_ticket_events WHERE message_id=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(idCandidate);
        if (ev?.ticket_id) {
          const ticket = await getTicketById(ev.ticket_id);
          if (ticket) return ticket;
        }
      }
      const codeMatch = ref.match(TICKET_NO_PATTERN);
      if (codeMatch) {
        const ticket = await getTicketByCode(codeMatch[0]);
        if (ticket) return ticket;
      }
    }
    return null;
  }

  async function listTickets({
    status = "",
    requesterId = "",
    search = "",
    limit = 100,
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const clauses = [];
    const params = [];

    if (status && ALLOWED_STATUSES.has(String(status))) {
      clauses.push("status=?");
      params.push(String(status));
    }
    if (requesterId) {
      clauses.push("requester_id=?");
      params.push(String(requesterId));
    }
    if (search) {
      const q = `%${String(search).trim().toLowerCase()}%`;
      clauses.push(
        "(lower(ticket_code) LIKE ? OR lower(subject) LIKE ? OR lower(coalesce(requester_name,'')) LIKE ? OR lower(coalesce(requester_email,'')) LIKE ?)",
      );
      params.push(q, q, q, q);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(safeLimit);

    return db
      .prepare(
        `SELECT * FROM support_tickets ${whereSql} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params);
  }

  function formatTicketRow(row, firstMessage = "", attachments = []) {
    if (!row) return null;
    const atts = Array.isArray(attachments) ? attachments : [];
    const primaryPhoto =
      atts.find((a) => String(a.mime || "").startsWith("image/")) ||
      atts[0] ||
      null;
    return {
      ...row,
      ticket_no: row.ticket_code,
      customer_name: row.requester_name || "",
      email: row.requester_email || "",
      portal_type: row.requester_role || "",
      description: firstMessage || row.subject || "",
      attachments: atts,
      hasPhoto: Boolean(primaryPhoto),
      photoName: primaryPhoto?.original_name || "",
      photoMime: primaryPhoto?.mime || "",
    };
  }

  async function listForAdmin({ status = "", portal = "", q = "" } = {}) {
    const rows = await listTickets({ status, search: q, limit: 250 });
    const portalFilter = String(portal || "")
      .trim()
      .toLowerCase();
    const filtered = portalFilter
      ? rows.filter(
          (r) => String(r.requester_role || "").toLowerCase() === portalFilter,
        )
      : rows;

    const allRows = await listTickets({ limit: 500 });
    const summary = {
      total: allRows.length,
      open: allRows.filter((r) => r.status === "open").length,
      inProgress: allRows.filter((r) => r.status === "in_progress").length,
      waitingOnUser: allRows.filter((r) => r.status === "waiting_on_user")
        .length,
      resolved: allRows.filter((r) => r.status === "resolved").length,
      closed: allRows.filter((r) => r.status === "closed").length,
    };

    const tickets = await Promise.all(
      filtered.map(async (r) =>
        formatTicketRow(r, "", await listAttachments(r.id)),
      ),
    );

    return {
      tickets,
      summary,
    };
  }

  async function getForAdmin(idOrCode) {
    const ticket = await resolveTicket(idOrCode);
    if (!ticket) throw new SupportError("Support ticket not found.", 404);
    const events = await listEvents(ticket.id);
    const attachments = await listAttachments(ticket.id);
    const firstMsg = events.find((e) => e.body)?.body || "";
    return {
      ticket: formatTicketRow(ticket, firstMsg, attachments),
      events,
      attachments,
    };
  }

  async function listForAccount(account) {
    const acctId = String(account?.id || account?.login_id || "");
    if (!acctId) return [];
    const rows = await listTickets({ requesterId: acctId, limit: 100 });
    return Promise.all(
      rows.map(async (r) =>
        formatTicketRow(r, "", await listAttachments(r.id)),
      ),
    );
  }

  async function getForAccount(idOrCode, account) {
    const ticket = await resolveTicket(idOrCode);
    const acctId = String(account?.id || account?.login_id || "");
    if (!ticket || String(ticket.requester_id || "") !== acctId) {
      throw new SupportError("Support ticket not found.", 404);
    }
    const events = await listEvents(ticket.id);
    const attachments = await listAttachments(ticket.id);
    const firstMsg = events.find((e) => e.body)?.body || "";
    return {
      ticket: formatTicketRow(ticket, firstMsg, attachments),
      events,
      attachments,
    };
  }

  async function rowForAccount(idOrCode, account) {
    const ticket = await resolveTicket(idOrCode);
    const acctId = String(account?.id || account?.login_id || "");
    if (!ticket || String(ticket.requester_id || "") !== acctId) return null;
    return ticket;
  }

  async function rowById(idOrCode) {
    return resolveTicket(idOrCode);
  }

  async function photoFor(ticketRow) {
    if (!ticketRow?.id) return null;
    const atts = await listAttachments(ticketRow.id);
    const att =
      atts.find((a) => String(a.mime || "").startsWith("image/")) || atts[0];
    if (!att || !att.stored_name) return null;

    if (useSupabaseStorage) {
      const buffer = await downloadFromSupabase(
        `${ticketRow.id}/${att.stored_name}`,
      );
      if (buffer) {
        return { buffer, mime: att.mime, name: att.original_name };
      }
    }

    const abs = path.join(
      supportUploadRoot,
      String(ticketRow.id),
      att.stored_name,
    );
    const rootWithSep = supportUploadRoot + path.sep;
    if (!abs.startsWith(rootWithSep) || !fs.existsSync(abs)) return null;
    return { abs, mime: att.mime, name: att.original_name };
  }

  async function partnerFollowUp(idOrCode, partner, messageText) {
    const text = cleanText(messageText, 10_000);
    if (!text)
      throw new SupportError("Please enter a message.", 400, "message");
    const ticket = await resolveTicket(idOrCode);
    const acctId = String(partner?.id || partner?.login_id || "");
    if (!ticket || String(ticket.requester_id || "") !== acctId) {
      throw new SupportError("Support ticket not found.", 404);
    }
    const ev = await addEvent({
      ticketId: ticket.id,
      eventType: "partner_followup",
      actorRole: partner.role || "partner",
      actorId: acctId,
      actorName: partner.name || partner.login_id || "Partner",
      body: text,
    });
    const updated = await getTicketById(ticket.id);
    const detail = await getForAccount(ticket.id, partner);
    return {
      ticket: formatTicketRow(updated, text, detail.attachments),
      eventId: ev.id,
      detail,
    };
  }

  async function adminReply(idOrCode, actor, messageText) {
    const text = cleanText(messageText, 10_000);
    if (!text) throw new SupportError("Please enter a reply.", 400, "message");
    const ticket = await resolveTicket(idOrCode);
    if (!ticket) throw new SupportError("Support ticket not found.", 404);
    const ev = await addEvent({
      ticketId: ticket.id,
      eventType: "admin_reply",
      actorRole: "admin",
      actorId: String(actor || "admin"),
      actorName: String(actor || "Admin"),
      body: text,
    });
    const updated = await getTicketById(ticket.id);
    const attachments = await listAttachments(ticket.id);
    return {
      ticket: formatTicketRow(updated, text, attachments),
      eventId: ev.id,
    };
  }

  async function setStatus(idOrCode, actor, status, note = "") {
    const ticket = await resolveTicket(idOrCode);
    if (!ticket) throw new SupportError("Support ticket not found.", 404);
    const updated = await updateStatus({
      ticketId: ticket.id,
      status,
      actorRole: "admin",
      actorId: String(actor || "admin"),
      actorName: String(actor || "Admin"),
      note,
    });
    const events = await listEvents(ticket.id);
    const attachments = await listAttachments(ticket.id);
    return {
      ticket: formatTicketRow(
        updated,
        events.find((e) => e.body)?.body || "",
        attachments,
      ),
      events,
      attachments,
    };
  }

  async function create({
    portalType = "",
    signedIn = false,
    account = null,
    name = "",
    email = "",
    phone = "",
    description = "",
    photo = null,
    submissionKey = null,
  }) {
    if (submissionKey) {
      const existingEv = await db
        .prepare(
          "SELECT ticket_id FROM support_ticket_events WHERE message_id=?",
        )
        .get(`sub:${submissionKey}`);
      if (existingEv?.ticket_id) {
        const existingTicket = await getTicketById(existingEv.ticket_id);
        if (existingTicket) {
          const atts = await listAttachments(existingTicket.id);
          return {
            ticket: formatTicketRow(existingTicket, description, atts),
            duplicate: true,
          };
        }
      }
    }

    const subject =
      cleanText(description, 120) ||
      `Support request from ${cleanText(name, 80) || "User"}`;
    const bodyWithPhone = phone
      ? `${cleanText(description, 9500)}\n\nContact Phone: ${cleanText(phone, 30)}`
      : cleanText(description, 10_000);

    const created = await createTicket({
      subject,
      category: portalType || "general",
      priority: "normal",
      body: bodyWithPhone,
      requesterRole: portalType || (signedIn ? "partner" : "public"),
      requesterId: account ? String(account.id || account.login_id || "") : "",
      requesterName: name,
      requesterEmail: email,
      attachments: photo ? [photo] : [],
      messageId: submissionKey ? `sub:${submissionKey}` : null,
    });

    return {
      ticket: formatTicketRow(created.ticket, description, created.attachments),
      duplicate: false,
    };
  }

  async function listEvents(ticketId) {
    const rows = await db
      .prepare(
        "SELECT * FROM support_ticket_events WHERE ticket_id=? ORDER BY created_at ASC",
      )
      .all(String(ticketId || ""));
    return rows.map((r) => {
      let parsedMeta = null;
      if (r.meta) {
        try {
          parsedMeta = JSON.parse(r.meta);
        } catch {
          parsedMeta = null;
        }
      }
      return { ...r, meta: parsedMeta };
    });
  }

  async function addEvent({
    ticketId,
    eventType = "message",
    actorRole = "",
    actorId = "",
    actorName = "",
    body = "",
    meta = null,
    messageId = null,
  }) {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const normalizedMessageId = messageId ? cleanText(messageId, 300) : null;

    if (normalizedMessageId) {
      const existing = await db
        .prepare(
          "SELECT * FROM support_ticket_events WHERE ticket_id=? AND message_id=?",
        )
        .get(String(ticketId), normalizedMessageId);
      if (existing) return existing;
    }

    await db
      .prepare(
        `INSERT INTO support_ticket_events(
          id, ticket_id, event_type, actor_role, actor_id, actor_name, body, meta, message_id, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        String(ticketId),
        cleanText(eventType, 60) || "message",
        cleanText(actorRole, 40),
        cleanText(actorId, 120),
        cleanText(actorName, 160),
        cleanText(body, 10_000),
        meta ? JSON.stringify(meta) : null,
        normalizedMessageId,
        createdAt,
      );

    await db
      .prepare("UPDATE support_tickets SET updated_at=? WHERE id=?")
      .run(createdAt, String(ticketId));

    return db.prepare("SELECT * FROM support_ticket_events WHERE id=?").get(id);
  }

  async function createTicket({
    subject,
    category = "general",
    priority = "normal",
    body = "",
    requesterRole = "",
    requesterId = "",
    requesterName = "",
    requesterEmail = "",
    attachments = [],
    messageId = null,
  }) {
    const cleanSubject = cleanText(subject, 240);
    if (!cleanSubject) {
      throw new SupportError("Ticket subject is required.", 400);
    }

    const normalizedPriority = ALLOWED_PRIORITIES.has(
      String(priority || "").toLowerCase(),
    )
      ? String(priority).toLowerCase()
      : "normal";

    const id = crypto.randomUUID();
    let ticketCode = makeTicketCode();
    while (await getTicketByCode(ticketCode)) {
      ticketCode = makeTicketCode();
    }

    const createdAt = nowIso();
    await db
      .prepare(
        `INSERT INTO support_tickets(
          id, ticket_code, subject, category, priority, status,
          requester_role, requester_id, requester_name, requester_email,
          assigned_to, created_at, updated_at, closed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        ticketCode,
        cleanSubject,
        cleanText(category, 80) || "general",
        normalizedPriority,
        "open",
        cleanText(requesterRole, 40),
        cleanText(requesterId, 120),
        cleanText(requesterName, 160),
        cleanText(requesterEmail, 254),
        null,
        createdAt,
        createdAt,
        null,
      );

    const event = await addEvent({
      ticketId: id,
      eventType: "created",
      actorRole: requesterRole,
      actorId: requesterId,
      actorName: requesterName,
      body: cleanText(body, 10_000) || cleanSubject,
      messageId,
    });

    const savedAttachments = [];
    for (const file of Array.isArray(attachments) ? attachments : []) {
      if (!file || !file.buffer || !file.size) continue;
      const saved = await saveAttachment({
        ticketId: id,
        eventId: event.id,
        file,
      });
      savedAttachments.push(saved);
    }

    const ticket = await getTicketById(id);
    return { ticket, event, attachments: savedAttachments };
  }

  async function updateStatus({
    ticketId,
    status,
    actorRole = "",
    actorId = "",
    actorName = "",
    note = "",
  }) {
    const normalized = String(status || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_STATUSES.has(normalized)) {
      throw new SupportError("Invalid support ticket status.", 400);
    }
    const existing = await getTicketById(ticketId);
    if (!existing) return null;

    const updatedAt = nowIso();
    const closedAt =
      normalized === "closed" || normalized === "resolved"
        ? existing.closed_at || updatedAt
        : null;

    await db
      .prepare(
        "UPDATE support_tickets SET status=?, updated_at=?, closed_at=? WHERE id=?",
      )
      .run(normalized, updatedAt, closedAt, existing.id);

    await addEvent({
      ticketId: existing.id,
      eventType: "status_changed",
      actorRole,
      actorId,
      actorName,
      body:
        cleanText(note, 2000) ||
        `Status changed from ${existing.status} to ${normalized}.`,
      meta: { from: existing.status, to: normalized },
    });

    return getTicketById(existing.id);
  }

  async function saveAttachment({ ticketId, eventId = null, file }) {
    const attId = crypto.randomUUID();
    const mime = cleanText(file.mimetype, 120) || "application/octet-stream";
    const ext =
      MIME_TO_EXT[mime.toLowerCase()] ||
      path.extname(String(file.originalname || "")).slice(0, 12);
    const storedName = `${attId}${ext}`;
    const createdAt = nowIso();
    const safeName =
      path
        .basename(String(file.originalname || "attachment"))
        .replace(/[^\w.\- ()]/g, "_")
        .slice(0, 120) || "attachment";

    if (useSupabaseStorage) {
      await uploadToSupabase(`${ticketId}/${storedName}`, file.buffer, mime);
    } else {
      const ticketDir = path.join(supportUploadRoot, String(ticketId));
      fs.mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(ticketDir, storedName), file.buffer, {
        mode: 0o600,
      });
    }

    await db
      .prepare(
        `INSERT INTO support_ticket_attachments(
          id, ticket_id, event_id, original_name, mime, size, stored_name, created_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        attId,
        String(ticketId),
        eventId ? String(eventId) : null,
        safeName,
        mime,
        Number(file.size || 0),
        storedName,
        createdAt,
      );

    return db
      .prepare("SELECT * FROM support_ticket_attachments WHERE id=?")
      .get(attId);
  }

  async function listAttachments(ticketId) {
    return db
      .prepare(
        "SELECT * FROM support_ticket_attachments WHERE ticket_id=? ORDER BY created_at ASC",
      )
      .all(String(ticketId || ""));
  }

  async function getAttachment(attachmentId) {
    return db
      .prepare("SELECT * FROM support_ticket_attachments WHERE id=?")
      .get(String(attachmentId || ""));
  }

  return {
    TEXT_LIMITS,
    create,
    createTicket,
    addEvent,
    events: listEvents,
    updateStatus,
    setStatus,
    getTicketById,
    getTicketByCode,
    ticketForMessageRefs,
    listTickets,
    listForAdmin,
    getForAdmin,
    listForAccount,
    getForAccount,
    rowForAccount,
    rowById,
    photoFor,
    partnerFollowUp,
    adminReply,
    listEvents,
    saveAttachment,
    listAttachments,
    getAttachment,
  };
}
