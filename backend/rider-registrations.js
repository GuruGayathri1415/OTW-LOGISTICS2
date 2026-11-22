// Rider member registrations.
//
// A rider is registered once (Rider ID, name, mobile number, hub pincode, hub location, a selfie / screenshot
// and an Aadhaar card) by the Admin, a Vendor or a Franchise. Every registration starts as PENDING.
// Decisions (APPROVED / REJECTED, with remarks):
//   - an admin can decide on any registration;
//   - a vendor can decide only on the riders it registered;
//   - a franchise cannot decide on anything (it sees the status and the admin's remarks only).
//
// Files are persisted in Supabase Storage when configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY),
// with fallback/mirroring to local uploadDir so files survive Render container restarts.
// rider-registration-routes.js exposes it over HTTP.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export const REG_STATUSES = ["PENDING", "APPROVED", "REJECTED"];
export const REG_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const REG_PORTALS = ["admin", "vendor", "franchise"];
export const REG_DECIDER_ROLES = ["admin", "vendor"];
const SOURCE_BY_ROLE = {
  admin: "Admin",
  vendor: "Vendor",
  franchise: "Franchise",
};
const ADMIN_LABEL = "On The Way Logistics";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DOCUMENTS = {
  selfie: { label: "rider selfie / screenshot", types: IMAGE_TYPES },
  aadhaar: {
    label: "Aadhaar card",
    types: [...IMAGE_TYPES, "application/pdf"],
  },
};
const EXTENSION = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};
const DEFAULT_BUCKET = "rider-registrations";

