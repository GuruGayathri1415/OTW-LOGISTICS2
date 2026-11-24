// Vendor & Franchise Portal → Reports: the dashboard numbers, calculated on the server from the saved Excel rows.
//
// The Orders page and the Reports page read the same source: the weekly_payments rows that listForVendor() /
// listForFranchise() returns (only approved riders this partner registered, matched by Rider ID). This module
// only adds up those rows. It never invents a count, never recalculates the Excel Total Orders, and never uses
// the partner's older manual order records.
//
// Column mapping (Excel → Reports):
//   Total Orders → weekly / all-time total      Prime Orders → Primary Orders
//   Club Orders  → Club Orders                  LM Orders    → Large Orders
//   SDD Orders   → SDD Orders (kept separately in the order mix)
import { normalizeRiderKey } from "./rider-registrations.js";
import { listForFranchise, listForVendor } from "./weekly-payments.js";

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? 0
    : Number(v);
const isBlankCount = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v));

const normName = (v) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Normalize row field names in case PostgreSQL returned lowercase aliases.
function normalizeRow(r = {}) {
  return {
    ...r,
    riderId: r.riderId ?? r.riderid ?? r.rider_id ?? "",
    riderName: r.riderName ?? r.ridername ?? r.rider_name ?? "",
    week: r.week ?? r.week_label ?? "",
    weekKey: r.weekKey ?? r.weekkey ?? r.week_key ?? "",
    weekStart: r.weekStart ?? r.weekstart ?? r.week_start ?? "",
    weekEnd: r.weekEnd ?? r.weekend ?? r.week_end ?? "",
    totalOrders: r.totalOrders ?? r.totalorders ?? r.total_orders ?? null,
    primaryOrders:
      r.primaryOrders ?? r.primaryorders ?? r.primary_orders ?? null,
    lmAmount: r.lmAmount ?? r.lmamount ?? r.lm_amount ?? null,
    primeAmount: r.primeAmount ?? r.primeamount ?? r.prime_amount ?? null,
    clubAmount: r.clubAmount ?? r.clubamount ?? r.club_amount ?? null,
    sddAmount: r.sddAmount ?? r.sddamount ?? r.sdd_amount ?? null,
  };
}

// Total Orders as saved from the Excel sheet. Rows saved without one (older imports of sheets with no Total Orders
// column) use the same rule as the Admin Reports page (report-stats.js): LM + Prime + Club, so both pages agree.
const totalOf = (r) =>
  isBlankCount(r.totalOrders)
    ? num(r.lm) + num(r.primaryOrders) + num(r.club)
    : num(r.totalOrders);

// A location counts only when it has real text in it (not blank, "-", "NA" or digits only).
export function isValidLocation(value) {
  const v = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    v.length >= 2 &&
    /\p{L}/u.test(v) &&
    !/^(na|n\/a|none|nil|null|-+|\.+)$/i.test(v)
  );
}

// The approved riders one partner registered (never pending, rejected or another partner's riders).
// source is the registration source: 'Vendor' or 'Franchise'.
export async function listApprovedRidersFor(db, accountId, source) {
  if (!accountId) return [];
  const rows = await db
    .prepare(
      `SELECT rider_id AS "riderId", rider_name AS "riderName", hub_location AS "hubLocation"
    FROM rider_registrations
    WHERE owner_account_id = ? AND registration_source = ? AND application_status = 'APPROVED'
    ORDER BY LOWER(rider_name) ASC, rider_id ASC`,
    )
    .all(accountId, source);
  return Array.isArray(rows) ? rows : [];
}
export const listApprovedRidersForVendor = (db, accountId) =>
  listApprovedRidersFor(db, accountId, "Vendor");
export const listApprovedRidersForFranchise = (db, accountId) =>
  listApprovedRidersFor(db, accountId, "Franchise");

