// Payment Management: the Weekly Payments table (Admin Portal only).
//
// Every imported Excel row is stored in the `weekly_payments` table of the PostgreSQL database,
// one row per rider per week. The weekly amount is stored exactly as read from the Excel sheet (the original
// text of the cell is kept too), separately for each rider and week.
//
// Duplicate rule: permanent Rider ID + exact payment period for verified riders; a stable provisional key
// is used for unverified Excel riders until Admin maps them. The browser parses the workbook, while this
// service verifies registrations, stores provisional rows, and safely transfers them after Admin mapping.
import crypto from "node:crypto";
import { normalizeRiderKey } from "./rider-registrations.js";
import { PAYMENT_STATUSES } from "./report-stats.js";

export const MAX_IMPORT_RECORDS = 20000;

export class WeeklyPaymentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (v) =>
  (v === null || v === undefined ? "" : String(v)).replace(/\s+/g, " ").trim();
// Preserve meaningful text inside brackets (e.g. a rider's hub), while ignoring bracket style,
// punctuation, casing and repeated spaces.
const normalizeRiderName = (v) =>
  clean(v)
    .toLowerCase()
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const num = (v) =>
  v === null || v === undefined || v === ""
    ? null
    : Number.isFinite(Number(v))
      ? Number(v)
      : null;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);