export class RegistrationError extends Error {
  constructor(status, message, field = "") {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export function sniffType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length > 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    b.length > 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-")
    return "application/pdf";
  return "";
}

export function normalizeRiderKey(riderId) {
  return String(riderId ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function cleanMobile(value) {
  let d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

function safeFileName(original, fallback) {
  const base = path
    .basename(String(original ?? ""))
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 100);
  return base || fallback;
}

export function validateRegistrationFields(raw = {}) {
  const riderId = String(raw.riderId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{1,39}$/.test(riderId)) {
    throw new RegistrationError(
      400,
      "Rider ID must be 2 to 40 letters, numbers, dashes or slashes, with no spaces.",
      "riderId",
    );
  }
  const riderName = String(raw.riderName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!riderName)
    throw new RegistrationError(400, "Enter the rider name.", "riderName");
  if (riderName.length > 100)
    throw new RegistrationError(
      400,
      "The rider name is too long (100 characters at most).",
      "riderName",
    );
  if (/\d/.test(riderName))
    throw new RegistrationError(
      400,
      "The rider name cannot contain numbers.",
      "riderName",
    );
  if (
    !/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(riderName) ||
    (riderName.match(/\p{L}/gu) || []).length < 2
  ) {
    throw new RegistrationError(
      400,
      "The rider name can only contain letters, spaces and . ' -",
      "riderName",
    );
  }
  const mobileNumber = cleanMobile(raw.mobile);
  if (!mobileNumber)
    throw new RegistrationError(
      400,
      "Enter a 10-digit mobile number starting with 6, 7, 8 or 9.",
      "mobile",
    );
  const hubPincode = String(raw.hubPincode ?? "").trim();
  if (!/^[1-9]\d{5}$/.test(hubPincode))
    throw new RegistrationError(
      400,
      "Enter the 6-digit hub pincode.",
      "hubPincode",
    );
  const hubLocation = String(raw.hubLocation ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (hubLocation.length < 2)
    throw new RegistrationError(400, "Enter the hub location.", "hubLocation");
  if (hubLocation.length > 120)
    throw new RegistrationError(
      400,
      "The hub location is too long (120 characters at most).",
      "hubLocation",
    );
  return {
    riderId,
    riderKey: normalizeRiderKey(riderId),
    riderName,
    mobileNumber,
    hubPincode,
    hubLocation,
  };
}

export function checkDocuments(files = {}) {
  const out = {};
  for (const [kind, spec] of Object.entries(DOCUMENTS)) {
    const f = files[kind];
    const requirement =
      kind === "selfie"
        ? "Upload the rider selfie or screenshot (JPG, PNG or WEBP image)."
        : "Upload the Aadhaar card (JPG, PNG, WEBP image or PDF).";
    if (!f || !f.buffer || !f.buffer.length)
      throw new RegistrationError(400, requirement, kind);
    if (f.buffer.length > REG_MAX_FILE_BYTES)
      throw new RegistrationError(
        400,
        `The ${spec.label} file is larger than 5 MB.`,
        kind,
      );
    const type = sniffType(f.buffer);
    if (!spec.types.includes(type)) {
      throw new RegistrationError(
        400,
        kind === "selfie"
          ? "The selfie must be a real JPG, PNG or WEBP image."
          : "The Aadhaar card must be a real JPG, PNG, WEBP image or PDF file.",
        kind,
      );
    }
    out[kind] = {
      buffer: f.buffer,
      type,
      name: safeFileName(f.originalname, kind + EXTENSION[type]),
      size: f.buffer.length,
    };
  }
  return out;
}

const isUniqueViolation = (err) =>
  err?.code === "23505" ||
  /UNIQUE constraint failed|duplicate key/i.test(String(err?.message || ""));

function createStorageAdapter({ uploadDir }) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "",
  ).trim();
  const bucket = String(
    process.env.SUPABASE_STORAGE_BUCKET ||
      process.env.RIDER_STORAGE_BUCKET ||
      DEFAULT_BUCKET,
  ).trim();

  const client =
    supabaseUrl && serviceKey
      ? createClient(supabaseUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  let bucketChecked = false;

  async function ensureBucket() {
    if (!client || bucketChecked) return;
    bucketChecked = true;
    try {
      const { data: buckets, error } = await client.storage.listBuckets();
      if (error) return;
      const exists = (buckets || []).some((b) => b.name === bucket);
      if (!exists) {
        await client.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: REG_MAX_FILE_BYTES,
        });
      }
    } catch (_) {
      // Bucket may already exist or be managed manually in Supabase Storage
    }
  }

  async function saveFile(relPath, doc) {
    if (uploadDir) {
      const root = path.resolve(uploadDir);
      const abs = path.resolve(root, relPath);
      if (abs.startsWith(root + path.sep)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
        fs.writeFileSync(abs, doc.buffer, { mode: 0o600 });
      }
    }
    if (client) {
      await ensureBucket();
      const { error } = await client.storage
        .from(bucket)
        .upload(relPath, doc.buffer, {
          contentType: doc.type,
          upsert: true,
        });
      if (error) {
        throw new RegistrationError(
          500,
          `Could not store ${doc.name} in Supabase Storage: ${error.message}`,
        );
      }
    }
  }

  async function readFile(relPath) {
    const cleanRel = String(relPath || "").replace(/^\/+/, "");
    if (client && cleanRel) {
      await ensureBucket();
      const { data, error } = await client.storage
        .from(bucket)
        .download(cleanRel);
      if (!error && data) {
        const ab = await data.arrayBuffer();
        return Buffer.from(ab);
      }
    }
    if (uploadDir && cleanRel) {
      const root = path.resolve(uploadDir);
      const abs = path.resolve(root, cleanRel);
      if (abs.startsWith(root + path.sep) && fs.existsSync(abs)) {
        return fs.readFileSync(abs);
      }
    }
    return null;
  }

  async function removePrefix(folderRel) {
    const cleanFolder = String(folderRel || "").replace(/^\/+|\/+$/g, "");
    if (uploadDir && cleanFolder) {
      const root = path.resolve(uploadDir);
      const dir = path.resolve(root, cleanFolder);
      if (dir.startsWith(root + path.sep)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    if (client && cleanFolder) {
      try {
        const { data: files } = await client.storage
          .from(bucket)
          .list(cleanFolder);
        if (files && files.length) {
          const paths = files.map((f) => `${cleanFolder}/${f.name}`);
          await client.storage.from(bucket).remove(paths);
        }
      } catch {}
    }
  }

  return { saveFile, readFile, removePrefix };
}

export async function createRiderRegistrationService({
  db,
  uploadDir,
  audit = () => {},
  now = () => new Date().toISOString(),
}) {
  const storage = createStorageAdapter({ uploadDir });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS rider_registrations(
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL UNIQUE,
      rider_id TEXT NOT NULL,
      rider_key TEXT NOT NULL,
      rider_name TEXT NOT NULL,
      mobile_number TEXT NOT NULL,
      hub_pincode TEXT NOT NULL,
      hub_location TEXT NOT NULL,
      selfie_path TEXT NOT NULL,
      selfie_name TEXT NOT NULL,
      selfie_type TEXT NOT NULL,
      selfie_size INTEGER NOT NULL,
      aadhaar_path TEXT NOT NULL,
      aadhaar_name TEXT NOT NULL,
      aadhaar_type TEXT NOT NULL,
      aadhaar_size INTEGER NOT NULL,
      registration_source TEXT NOT NULL,
      owner_account_id TEXT,
      owner_login_id TEXT,
      owner_name TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'PENDING',
      rejection_remarks TEXT,
      decision_remarks TEXT,
      approved_by TEXT,
      approval_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rider_registrations_live_rider
      ON rider_registrations(rider_key) WHERE application_status <> 'REJECTED';
    CREATE INDEX IF NOT EXISTS rider_registrations_owner ON rider_registrations(owner_account_id, registration_source);
    CREATE TABLE IF NOT EXISTS rider_registration_history(
      id BIGSERIAL PRIMARY KEY,
      registration_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      remarks TEXT,
      actor TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rider_registration_history_reg ON rider_registration_history(registration_id, id);
    CREATE TABLE IF NOT EXISTS rider_registration_counter(id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
    INSERT INTO rider_registration_counter(id, last) VALUES(1, 0) ON CONFLICT(id) DO NOTHING;
  `);

  const columnRows = await db
    .prepare(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rider_registrations'`,
    )
    .all();
  const existingColumns = new Set(columnRows.map((c) => c.name));
  if (!existingColumns.has("owner_name"))
    await db.exec(
      "ALTER TABLE rider_registrations ADD COLUMN owner_name TEXT NOT NULL DEFAULT ''",
    );
  if (!existingColumns.has("decision_remarks"))
    await db.exec(
      "ALTER TABLE rider_registrations ADD COLUMN decision_remarks TEXT",
    );

  const statements = {
    byId: db.prepare("SELECT * FROM rider_registrations WHERE id = ?"),
    liveByRider: db.prepare(
      "SELECT id, application_id FROM rider_registrations WHERE rider_key = ? AND application_status <> 'REJECTED' AND id <> ?",
    ),
    insertHistory:
      db.prepare(`INSERT INTO rider_registration_history(registration_id, from_status, to_status, remarks, actor, actor_role, created_at)
        VALUES(?,?,?,?,?,?,?)`),
    historyFor: db.prepare(
      "SELECT * FROM rider_registration_history WHERE registration_id = ? ORDER BY id ASC",
    ),
  };

  const runTx = db.transaction(async (tx, fn) => fn(tx));

  async function nextApplicationId(tx = db) {
    await tx
      .prepare(
        "UPDATE rider_registration_counter SET last = last + 1 WHERE id = 1",
      )
      .run();
    const row = await tx
      .prepare("SELECT last FROM rider_registration_counter WHERE id = 1")
      .get();
    return "RM-" + String(row.last).padStart(6, "0");
  }

  function assertActor(actor) {
    if (!SOURCE_BY_ROLE[actor?.role])
      throw new RegistrationError(
        403,
        "This account cannot use rider applications.",
      );
  }

  function scopeFor(actor) {
    if (actor.role === "admin") return { sql: "1 = 1", params: [] };
    return {
      sql: "owner_account_id = ? AND registration_source = ?",
      params: [actor.accountId, SOURCE_BY_ROLE[actor.role]],
    };
  }

  async function visibleRow(actor, id) {
    const scope = scopeFor(actor);
    return db
      .prepare(
        `SELECT * FROM rider_registrations WHERE id = ? AND ${scope.sql}`,
      )
      .get(String(id), ...scope.params);
  }

  function toPublic(row, history = null) {
    const out = {
      id: row.id,
      applicationId: row.application_id,
      riderId: row.rider_id,
      riderName: row.rider_name,
      mobileNumber: row.mobile_number,
      hubPincode: row.hub_pincode,
      hubLocation: row.hub_location,
      selfie: {
        name: row.selfie_name,
        type: row.selfie_type,
        size: row.selfie_size,
      },
      aadhaar: {
        name: row.aadhaar_name,
        type: row.aadhaar_type,
        size: row.aadhaar_size,
      },
      registrationSource: row.registration_source,
      appliedBy: row.registration_source,
      ownerLoginId: row.owner_login_id || "",
      ownerName: row.owner_name || "",
      createdBy: row.created_by,
      status: row.application_status,
      rejectionRemarks: row.rejection_remarks || "",
      decisionRemarks: row.decision_remarks || "",
      approvedBy: row.approved_by || "",
      approvalDate: row.approval_date || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (history) {
      out.history = history.map((h) => ({
        fromStatus: h.from_status || "",
        toStatus: h.to_status,
        remarks: h.remarks || "",
        actor: h.actor,
        actorRole: h.actor_role,
        at: h.created_at,
      }));
    }
    return out;
  }

  function forViewer(actor, item) {
    if (actor.role !== "franchise") return item;
    const out = { ...item, approvedBy: item.approvedBy ? ADMIN_LABEL : "" };
    if (item.history)
      out.history = item.history.map((h) => ({
        ...h,
        actor: h.actorRole === "admin" ? ADMIN_LABEL : h.actor,
      }));
    return out;
  }

  async function list(actor) {
    assertActor(actor);
    const scope = scopeFor(actor);
    const rows = await db
      .prepare(
        `SELECT * FROM rider_registrations WHERE ${scope.sql} ORDER BY created_at DESC, application_id DESC`,
      )
      .all(...scope.params);
    return rows.map((row) => forViewer(actor, toPublic(row)));
  }

  async function get(actor, id) {
    assertActor(actor);
    const row = await visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "Rider application not found.");
    const history = await statements.historyFor.all(row.id);
    return forViewer(actor, toPublic(row, history));
  }

  async function create(actor, rawFields, files) {
    assertActor(actor);
    const fields = validateRegistrationFields(rawFields);
    const docs = checkDocuments(files);
    const identity = String(actor.identity || actor.role);
    const liveNow = await statements.liveByRider.get(fields.riderKey, "");
    if (liveNow) throw duplicateError(fields, liveNow);

    const id = crypto.randomUUID();
    const folderRel = path.posix.join("registrations", id);
    try {
      const stored = {};
      for (const kind of Object.keys(docs)) {
        const rel = path.posix.join(
          folderRel,
          kind + EXTENSION[docs[kind].type],
        );
        await storage.saveFile(rel, docs[kind]);
        stored[kind] = rel;
      }
      const stamp = now();
      const owner = actor.role === "admin" ? null : actor;
      const ownerName = owner
        ? String(actor.ownerName || actor.identity || "").slice(0, 100)
        : "";
      await runTx(async (tx) => {
        const clash = await tx
          .prepare(
            "SELECT id, application_id FROM rider_registrations WHERE rider_key = ? AND application_status <> 'REJECTED' AND id <> ?",
          )
          .get(fields.riderKey, "");
        if (clash) throw duplicateError(fields, clash);
        const applicationId = await nextApplicationId(tx);
        await tx
          .prepare(
            `INSERT INTO rider_registrations(id, application_id, rider_id, rider_key, rider_name, mobile_number, hub_pincode, hub_location,
            selfie_path, selfie_name, selfie_type, selfie_size, aadhaar_path, aadhaar_name, aadhaar_type, aadhaar_size,
            registration_source, owner_account_id, owner_login_id, owner_name, created_by, application_status, rejection_remarks,
            decision_remarks, approved_by, approval_date, created_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            applicationId,
            fields.riderId,
            fields.riderKey,
            fields.riderName,
            fields.mobileNumber,
            fields.hubPincode,
            fields.hubLocation,
            stored.selfie,
            docs.selfie.name,
            docs.selfie.type,
            docs.selfie.size,
            stored.aadhaar,
            docs.aadhaar.name,
            docs.aadhaar.type,
            docs.aadhaar.size,
            SOURCE_BY_ROLE[actor.role],
            owner?.accountId || null,
            owner ? identity : null,
            ownerName,
            identity,
            "PENDING",
            null,
            null,
            null,
            null,
            stamp,
            stamp,
          );
        await tx
          .prepare(
            `INSERT INTO rider_registration_history(registration_id, from_status, to_status, remarks, actor, actor_role, created_at)
            VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            null,
            "PENDING",
            "Registration submitted",
            identity,
            actor.role,
            stamp,
          );
      });
      const row = await statements.byId.get(id);
      await audit(identity, "rider_registration_created", {
        applicationId: row.application_id,
        riderId: row.rider_id,
        source: row.registration_source,
      });
      const history = await statements.historyFor.all(id);
      return toPublic(row, history);
    } catch (err) {
      await storage.removePrefix(folderRel);
      if (err instanceof RegistrationError) throw err;
      if (isUniqueViolation(err) && String(err.message).includes("rider_key")) {
        throw new RegistrationError(
          409,
          `Rider ID ${fields.riderId} is already registered. Each rider can only be registered once.`,
          "riderId",
        );
      }
      throw err;
    }
  }

  function duplicateError(fields, existing) {
    return new RegistrationError(
      409,
      `Rider ID ${fields.riderId} is already registered (application ${existing.application_id}). Each rider can only be registered once.`,
      "riderId",
    );
  }

  async function update(actor, id, rawFields = {}, files = {}) {
    assertActor(actor);
    if (actor.role !== "admin")
      throw new RegistrationError(
        403,
        "Only the admin can edit an active rider profile.",
      );
    const row = await visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "Rider application not found.");
    const fields = validateRegistrationFields(rawFields);
    const clash = await statements.liveByRider.get(fields.riderKey, row.id);
    if (clash)
      throw new RegistrationError(
        409,
        `Rider ID ${fields.riderId} is already assigned to another live rider.`,
        "riderId",
      );

    const replacements = {};
    for (const kind of Object.keys(DOCUMENTS)) {
      const file = files[kind];
      if (!file || !file.buffer || !file.buffer.length) continue;
      if (file.buffer.length > REG_MAX_FILE_BYTES)
        throw new RegistrationError(
          400,
          `The ${DOCUMENTS[kind].label} file is larger than 5 MB.`,
          kind,
        );
      const type = sniffType(file.buffer);
      if (!DOCUMENTS[kind].types.includes(type))
        throw new RegistrationError(
          400,
          kind === "selfie"
            ? "The selfie must be a real JPG, PNG or WEBP image."
            : "The Aadhaar card must be a real JPG, PNG, WEBP image or PDF file.",
          kind,
        );
      replacements[kind] = {
        buffer: file.buffer,
        type,
        name: safeFileName(file.originalname, kind + EXTENSION[type]),
        size: file.buffer.length,
      };
    }

    const next = {
      selfie_path: row.selfie_path,
      selfie_name: row.selfie_name,
      selfie_type: row.selfie_type,
      selfie_size: row.selfie_size,
      aadhaar_path: row.aadhaar_path,
      aadhaar_name: row.aadhaar_name,
      aadhaar_type: row.aadhaar_type,
      aadhaar_size: row.aadhaar_size,
    };
    const writtenRels = [];
    for (const [kind, doc] of Object.entries(replacements)) {
      const rel = path.posix.join(
        "registrations",
        row.id,
        kind + "-" + crypto.randomUUID() + EXTENSION[doc.type],
      );
      await storage.saveFile(rel, doc);
      writtenRels.push(rel);
      next[kind + "_path"] = rel;
      next[kind + "_name"] = doc.name;
      next[kind + "_type"] = doc.type;
      next[kind + "_size"] = doc.size;
    }
    const stamp = now(),
      identity = String(actor.identity || actor.role);
    try {
      await runTx(async (tx) => {
        const latestClash = await tx
          .prepare(
            "SELECT id, application_id FROM rider_registrations WHERE rider_key = ? AND application_status <> 'REJECTED' AND id <> ?",
          )
          .get(fields.riderKey, row.id);
        if (latestClash)
          throw new RegistrationError(
            409,
            `Rider ID ${fields.riderId} is already assigned to another live rider.`,
            "riderId",
          );
        await tx
          .prepare(
            `UPDATE rider_registrations SET rider_id = ?, rider_key = ?, rider_name = ?, mobile_number = ?,
            hub_pincode = ?, hub_location = ?, selfie_path = ?, selfie_name = ?, selfie_type = ?, selfie_size = ?,
            aadhaar_path = ?, aadhaar_name = ?, aadhaar_type = ?, aadhaar_size = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            fields.riderId,
            fields.riderKey,
            fields.riderName,
            fields.mobileNumber,
            fields.hubPincode,
            fields.hubLocation,
            next.selfie_path,
            next.selfie_name,
            next.selfie_type,
            next.selfie_size,
            next.aadhaar_path,
            next.aadhaar_name,
            next.aadhaar_type,
            next.aadhaar_size,
            stamp,
            row.id,
          );
      });
    } catch (err) {
      for (const rel of writtenRels) {
        if (uploadDir) {
          const root = path.resolve(uploadDir);
          const abs = path.resolve(root, rel);
          if (abs.startsWith(root + path.sep)) {
            try {
              fs.rmSync(abs, { force: true });
            } catch {}
          }
        }
      }
      if (isUniqueViolation(err))
        throw new RegistrationError(
          409,
          `Rider ID ${fields.riderId} is already assigned to another live rider.`,
          "riderId",
        );
      throw err;
    }
    await audit(identity, "rider_registration_updated", {
      riderId: fields.riderId,
      previousRiderId: row.rider_id,
      status: row.application_status,
    });
    return get(actor, row.id);
  }

  async function setStatus(actor, id, input = {}) {
    assertActor(actor);
    if (!REG_DECIDER_ROLES.includes(actor.role)) {
      throw new RegistrationError(
        403,
        "Only the On The Way Logistics admin can approve or reject rider applications.",
      );
    }
    const target = String(input.status ?? "")
      .trim()
      .toUpperCase();
    if (!REG_STATUSES.includes(target))
      throw new RegistrationError(
        400,
        "Status must be PENDING, APPROVED or REJECTED.",
        "status",
      );
    const remarks = String(input.remarks ?? "")
      .trim()
      .slice(0, 500);
    if (target === "REJECTED" && !remarks)
      throw new RegistrationError(
        400,
        "Enter the reason for rejecting this application.",
        "remarks",
      );
    const row = await visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "Rider application not found.");
    if (row.application_status === target)
      throw new RegistrationError(
        400,
        `This application is already ${target}.`,
      );
    const identity = String(actor.identity || actor.role);
    const stamp = now();
    await runTx(async (tx) => {
      if (target !== "REJECTED") {
        const clash = await tx
          .prepare(
            "SELECT id, application_id FROM rider_registrations WHERE rider_key = ? AND application_status <> 'REJECTED' AND id <> ?",
          )
          .get(row.rider_key, row.id);
        if (clash) {
          throw new RegistrationError(
            409,
            `Rider ID ${row.rider_id} already has a live application (${clash.application_id}). Reject that one first.`,
            "status",
          );
        }
      }
      await tx
        .prepare(
          `UPDATE rider_registrations SET application_status = ?, rejection_remarks = ?, decision_remarks = ?,
          approved_by = ?, approval_date = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          target,
          target === "REJECTED" ? remarks : null,
          target === "PENDING" ? null : remarks || null,
          target === "APPROVED" ? identity : null,
          target === "APPROVED" ? stamp : null,
          stamp,
          row.id,
        );
      await tx
        .prepare(
          `INSERT INTO rider_registration_history(registration_id, from_status, to_status, remarks, actor, actor_role, created_at)
          VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          row.id,
          row.application_status,
          target,
          remarks || null,
          identity,
          actor.role,
          stamp,
        );
    });
    await audit(identity, "rider_registration_" + target.toLowerCase(), {
      applicationId: row.application_id,
      riderId: row.rider_id,
      from: row.application_status,
      remarks: remarks || "",
    });
    return get(actor, row.id);
  }

  async function fileFor(actor, id, kind) {
    assertActor(actor);
    if (!DOCUMENTS[kind]) throw new RegistrationError(404, "File not found.");
    const row = await visibleRow(actor, id);
    if (!row) throw new RegistrationError(404, "File not found.");
    const rel = kind === "selfie" ? row.selfie_path : row.aadhaar_path;
    const buffer = await storage.readFile(rel);
    if (!buffer || !buffer.length) {
      throw new RegistrationError(
        404,
        "The file is missing on the server. Ask the administrator to check the uploads folder.",
      );
    }
    if (kind === "aadhaar") {
      await audit(
        String(actor.identity || actor.role),
        "rider_aadhaar_viewed",
        {
          applicationId: row.application_id,
          riderId: row.rider_id,
        },
      );
    }
    return {
      buffer,
      path: uploadDir ? path.resolve(path.resolve(uploadDir), rel) : "",
      type: kind === "selfie" ? row.selfie_type : row.aadhaar_type,
      name: kind === "selfie" ? row.selfie_name : row.aadhaar_name,
    };
  }

  return { list, get, create, update, setStatus, fileFor };
}