// Promotes any provisional weekly_payments rows matching an approved rider (by Rider ID or exact normalized name)
// so rows imported before the rider was approved immediately show up in Orders and Reports.
async function promoteApprovedRiderRows(db, role, accountId) {
  const source = role === "vendor" ? "Vendor" : "Franchise";
  try {
    const approved = await db
      .prepare(
        `SELECT rider_id, rider_name
         FROM rider_registrations
         WHERE owner_account_id = ? AND registration_source = ? AND application_status = 'APPROVED' AND trim(rider_id) <> ''`,
      )
      .all(accountId, source);
    if (!approved || !approved.length) return;

    const provRows = await db
      .prepare(
        `SELECT id, rider_key, week_key, rider_id, rider_name
         FROM weekly_payments
         WHERE rider_key LIKE 'provisional:%'`,
      )
      .all();
    if (!provRows || !provRows.length) return;

    const updateStmt = db.prepare(
      `UPDATE weekly_payments
       SET rider_key = ?, rider_id = ?
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM weekly_payments existing
           WHERE existing.rider_key = ? AND existing.week_key = weekly_payments.week_key
         )`,
    );

    for (const r of approved) {
      const rid = String(r.rider_id || "").trim();
      const rKey = normalizeRiderKey(rid);
      const rName = normName(r.rider_name);
      if (!rid || !rKey) continue;
      const verifiedKey = "id:" + rid.toLowerCase();

      for (const p of provRows) {
        const pIdKey = normalizeRiderKey(p.rider_id);
        const pName = normName(p.rider_name);
        const idMatches = pIdKey && pIdKey === rKey;
        const nameMatches = !pIdKey && rName && pName === rName;
        if (idMatches || nameMatches) {
          await updateStmt.run(verifiedKey, rid, p.id, verifiedKey);
        }
      }
    }
  } catch {
    /* non-fatal */
  }
}

// One row per rider per period. The same rider and period sent twice is counted once.
function uniqueRows(records) {
  const seen = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const r = normalizeRow(raw);
    const rider = normalizeRiderKey(r.riderId);
    if (!rider) continue;
    const period =
      r.weekStart && r.weekEnd ? `${r.weekStart}..${r.weekEnd}` : r.weekKey;
    const key = rider + "|" + period;
    if (!seen.has(key))
      seen.set(key, { ...r, riderKey: rider, periodKey: period });
  }
  return [...seen.values()];
}

// Sums the rows of one set of periods. Missing category values count as 0 only inside rows that exist.
function totalsOf(rows) {
  const t = {
    total: 0,
    primary: 0,
    club: 0,
    large: 0,
    sdd: 0,
    riders: new Set(),
  };
  for (const r of rows) {
    t.total += totalOf(r);
    t.primary += num(r.primaryOrders);
    t.club += num(r.club);
    t.large += num(r.lm);
    t.sdd += num(r.sdd);
    t.riders.add(r.riderKey);
  }
  return {
    total: t.total,
    primary: t.primary,
    club: t.club,
    large: t.large,
    sdd: t.sdd,
    riders: t.riders.size,
  };
}

// The latest period of one cycle, chosen by its start date (the same week the Orders page shows as the newest).
function latestPeriod(rows) {
  if (!rows.length) return null;
  const sorted = [...rows].sort(
    (a, b) =>
      String(b.weekStart || "").localeCompare(String(a.weekStart || "")) ||
      String(b.weekKey).localeCompare(String(a.weekKey)),
  );
  const top = sorted[0];
  const inPeriod = rows.filter((r) => r.periodKey === top.periodKey);
  return {
    label: top.week,
    start: top.weekStart || "",
    end: top.weekEnd || "",
    rows: inPeriod,
  };
}