const COLUMNS = [
  "rider_key",
  "week_key",
  "name_key",
  "week_label",
  "week_start",
  "week_end",
  "rider_name",
  "rider_id",
  "days",
  "total_orders",
  "lm",
  "primary_orders",
  "club",
  "sdd",
  "lm_amount",
  "prime_amount",
  "club_amount",
  "sdd_amount",
  "amount",
  "amount_raw",
  "source_file",
  "sheet",
  "row_number",
  "original",
  "rate_lm",
  "rate_prime",
  "rate_club",
  "rate_sdd",
];
const VALUE_COLUMNS = COLUMNS.slice(3);
const nameKeyOf = (v) =>
  clean(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const moneyOrZero = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? 0
    : Number(v);
// Category amounts keep a missing value as NULL (shown as —), so a blank is never confused with a real ₹0.

export function resolveRiders(
  records,
  registrations,
  savedMappings = new Map(),
) {
  const byKey = new Map();
  for (const g of registrations) {
    if (g.rider_key && !byKey.has(g.rider_key)) byKey.set(g.rider_key, g);
  }
  const out = [],
    review = [],
    corrections = [];
  records.forEach((r, i) => {
    const sheetId = normalizeRiderKey(r.riderId);
    const nameKey = normalizeRiderName(r.riderName);
    const label = `${r.riderName || "Unnamed"} (${r.weekLabel || "no week"})`;
    if (r.mappedRiderId) {
      const mapped = byKey.get(normalizeRiderKey(r.mappedRiderId));
      if (mapped) {
        out.push({
          ...r,
          riderId: mapped.rider_id,
          riderKey: "id:" + String(mapped.rider_id).toLowerCase(),
          riderName: mapped.rider_name,
        });
        return;
      }
      review.push({
        row: i + 1,
        record: r,
        rider: r.riderName,
        reason: `${label}: the mapped Rider ID ${r.mappedRiderId} is no longer an approved rider. Kept pending.`,
      });
      return;
    }
    const savedId = savedMappings.get(nameKey + "|" + sheetId);
    if (savedId) {
      const mapped = byKey.get(normalizeRiderKey(savedId));
      if (mapped) {
        out.push({
          ...r,
          riderId: mapped.rider_id,
          riderKey: "id:" + String(mapped.rider_id).toLowerCase(),
          riderName: mapped.rider_name,
        });
        return;
      }
    }
    const reg = sheetId ? byKey.get(sheetId) : null;
    if (!reg) {
      review.push({
        row: i + 1,
        record: r,
        rider: r.riderName,
        reason: `${label}: Rider ID ${sheetId || "(blank)"} is not in Rider Registration as an APPROVED rider. Saved provisionally; Admin verification is required. No franchise is assigned.`,
      });
      return;
    }
    if (normalizeRiderName(reg.rider_name) !== nameKey) {
      corrections.push({
        row: i + 1,
        rider: r.riderName,
        from: r.riderName || "(blank)",
        to: reg.rider_name,
        riderId: reg.rider_id,
      });
    }
    out.push({
      ...r,
      riderId: reg.rider_id,
      riderKey: "id:" + String(reg.rider_id).toLowerCase(),
      riderName: reg.rider_name,
    });
  });
  return { records: out, review, corrections };
}

export async function createWeeklyPaymentService({
  db,
  audit = async () => {},
  riderRegistry = false,
  onSaved = null,
}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS weekly_payments(
    id BIGSERIAL PRIMARY KEY,
    rider_key TEXT NOT NULL,
    week_key TEXT NOT NULL,
    name_key TEXT NOT NULL DEFAULT '',
    week_label TEXT NOT NULL,
    week_start TEXT NOT NULL DEFAULT '',
    week_end TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL,
    rider_id TEXT NOT NULL DEFAULT '',
    days REAL, total_orders REAL, lm REAL, primary_orders REAL, club REAL, sdd REAL,
    lm_amount REAL, prime_amount REAL, club_amount REAL, sdd_amount REAL, amount REAL,
    amount_raw TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    sheet TEXT NOT NULL DEFAULT '',
    row_number INTEGER,
    original TEXT NOT NULL DEFAULT '{}',
    import_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(rider_key, week_key)
  );
  CREATE INDEX IF NOT EXISTS weekly_payments_week ON weekly_payments(week_start);
  CREATE TABLE IF NOT EXISTS weekly_payment_imports(
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL,
    imported_by TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL, inserted INTEGER NOT NULL, updated INTEGER NOT NULL, unchanged INTEGER NOT NULL,
    amount_total REAL NOT NULL DEFAULT 0,
    weeks TEXT NOT NULL DEFAULT '[]'
  );`);

  await db.exec(`CREATE TABLE IF NOT EXISTS weekly_payment_pending(
    id BIGSERIAL PRIMARY KEY,
    pending_key TEXT NOT NULL UNIQUE,
    excel_rider_id TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL,
    week_key TEXT NOT NULL,
    week_label TEXT NOT NULL DEFAULT '',
    week_start TEXT NOT NULL DEFAULT '',
    week_end TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    reason TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'PENDING',
    mapped_rider_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS weekly_payment_rider_mappings(
    mapping_key TEXT PRIMARY KEY,
    excel_rider_id TEXT NOT NULL DEFAULT '',
    excel_rider_name TEXT NOT NULL,
    registered_rider_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS weekly_payment_provisional_riders(
    mapping_key TEXT PRIMARY KEY,
    excel_rider_id TEXT NOT NULL DEFAULT '',
    rider_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    reason TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_rider_id TEXT NOT NULL DEFAULT ''
  )`);

  const colRows = await db
    .prepare(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'weekly_payments'`,
    )
    .all();
  const existingColumns = new Set(colRows.map((c) => c.name));

  if (!existingColumns.has("payment_status"))
    await db.exec(
      "ALTER TABLE weekly_payments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'PENDING'",
    );
  for (const [name, type] of [
    ["sdd", "REAL"],
    ["total_orders", "REAL"],
    ["lm_amount", "REAL"],
    ["prime_amount", "REAL"],
    ["club_amount", "REAL"],
    ["sdd_amount", "REAL"],
    ["rate_lm", "REAL"],
    ["rate_prime", "REAL"],
    ["rate_club", "REAL"],
    ["rate_sdd", "REAL"],
    ["payment_ref", "TEXT NOT NULL DEFAULT ''"],
    ["adjustment_reason", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!existingColumns.has(name))
      await db.exec(`ALTER TABLE weekly_payments ADD COLUMN ${name} ${type}`);
  }

  const selectByNameAll = db.prepare(
    "SELECT * FROM weekly_payments WHERE week_key = ? AND name_key = ?",
  );

  function normalise(r, i, fileName) {
    const riderName = clean(r?.riderName),
      riderKey = clean(r?.riderKey),
      weekKey = clean(r?.weekKey),
      weekLabel = clean(r?.weekLabel);
    const isProvisional = riderKey.startsWith("provisional:");
    if (!riderName || !riderKey || (!clean(r?.riderId) && !isProvisional))
      return {
        error: `Record ${i + 1}: a verified Rider ID or provisional rider key and rider name are required.`,
      };
    if (!weekKey || !weekLabel)
      return { error: `Record ${i + 1} (${riderName}): the week is missing.` };
    const weekStart = clean(r.weekStart),
      weekEnd = clean(r.weekEnd);
    if ((weekStart && !ISO.test(weekStart)) || (weekEnd && !ISO.test(weekEnd)))
      return {
        error: `Record ${i + 1} (${riderName}): the week dates are not valid.`,
      };
    for (const f of [
      "days",
      "totalOrders",
      "lm",
      "primary",
      "club",
      "sdd",
      "lmAmount",
      "primeAmount",
      "clubAmount",
      "sddAmount",
      "amount",
      "lmRate",
      "primeRate",
      "clubRate",
      "sddRate",
    ]) {
      if (
        r[f] !== null &&
        r[f] !== undefined &&
        r[f] !== "" &&
        num(r[f]) === null
      )
        return {
          error: `Record ${i + 1} (${riderName}): ${f} is not a number.`,
        };
    }
    let original = "{}";
    try {
      original = JSON.stringify(r.original ?? {}).slice(0, 20000);
    } catch {
      /* keep {} */
    }
    return {
      riderKey: riderKey.slice(0, 200),
      weekKey: weekKey.slice(0, 200),
      nameKey: nameKeyOf(riderName),
      values: [
        weekLabel.slice(0, 200),
        weekStart,
        weekEnd,
        riderName.slice(0, 200),
        clean(r.riderId).slice(0, 100),
        num(r.days),
        num(r.totalOrders),
        num(r.lm),
        num(r.primary),
        num(r.club),
        num(r.sdd),
        num(r.lmAmount),
        num(r.primeAmount),
        num(r.clubAmount),
        num(r.sddAmount),
        moneyOrZero(r.amount),
        clean(r.amountRaw).slice(0, 100),
        clean(fileName).slice(0, 200),
        clean(r.sheet).slice(0, 100),
        Number.isInteger(r.rowNumber) ? r.rowNumber : null,
        original,
        num(r.lmRate),
        num(r.primeRate),
        num(r.clubRate),
        num(r.sddRate),
      ],
    };
  }

  const same = (row, values) => {
    const cur = [
      row.week_label,
      row.week_start,
      row.week_end,
      row.rider_name,
      row.rider_id,
      row.days,
      row.total_orders,
      row.lm,
      row.primary_orders,
      row.club,
      row.sdd,
      row.lm_amount,
      row.prime_amount,
      row.club_amount,
      row.sdd_amount,
      row.amount,
      row.amount_raw,
      row.rate_lm,
      row.rate_prime,
      row.rate_club,
      row.rate_sdd,
    ];
    const want = [...values.slice(0, 17), ...values.slice(21, 25)];
    return cur.every((c, i) => (c ?? null) === (want[i] ?? null));
  };

  async function liveRegistrations(executor = db) {
    try {
      return await executor
        .prepare(
          "SELECT rider_id, rider_key, rider_name FROM rider_registrations WHERE application_status = 'APPROVED'",
        )
        .all();
    } catch {
      return [];
    }
  }

  const mappingKeyOf = (r) =>
    normalizeRiderName(r.riderName) + "|" + normalizeRiderKey(r.riderId);
  const provisionalKeyFor = (name, riderId) =>
    "provisional:" +
    crypto
      .createHash("sha256")
      .update(normalizeRiderName(name) + "|" + normalizeRiderKey(riderId))
      .digest("hex")
      .slice(0, 32);
  const provisionalKeyOf = (r) => provisionalKeyFor(r.riderName, r.riderId);
  const pendingKeyOf = (r) =>
    normalizeRiderName(r.riderName) +
    "|" +
    r.weekKey +
    "|" +
    normalizeRiderKey(r.riderId);

  async function pendingRows(executor = db) {
    return executor
      .prepare(
        "SELECT * FROM weekly_payment_pending WHERE status = 'PENDING' ORDER BY week_start, LOWER(rider_name), id",
      )
      .all();
  }

  async function backfillProvisionalRiderIds() {
    try {
      const blankProv = await db
        .prepare(
          "SELECT id, rider_key, week_key FROM weekly_payments WHERE rider_key LIKE 'provisional:%' AND (rider_id IS NULL OR rider_id = '')",
        )
        .all();
      if (!blankProv.length) return;
      const pend = await db
        .prepare(
          "SELECT rider_name, excel_rider_id, week_key, payload FROM weekly_payment_pending WHERE excel_rider_id <> ''",
        )
        .all();
      const byKeyAndWeek = new Map();
      const byKeyOnly = new Map();
      for (const p of pend) {
        let sheetId = clean(p.excel_rider_id);
        if (!sheetId && p.payload) {
          try {
            sheetId = clean(JSON.parse(p.payload).riderId);
          } catch {}
        }
        if (!sheetId) continue;
        const pKey = provisionalKeyFor(p.rider_name, sheetId);
        byKeyAndWeek.set(pKey + "\u0000" + p.week_key, sheetId);
        if (!byKeyOnly.has(pKey)) byKeyOnly.set(pKey, sheetId);
      }
      const updateStmt = db.prepare(
        "UPDATE weekly_payments SET rider_id = ? WHERE id = ?",
      );
      for (const row of blankProv) {
        const found =
          byKeyAndWeek.get(row.rider_key + "\u0000" + row.week_key) ||
          byKeyOnly.get(row.rider_key) ||
          "";
        if (found) await updateStmt.run(found.slice(0, 100), row.id);
      }
    } catch {
      /* non-fatal */
    }
  }

  await backfillProvisionalRiderIds();

  async function applyRecords(
    records,
    { fileName, fileHash, actor, recordImport = true },
  ) {
    let review = [],
      corrections = [],
      newVerified = 0,
      pendingVerified = 0,
      pendingStill = 0,
      registeredCount = 0,
      provisionalSaved = 0;
    let toSave = records,
      pendingReview = [],
      pendingResolved = [];
    if (riderRegistry) {
      const regs = await liveRegistrations();
      registeredCount = regs.length;
      const rawPending = await pendingRows();
      const pend = rawPending.map((p) => ({
        ...JSON.parse(p.payload),
        pendingId: p.id,
        mappedRiderId: p.mapped_rider_id || "",
      }));
      const mappingRows = await db
        .prepare(
          "SELECT mapping_key, registered_rider_id FROM weekly_payment_rider_mappings",
        )
        .all();
      const savedMappings = new Map(
        mappingRows.map((x) => [x.mapping_key, x.registered_rider_id]),
      );
      const resolved = resolveRiders(
        [...pend, ...records],
        regs,
        savedMappings,
      );
      const isPending = (r) => r.pendingId !== undefined;
      pendingResolved = resolved.records.filter(isPending);
      review = resolved.review.filter((x) => !isPending(x.record));
      pendingReview = resolved.review.filter((x) => isPending(x.record));
      const provisionalRows = resolved.review.map((x) => ({
        ...x.record,
        riderKey: provisionalKeyOf(x.record),
        riderId: clean(x.record.riderId),
      }));
      toSave = [
        ...pendingResolved,
        ...resolved.records.filter((r) => !isPending(r)),
        ...provisionalRows,
      ];
      corrections = resolved.corrections;
      const keyOf = (r) => normalizeRiderKey(r.riderId) + "|" + r.weekKey;
      const fileKeys = new Set(
        resolved.records.filter((r) => !isPending(r)).map(keyOf),
      );
      newVerified = fileKeys.size;
      pendingVerified = new Set(
        pendingResolved.map(keyOf).filter((k) => !fileKeys.has(k)),
      ).size;
      pendingStill = pendingReview.length;
    }
    const prepared = [],
      errors = [];
    toSave.forEach((r, i) => {
      const n = normalise(r, i, fileName);
      if (n.error) errors.push(n.error);
      else prepared.push(n);
    });
    if (errors.length)
      throw new WeeklyPaymentError(
        400,
        errors.slice(0, 5).join(" ") +
          (errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""),
      );

    const unique = new Map();
    prepared.forEach((p) => unique.set(p.riderKey + "\u0000" + p.weekKey, p));

    provisionalSaved = [...unique.values()].filter((p) =>
      p.riderKey.startsWith("provisional:"),
    ).length;

    const conflicts = [];
    for (const p of unique.values()) {
      const oldRows = await selectByNameAll.all(p.weekKey, p.nameKey);
      for (const old of oldRows) {
        if (old.rider_key !== p.riderKey)
          conflicts.push({
            rider: old.rider_name,
            riderId: old.rider_id,
            week: old.week_label,
            keptAs: p.values[4],
          });
      }
    }

    const importId = crypto.randomUUID(),
      now = new Date().toISOString();
    const previous = fileHash
      ? await db
          .prepare(
            "SELECT file_name, imported_at FROM weekly_payment_imports WHERE file_hash = ? ORDER BY imported_at DESC LIMIT 1",
          )
          .get(fileHash)
      : null;
    let inserted = 0,
      updated = 0,
      unchanged = 0,
      amountTotalPaise = 0;
    const weeks = new Map(),
      touched = new Set();

    await db.transaction(async (tx) => {
      const txSelectOne = tx.prepare(
        "SELECT * FROM weekly_payments WHERE rider_key = ? AND week_key = ?",
      );
      const txInsertRow = tx.prepare(
        `INSERT INTO weekly_payments(${COLUMNS.join(",")},import_id,created_at,updated_at) VALUES(${COLUMNS.map(() => "?").join(",")},?,?,?)`,
      );
      const txUpdateRow = tx.prepare(
        `UPDATE weekly_payments SET name_key = ?, ${VALUE_COLUMNS.map((c) => c + " = ?").join(", ")}, import_id = ?, updated_at = ? WHERE id = ?`,
      );
      const txUpsertPending = tx.prepare(
        `INSERT INTO weekly_payment_pending(pending_key, excel_rider_id, rider_name, week_key, week_label, week_start, week_end, payload, reason, file_name, status, mapped_rider_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING','',?,?)
         ON CONFLICT(pending_key) DO UPDATE SET excel_rider_id = excluded.excel_rider_id, payload = excluded.payload, reason = excluded.reason, file_name = excluded.file_name, status = 'PENDING', updated_at = excluded.updated_at`,
      );
      const txSetPendingReason = tx.prepare(
        "UPDATE weekly_payment_pending SET reason = ?, updated_at = ? WHERE id = ?",
      );
      const txSetPendingImported = tx.prepare(
        "UPDATE weekly_payment_pending SET status = 'IMPORTED', mapped_rider_id = ?, reason = 'Imported', updated_at = ? WHERE id = ?",
      );
      const txInsertImport = tx.prepare(
        "INSERT INTO weekly_payment_imports(id,file_name,file_hash,imported_at,imported_by,total,inserted,updated,unchanged,amount_total,weeks) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );

      for (const r of pendingResolved) {
        const sourcePending = await tx
          .prepare(
            "SELECT rider_name, excel_rider_id FROM weekly_payment_pending WHERE id = ?",
          )
          .get(r.pendingId);
        if (sourcePending) {
          const oldKey = provisionalKeyFor(
            sourcePending.rider_name,
            sourcePending.excel_rider_id,
          );
          await tx
            .prepare(
              "DELETE FROM weekly_payments WHERE rider_key = ? AND week_key = ?",
            )
            .run(oldKey, r.weekKey);
        }
      }
      for (const p of unique.values()) {
        let row = await txSelectOne.get(p.riderKey, p.weekKey);
        if (row && touched.has(row.id)) row = null;
        if (row && !p.values[4]) p.values[4] = row.rider_id;
        if (!row) {
          await txInsertRow.run(
            p.riderKey,
            p.weekKey,
            p.nameKey,
            ...p.values,
            importId,
            now,
            now,
          );
          inserted++;
        } else if (same(row, p.values)) {
          unchanged++;
          touched.add(row.id);
        } else {
          await txUpdateRow.run(p.nameKey, ...p.values, importId, now, row.id);
          updated++;
          touched.add(row.id);
        }
        amountTotalPaise +=
          p.values[15] === null ? 0 : Math.round(p.values[15] * 100);
        weeks.set(p.weekKey, p.values[0]);
      }
      const upsertProvisional = tx.prepare(
        `INSERT INTO weekly_payment_provisional_riders(mapping_key,excel_rider_id,rider_name,status,reason,first_seen_at,updated_at,verified_rider_id)
         VALUES(?,?,?,'PENDING_VERIFICATION',?,?,?,'')
         ON CONFLICT(mapping_key) DO UPDATE SET excel_rider_id=excluded.excel_rider_id,reason=excluded.reason,updated_at=excluded.updated_at`,
      );
      for (const x of [...review, ...pendingReview]) {
        await upsertProvisional.run(
          mappingKeyOf(x.record),
          clean(x.record.riderId),
          clean(x.record.riderName).slice(0, 200),
          x.reason,
          now,
          now,
        );
      }
      for (const x of review) {
        await txUpsertPending.run(
          pendingKeyOf(x.record),
          clean(x.record.riderId),
          clean(x.record.riderName).slice(0, 200),
          x.record.weekKey,
          clean(x.record.weekLabel).slice(0, 200),
          x.record.weekStart || "",
          x.record.weekEnd || "",
          JSON.stringify(x.record).slice(0, 20000),
          x.reason,
          clean(fileName).slice(0, 200),
          now,
          now,
        );
      }
      for (const x of pendingReview)
        await txSetPendingReason.run(x.reason, now, x.record.pendingId);
      for (const r of pendingResolved)
        await txSetPendingImported.run(r.riderId, now, r.pendingId);
      if (pendingResolved.length) {
        const updateProvisional = tx.prepare(
          `UPDATE weekly_payment_provisional_riders SET status='VERIFIED',verified_rider_id=?,updated_at=? WHERE mapping_key=?`,
        );
        for (const r of pendingResolved) {
          const sourcePending = await tx
            .prepare(
              "SELECT rider_name, excel_rider_id FROM weekly_payment_pending WHERE id = ?",
            )
            .get(r.pendingId);
          if (sourcePending)
            await updateProvisional.run(
              r.riderId,
              now,
              normalizeRiderName(sourcePending.rider_name) +
                "|" +
                normalizeRiderKey(sourcePending.excel_rider_id),
            );
        }
      }
      if (recordImport)
        await txInsertImport.run(
          importId,
          fileName.slice(0, 200),
          fileHash,
          now,
          clean(actor),
          unique.size,
          inserted,
          updated,
          unchanged,
          amountTotalPaise / 100,
          JSON.stringify([...weeks.values()]),
        );
    })();

    if (onSaved && (inserted || updated)) {
      try {
        await onSaved({ importId, fileName, inserted, updated });
      } catch (err) {
        console.error(
          "Weekly payments were saved, but the follow-up step failed:",
          err && err.message,
        );
      }
    }
    const pendingTotal = (await pendingRows()).length;
    if (recordImport)
      await audit(actor, "weekly_payments_import", {
        fileName,
        records: unique.size,
        inserted,
        updated,
        unchanged,
        pendingAdded: review.length,
        pendingVerified,
        pendingTotal,
        corrections: corrections.length,
      });
    else if (pendingVerified || inserted || updated)
      await audit(actor, "weekly_payments_rechecked", {
        pendingVerified,
        inserted,
        updated,
      });
    return {
      importId,
      fileName,
      total: unique.size,
      inserted,
      updated,
      unchanged,
      amountTotal: amountTotalPaise / 100,
      weeks: [...weeks.values()],
      importedFromFile: newVerified,
      importedFromPending: pendingVerified,
      provisionalSaved,
      pendingAdded: review.length,
      pendingTotal,
      registeredCount,
      review,
      corrections,
      conflicts,
      alreadyImported:
        !!previous && inserted === 0 && updated === 0 && review.length === 0,
      sameFileBefore: previous
        ? { fileName: previous.file_name, importedAt: previous.imported_at }
        : null,
    };
  }

  async function importRecords(body, actor = "") {
    const records = body?.records;
    if (!Array.isArray(records) || !records.length)
      throw new WeeklyPaymentError(400, "There are no payment rows to save.");
    if (records.length > MAX_IMPORT_RECORDS)
      throw new WeeklyPaymentError(
        400,
        `Too many rows in one import (maximum ${MAX_IMPORT_RECORDS.toLocaleString("en-IN")}).`,
      );
    const fileName = clean(body.fileName) || "payment file",
      fileHash = clean(body.fileHash).slice(0, 128);
    return applyRecords(records, { fileName, fileHash, actor });
  }

  async function listPending() {
    const regs = (await liveRegistrations())
      .slice()
      .sort((a, b) => String(a.rider_name).localeCompare(String(b.rider_name)));
    const sheetOrder = (a, b) =>
      (a.weekStart ? 0 : 1) - (b.weekStart ? 0 : 1) ||
      String(a.weekStart || "").localeCompare(String(b.weekStart || "")) ||
      String(a.sheet || "").localeCompare(String(b.sheet || "")) ||
      (a.rowNumber ?? 0) - (b.rowNumber ?? 0) ||
      a.id - b.id;
    const currentPending = await pendingRows();
    const pending = currentPending
      .map((p) => {
        const d = JSON.parse(p.payload);
        return {
          id: p.id,
          excelRiderId: p.excel_rider_id,
          rider: p.rider_name,
          week: p.week_label,
          weekStart: p.week_start,
          weekEnd: p.week_end,
          days: d.days ?? null,
          totalOrders: d.totalOrders ?? null,
          lm: d.lm ?? null,
          primary: d.primary ?? null,
          club: d.club ?? null,
          sdd: d.sdd ?? null,
          amount: d.amount ?? null,
          reason: p.reason,
          fileName: p.file_name,
          updatedAt: p.updated_at,
          weekStartSort: p.week_start,
          sheet: d.sheet || "",
          rowNumber: d.rowNumber ?? null,
          id_: p.id,
        };
      })
      .sort((a, b) =>
        sheetOrder(
          {
            weekStart: a.weekStartSort,
            sheet: a.sheet,
            rowNumber: a.rowNumber,
            id: a.id_,
          },
          {
            weekStart: b.weekStartSort,
            sheet: b.sheet,
            rowNumber: b.rowNumber,
            id: b.id_,
          },
        ),
      )
      .map(({ weekStartSort, id_, ...row }) => ({ ...row, id: id_ }));

    const provRows = await db
      .prepare(
        `SELECT mapping_key,excel_rider_id,rider_name,status,reason,first_seen_at,updated_at
         FROM weekly_payment_provisional_riders WHERE status='PENDING_VERIFICATION' ORDER BY LOWER(rider_name)`,
      )
      .all();
    const provisionalRiders = provRows.map((r) => ({
      mappingKey: r.mapping_key,
      excelRiderId: r.excel_rider_id,
      rider: r.rider_name,
      status: r.status,
      reason: r.reason,
      createdAt: r.first_seen_at,
      updatedAt: r.updated_at,
    }));
    return {
      pending,
      provisionalRiders,
      provisionalRiderCount: provisionalRiders.length,
      registrations: regs.map((g) => ({
        riderId: g.rider_id,
        rider: g.rider_name,
      })),
      registeredCount: regs.length,
    };
  }

  async function mapPending(id, riderId, actor = "") {
    const row = await db
      .prepare("SELECT * FROM weekly_payment_pending WHERE id = ?")
      .get(Number(id));
    if (!row || row.status !== "PENDING")
      throw new WeeklyPaymentError(
        404,
        "This pending record was not found or has already been imported.",
      );
    const regs = await liveRegistrations();
    const reg = regs.find(
      (g) => normalizeRiderKey(g.rider_id) === normalizeRiderKey(riderId),
    );
    if (!reg)
      throw new WeeklyPaymentError(
        400,
        "Choose a rider that is in Rider Registration and has APPROVED status. Pending applications cannot receive payment records.",
      );
    const allPend = await pendingRows();
    const rows = allPend.filter(
      (p) =>
        normalizeRiderName(p.rider_name) ===
          normalizeRiderName(row.rider_name) &&
        normalizeRiderKey(p.excel_rider_id) ===
          normalizeRiderKey(row.excel_rider_id),
    );
    const stamp = new Date().toISOString();
    const mappingKey =
      normalizeRiderName(row.rider_name) +
      "|" +
      normalizeRiderKey(row.excel_rider_id);
    await db
      .prepare(
        `INSERT INTO weekly_payment_rider_mappings(mapping_key,excel_rider_id,excel_rider_name,registered_rider_id,created_at,updated_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(mapping_key) DO UPDATE SET registered_rider_id=excluded.registered_rider_id,updated_at=excluded.updated_at`,
      )
      .run(
        mappingKey,
        row.excel_rider_id,
        row.rider_name,
        reg.rider_id,
        stamp,
        stamp,
      );
    await db
      .prepare(
        "UPDATE weekly_payment_pending SET mapped_rider_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(reg.rider_id, stamp, row.id);
    await audit(actor, "weekly_payment_pending_mapped", {
      pendingId: row.id,
      rider: row.rider_name,
      riderId: reg.rider_id,
      weeklyRows: rows.length,
    });
    const result = await applyRecords([], {
      fileName: row.file_name || "Pending mapping",
      fileHash: "",
      actor,
    });
    return {
      ...result,
      mapped: {
        pendingId: row.id,
        rider: row.rider_name,
        riderId: reg.rider_id,
        riderName: reg.rider_name,
        weeklyRows: rows.length,
      },
    };
  }

  const cycleOf = (start, end) =>
    start &&
    end &&
    ISO.test(start) &&
    ISO.test(end) &&
    Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1 > 7
      ? "15-day"
      : "weekly";

  const shape = (r) => ({
    id: r.id,
    importId: r.import_id,
    weekKey: r.week_key,
    week: r.week_label,
    weekStart: r.week_start,
    weekEnd: r.week_end,
    cycle: cycleOf(r.week_start, r.week_end),
    verificationStatus: String(r.rider_key || "").startsWith("provisional:")
      ? "PENDING_VERIFICATION"
      : "VERIFIED",
    rider: r.rider_name,
    riderId: r.rider_id,
    days: r.days,
    totalOrders: r.total_orders,
    lm: r.lm,
    primary: r.primary_orders,
    club: r.club,
    sdd: r.sdd,
    lmRate: r.rate_lm,
    primeRate: r.rate_prime,
    clubRate: r.rate_club,
    sddRate: r.rate_sdd,
    lmAmount: r.lm_amount,
    primeAmount: r.prime_amount,
    clubAmount: r.club_amount,
    sddAmount: r.sdd_amount,
    amount: r.amount,
    amountRaw: r.amount_raw,
    paymentRef: r.payment_ref || "",
    adjustmentReason: r.adjustment_reason || "",
    sourceFile: r.source_file,
    sheet: r.sheet,
    rowNumber: r.row_number,
    importedAt: r.updated_at,
    paymentStatus: PAYMENT_STATUSES.includes(r.payment_status)
      ? r.payment_status
      : "PENDING",
  });

  async function list({ q = "" } = {}) {
    const term = clean(q).toLowerCase();
    let rows;
    if (term) {
      const like = "%" + likeEscape(term) + "%";
      rows = await db
        .prepare(
          `SELECT * FROM weekly_payments WHERE lower(rider_name) LIKE ? ESCAPE '\\' OR lower(rider_id) LIKE ? ESCAPE '\\'
           OR lower(week_label) LIKE ? ESCAPE '\\' OR week_start LIKE ? ESCAPE '\\' OR week_end LIKE ? ESCAPE '\\'
           ORDER BY (week_start = '') ASC, week_start ASC, LOWER(sheet) ASC, COALESCE(row_number, 0) ASC, id ASC LIMIT 50000`,
        )
        .all(like, like, like, like, like);
    } else {
      rows = await db
        .prepare(
          "SELECT * FROM weekly_payments ORDER BY (week_start = '') ASC, week_start ASC, LOWER(sheet) ASC, COALESCE(row_number, 0) ASC, id ASC LIMIT 50000",
        )
        .all();
    }
    const last = await db
      .prepare(
        "SELECT * FROM weekly_payment_imports ORDER BY imported_at DESC LIMIT 1",
      )
      .get();
    return {
      records: rows.map(shape),
      lastImport: last
        ? {
            importId: last.id,
            fileName: last.file_name,
            importedAt: last.imported_at,
            total: last.total,
            inserted: last.inserted,
            updated: last.updated,
            unchanged: last.unchanged,
            amountTotal: last.amount_total,
            weeks: JSON.parse(last.weeks || "[]"),
          }
        : null,
    };
  }

  async function setPaymentStatus(id, status, actor = "") {
    const next = String(status ?? "")
      .trim()
      .toUpperCase();
    if (!PAYMENT_STATUSES.includes(next))
      throw new WeeklyPaymentError(
        400,
        "Choose Pending, Processing, Paid or Failed.",
      );
    const row = await db
      .prepare(
        "SELECT id, rider_name, rider_id, week_label, payment_status FROM weekly_payments WHERE id = ?",
      )
      .get(Number(id));
    if (!row)
      throw new WeeklyPaymentError(
        404,
        "This payment record was not found. Refresh the page and try again.",
      );
    const previous = PAYMENT_STATUSES.includes(row.payment_status)
      ? row.payment_status
      : "PENDING";
    if (previous === next)
      return {
        id: row.id,
        paymentStatus: next,
        previousStatus: previous,
        changed: false,
      };
    await db
      .prepare("UPDATE weekly_payments SET payment_status = ? WHERE id = ?")
      .run(next, row.id);
    await audit(actor, "weekly_payment_status_changed", {
      id: row.id,
      rider: row.rider_name,
      riderId: row.rider_id,
      week: row.week_label,
      from: previous,
      to: next,
    });
    return {
      id: row.id,
      paymentStatus: next,
      previousStatus: previous,
      changed: true,
    };
  }

  // Updates orders, amounts, and payment details on an existing weekly payment row or creates a manual adjustment row.
  async function applyManualAdjustment(input = {}, actor = "") {
    const riderName = clean(input.riderName ?? input.rider);
    if (!riderName) {
      throw new WeeklyPaymentError(400, "Rider Name is required.");
    }
    const rawAmount = input.amount ?? input.totalAmount;
    const amount = num(rawAmount);
    if (amount === null) {
      throw new WeeklyPaymentError(400, "Enter a valid Total Amount.");
    }

    const riderId = clean(input.riderId);
    const weekLabel = clean(input.week ?? input.weekLabel);
    const weekStart = clean(input.weekStart);
    const weekEnd = clean(input.weekEnd);
    if (
      (weekStart && !ISO.test(weekStart)) ||
      (weekEnd && !ISO.test(weekEnd))
    ) {
      throw new WeeklyPaymentError(400, "The week dates are not valid.");
    }

    const days = num(input.days);
    const lm = num(input.lm);
    const primaryOrders = num(input.primary ?? input.primaryOrders);
    const club = num(input.club);
    const sdd = num(input.sdd);
    const explicitTotalOrders = num(input.totalOrders);
    const totalOrders =
      explicitTotalOrders !== null
        ? explicitTotalOrders
        : (lm ?? 0) + (primaryOrders ?? 0) + (club ?? 0) + (sdd ?? 0) || null;

    const lmAmount = num(input.lmAmount);
    const primeAmount = num(input.primeAmount);
    const clubAmount = num(input.clubAmount);
    const sddAmount = num(input.sddAmount);
    const amountRaw = clean(input.amountRaw) || `₹${Number(amount).toFixed(2)}`;

    const statusCandidate = String(input.paymentStatus ?? "PENDING")
      .trim()
      .toUpperCase();
    const paymentStatus = PAYMENT_STATUSES.includes(statusCandidate)
      ? statusCandidate
      : "PENDING";
    const paymentRef = clean(input.paymentRef ?? input.utr).slice(0, 120);
    const adjustmentReason = clean(
      input.reason ?? input.adjustmentReason,
    ).slice(0, 500);
    const stamp = new Date().toISOString();

    const recordId = input.recordId ?? input.id;
    if (
      recordId !== undefined &&
      recordId !== null &&
      String(recordId).trim() !== ""
    ) {
      const existing = await db
        .prepare("SELECT * FROM weekly_payments WHERE id = ?")
        .get(Number(recordId));
      if (!existing) {
        throw new WeeklyPaymentError(404, "Weekly payment record not found.");
      }

      const nextRiderId = riderId || existing.rider_id || "";
      const nextRiderKey = nextRiderId
        ? "id:" + normalizeRiderKey(nextRiderId)
        : existing.rider_key;
      const nextWeekLabel = weekLabel || existing.week_label || "";

      await db
        .prepare(
          `UPDATE weekly_payments
           SET rider_key = ?,
               name_key = ?,
               rider_id = ?,
               rider_name = ?,
               week_label = ?,
               week_start = ?,
               week_end = ?,
               days = ?,
               total_orders = ?,
               lm = ?,
               primary_orders = ?,
               club = ?,
               sdd = ?,
               lm_amount = ?,
               prime_amount = ?,
               club_amount = ?,
               sdd_amount = ?,
               amount = ?,
               amount_raw = ?,
               payment_status = ?,
               payment_ref = ?,
               adjustment_reason = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextRiderKey,
          nameKeyOf(riderName),
          nextRiderId,
          riderName,
          nextWeekLabel,
          weekStart || existing.week_start || "",
          weekEnd || existing.week_end || "",
          days,
          totalOrders,
          lm,
          primaryOrders,
          club,
          sdd,
          lmAmount,
          primeAmount,
          clubAmount,
          sddAmount,
          amount,
          amountRaw,
          paymentStatus,
          paymentRef,
          adjustmentReason,
          stamp,
          existing.id,
        );

      await audit(actor, "weekly_payment_manual_adjustment", {
        id: existing.id,
        riderId: nextRiderId,
        rider: riderName,
        totalOrders,
        amount,
        paymentStatus,
        paymentRef,
      });

      const updated = await db
        .prepare("SELECT * FROM weekly_payments WHERE id = ?")
        .get(existing.id);
      return { record: updated ? shape(updated) : null };
    }

    const effectiveRiderKey = riderId
      ? "id:" + normalizeRiderKey(riderId)
      : provisionalKeyFor(riderName, "");
    const effectiveWeekKey =
      clean(input.weekKey) ||
      (weekStart && weekEnd
        ? `${weekStart}..${weekEnd}`
        : `manual:${crypto.randomUUID().slice(0, 8)}`);

    const existingManual = await db
      .prepare(
        "SELECT * FROM weekly_payments WHERE rider_key = ? AND week_key = ?",
      )
      .get(effectiveRiderKey, effectiveWeekKey);

    if (existingManual) {
      return applyManualAdjustment(
        { ...input, id: existingManual.id, recordId: existingManual.id },
        actor,
      );
    }

    await db
      .prepare(
        `INSERT INTO weekly_payments(
          rider_key, week_key, name_key, week_label, week_start, week_end,
          rider_name, rider_id, days, total_orders, lm, primary_orders, club, sdd,
          lm_amount, prime_amount, club_amount, sdd_amount, amount, amount_raw,
          source_file, sheet, row_number, original, import_id,
          payment_status, payment_ref, adjustment_reason, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        effectiveRiderKey,
        effectiveWeekKey,
        nameKeyOf(riderName),
        weekLabel || "Manual Adjustment",
        weekStart,
        weekEnd,
        riderName,
        riderId,
        days,
        totalOrders,
        lm,
        primaryOrders,
        club,
        sdd,
        lmAmount,
        primeAmount,
        clubAmount,
        sddAmount,
        amount,
        amountRaw,
        "Manual Adjustment",
        "",
        null,
        "{}",
        "manual",
        paymentStatus,
        paymentRef,
        adjustmentReason,
        stamp,
        stamp,
      );

    await audit(actor, "weekly_payment_manual_adjustment_created", {
      riderId,
      rider: riderName,
      totalOrders,
      amount,
      paymentStatus,
      paymentRef,
    });

    const created = await db
      .prepare(
        "SELECT * FROM weekly_payments WHERE rider_key = ? AND week_key = ?",
      )
      .get(effectiveRiderKey, effectiveWeekKey);
    return { record: created ? shape(created) : null };
  }

  async function recheckPending(actor = "") {
    if (!(await pendingRows()).length)
      return { pendingVerified: 0, inserted: 0, updated: 0 };
    const result = await applyRecords([], {
      fileName: "Re-check after rider approval",
      fileHash: "",
      actor,
      recordImport: false,
    });
    return {
      pendingVerified: result.importedFromPending,
      inserted: result.inserted,
      updated: result.updated,
    };
  }

  return {
    importRecords,
    list,
    listPending,
    mapPending,
    recheckPending,
    setPaymentStatus,
    applyManualAdjustment,
  };
}

export async function listForFranchise(db, accountId) {
  if (!accountId) return [];
  return db
    .prepare(
      `SELECT wp.rider_id AS "riderId", rr.rider_name AS "riderName",
      wp.week_label AS week, wp.week_key AS "weekKey", wp.week_start AS "weekStart", wp.week_end AS "weekEnd",
      CASE WHEN wp.week_start ~ '^\\d{4}-\\d{2}-\\d{2}$' AND wp.week_end ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (wp.week_end::date - wp.week_start::date) >= 8 THEN '15-day' ELSE 'weekly' END AS cycle,
      wp.days AS days, wp.total_orders AS "totalOrders", wp.lm AS lm, wp.primary_orders AS "primaryOrders",
      wp.club AS club, wp.sdd AS sdd, wp.lm_amount AS "lmAmount", wp.prime_amount AS "primeAmount",
      wp.club_amount AS "clubAmount", wp.sdd_amount AS "sddAmount", COALESCE(wp.amount,0) AS amount
    FROM weekly_payments wp
    JOIN rider_registrations rr ON lower(trim(rr.rider_id))=lower(trim(wp.rider_id))
    WHERE rr.owner_account_id=? AND rr.registration_source='Franchise' AND rr.application_status='APPROVED'
      AND wp.rider_id<>'' AND wp.rider_key NOT LIKE 'provisional:%'
    ORDER BY wp.week_start DESC, wp.week_end DESC, LOWER(wp.sheet), COALESCE(wp.row_number,0), LOWER(rr.rider_name)
    LIMIT 50000`,
    )
    .all(accountId);
}

export async function listForVendor(db, accountId) {
  if (!accountId) return [];
  return db
    .prepare(
      `SELECT wp.rider_id AS "riderId", rr.rider_name AS "riderName",
      wp.week_label AS week, wp.week_key AS "weekKey", wp.week_start AS "weekStart", wp.week_end AS "weekEnd",
      CASE WHEN wp.week_start ~ '^\\d{4}-\\d{2}-\\d{2}$' AND wp.week_end ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (wp.week_end::date - wp.week_start::date) >= 8 THEN '15-day' ELSE 'weekly' END AS cycle,
      wp.days AS days, wp.total_orders AS "totalOrders", wp.lm AS lm, wp.primary_orders AS "primaryOrders",
      wp.club AS club, wp.sdd AS sdd, wp.lm_amount AS "lmAmount", wp.prime_amount AS "primeAmount",
      wp.club_amount AS "clubAmount", wp.sdd_amount AS "sddAmount", COALESCE(wp.amount,0) AS amount
    FROM weekly_payments wp
    JOIN rider_registrations rr ON lower(trim(rr.rider_id))=lower(trim(wp.rider_id))
    WHERE rr.owner_account_id=? AND rr.registration_source='Vendor' AND rr.application_status='APPROVED'
      AND wp.rider_id<>'' AND wp.rider_key NOT LIKE 'provisional:%'
    ORDER BY wp.week_start DESC, wp.week_end DESC, LOWER(wp.sheet), COALESCE(wp.row_number,0), LOWER(rr.rider_name)
    LIMIT 50000`,
    )
    .all(accountId);
}

export async function partnerGroupsForImport(db, importId) {
  if (!importId) return [];
  return db
    .prepare(
      `SELECT a.id AS "accountId", a.role AS role, COUNT(*) AS records,
        COUNT(DISTINCT lower(trim(wp.rider_id))) AS riders,
        MIN(NULLIF(wp.week_start,'')) AS "fromDay",
        MAX(COALESCE(NULLIF(wp.week_end,''),NULLIF(wp.week_start,''))) AS "toDay",
        SUM(COALESCE(wp.total_orders, COALESCE(wp.lm,0)+COALESCE(wp.primary_orders,0)+COALESCE(wp.club,0))) AS orders
      FROM weekly_payments wp
      JOIN rider_registrations rr ON lower(trim(rr.rider_id))=lower(trim(wp.rider_id))
      JOIN accounts a ON a.id=rr.owner_account_id
      WHERE wp.import_id=? AND wp.rider_id<>'' AND wp.rider_key NOT LIKE 'provisional:%'
        AND rr.application_status='APPROVED' AND rr.registration_source IN ('Vendor','Franchise')
        AND a.role=lower(rr.registration_source) AND a.status='active'
      GROUP BY a.id, a.role
      ORDER BY a.id`,
    )
    .all(importId);
}
