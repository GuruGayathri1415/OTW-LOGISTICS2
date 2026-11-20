// Support tickets, events, and attachments backed by the async PostgreSQL adapter (`db-adapter.js`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_STATUSES = new Set([
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
]);

const ALLOWED_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

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
      throw new Error("Ticket subject is required.");
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
      throw new Error("Invalid support ticket status.");
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
    const ext = path.extname(String(file.originalname || "")).slice(0, 12);
    const storedName = `${attId}${ext}`;
    const ticketDir = path.join(supportUploadRoot, String(ticketId));
    fs.mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ticketDir, storedName), file.buffer, {
      mode: 0o600,
    });

    const createdAt = nowIso();
    const safeName =
      path
        .basename(String(file.originalname || "attachment"))
        .replace(/[^\w.\- ()]/g, "_")
        .slice(0, 120) || "attachment";

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
        cleanText(file.mimetype, 120) || "application/octet-stream",
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
    createTicket,
    addEvent,
    updateStatus,
    getTicketById,
    getTicketByCode,
    listTickets,
    listEvents,
    saveAttachment,
    listAttachments,
    getAttachment,
  };
}
