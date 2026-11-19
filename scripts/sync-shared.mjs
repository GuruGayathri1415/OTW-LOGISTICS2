// The Excel reader runs in the admin panel (browser) AND in the server (Google Drive sync). The master copy is
// backend/shared/payment-excel.cjs; this copies it to frontend/dashboard/payment-excel.js. Run after editing it:
//   node scripts/sync-shared.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.copyFileSync(path.join(root, "backend/shared/payment-excel.cjs"), path.join(root, "frontend/dashboard/payment-excel.js"));
console.log("frontend/dashboard/payment-excel.js updated from backend/shared/payment-excel.cjs");