// riders: approved riders of one partner (listApprovedRidersFor). records: that partner's rows (listForVendor / listForFranchise).
// week: optional period to show (its start..end key, or its Week label). Empty = the newest weekly cycle.
export function buildPartnerReport(records, riders, { week = "" } = {}) {
  const rows = uniqueRows(records);
  const riderList = Array.isArray(riders) ? riders : [];
  const riderKeys = new Set();
  const locations = new Set();
  for (const r of riderList) {
    const key = normalizeRiderKey(r.riderId ?? r.riderid ?? r.rider_id);
    if (!key) continue;
    riderKeys.add(key);
    const hub = r.hubLocation ?? r.hublocation ?? r.hub_location;
    if (isValidLocation(hub))
      locations.add(String(hub).replace(/\s+/g, " ").trim().toLowerCase());
  }
  const withOrders = new Set(
    rows.filter((r) => totalOf(r) > 0).map((r) => r.riderKey),
  );

  const exactWeeklyRows = rows.filter((r) => r.cycle === "weekly");
  const weeklyRows = exactWeeklyRows.length ? exactWeeklyRows : rows;
  const fifteenRows = rows.filter((r) => r.cycle === "15-day");

  // Every weekly period, newest first: the Week selector and the choice of the default week.
  const weekMap = new Map();
  for (const r of weeklyRows) {
    if (!weekMap.has(r.periodKey))
      weekMap.set(r.periodKey, {
        key: r.periodKey,
        label: r.week,
        start: r.weekStart || "",
        end: r.weekEnd || "",
      });
  }
  const weeks = [...weekMap.values()].sort(
    (a, b) =>
      String(b.start).localeCompare(String(a.start)) ||
      String(b.key).localeCompare(String(a.key)),
  );
  const chosen =
    weeks.find((w) => w.key === week || w.label === week) || weeks[0] || null;
  const weekly = chosen
    ? {
        ...chosen,
        ...totalsOf(weeklyRows.filter((r) => r.periodKey === chosen.key)),
      }
    : null;

  const cycle = latestPeriod(fifteenRows);

  // 15-day periods, newest first, for the table and chart.
  const periodMap = new Map();
  for (const r of fifteenRows) {
    if (!periodMap.has(r.periodKey))
      periodMap.set(r.periodKey, {
        label: r.week,
        start: r.weekStart || "",
        rows: [],
      });
    periodMap.get(r.periodKey).rows.push(r);
  }
  const periods15 = [...periodMap.values()]
    .sort((a, b) => String(b.start).localeCompare(String(a.start)))
    .map((p) => ({ label: p.label, start: p.start, ...totalsOf(p.rows) }));

  return {
    riders: { total: riderKeys.size, withOrders: withOrders.size },
    locations: locations.size,
    allTimeOrders: rows.reduce((n, r) => n + totalOf(r), 0),
    weeks: weeks.map((w) => ({ key: w.key, label: w.label })),
    weekly,
    cycle15: cycle
      ? {
          label: cycle.label,
          start: cycle.start,
          end: cycle.end,
          ...totalsOf(cycle.rows),
        }
      : null,
    periods15,
    rowCount: rows.length,
  };
}

// Used by the Portal weekly-payments endpoint: the same rows the Orders page gets, plus the report built from them.
// role 'vendor' or 'franchise'; each partner only ever gets its own riders' rows (see weekly-payments.js).
export async function partnerPortalPayload(db, role, accountId, week = "") {
  const isVendor = role === "vendor";
  await promoteApprovedRiderRows(db, role, accountId);
  const [rawRecords, riders] = await Promise.all([
    isVendor ? listForVendor(db, accountId) : listForFranchise(db, accountId),
    listApprovedRidersFor(db, accountId, isVendor ? "Vendor" : "Franchise"),
  ]);
  const records = (Array.isArray(rawRecords) ? rawRecords : []).map(
    normalizeRow,
  );
  return { records, report: buildPartnerReport(records, riders, { week }) };
}
export const vendorPortalPayload = (db, accountId, week = "") =>
  partnerPortalPayload(db, "vendor", accountId, week);
export const franchisePortalPayload = (db, accountId, week = "") =>
  partnerPortalPayload(db, "franchise", accountId, week);
