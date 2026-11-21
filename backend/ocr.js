// Reads the rider's Partner ID / Rider ID, name, and 10-digit mobile number from a screenshot of the
// delivery app, e.g.:
//   "Kandi Nithin"
//   "Partner ID: 28588592"
// or:
//   "Ramesh Mani"
//   "ID: 8392252"
//   "7812870644"
// Text recognition (Tesseract) runs here on the server; screenshots are not sent to any outside service.
// Text recognition can misread a character now and then, so the portal always asks the user to check
// the filled-in values.
import { createWorker, PSM } from "tesseract.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// English language data shipped with the npm package (no download at run time).
const LANG_PATH = require("@tesseract.js-data/eng").langPath.replace(
  /4\.0\.0$/,
  "4.0.0_best_int",
);
const IDLE_MS = 10 * 60 * 1000; // free the memory when no screenshots arrive for 10 minutes
const TIMEOUT_MS = 20 * 1000;

let workerPromise = null,
  idleTimer = null,
  queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, {
      langPath: LANG_PATH,
      gzip: true,
      cacheMethod: "none",
      logger: () => {},
      errorHandler: () => {},
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = workerPromise;
    workerPromise = null;
    try {
      (await w)?.terminate();
    } catch {}
  }, IDLE_MS);
  idleTimer.unref?.();
  return workerPromise;
}

// Matches "Partner ID: 28588592", "Rider ID - 123456", or standalone "ID: 8392252".
const ID_RE =
  /(?:(?:partner|rider)\s*)?[i1l|]\s*d\s*(?:no\.?|number)?\s*[:;.\-]\s*([0-9OoIl|SsBb]{5,12})/i;

const cleanDigits = (s) =>
  String(s || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8");

const NOISE_NAME_RE =
  /^(?:my\s+profile|profile|personal\s+info|my\s+documents|shadowfax(?:\s+kit)?|terms(?:\s+and\s+conditions)?|whatsapp(?:\s+opt\s+in)?|sign\s+out|group(?:\s*[:\-].*)?|id(?:\s*[:\-].*)?)$/i;

function extractMobile(lines, partnerId = "") {
  const candidates = [...lines];
  for (let i = 0; i < lines.length - 1; i++) {
    candidates.push(`${lines[i]} ${lines[i + 1]}`);
  }

  for (const rawLine of candidates) {
    const line = cleanDigits(rawLine).replace(
      /(?:\+?91[\s-]?|(?<!\d)0(?=\s*[6-9]))/g,
      " ",
    );
    const matches = line.matchAll(
      /(?:^|[^\d])([6-9](?:[\s-]?[0-9]){9})(?:[^\d]|$)/g,
    );
    for (const m of matches) {
      const digits = m[1].replace(/\D/g, "");
      if (/^[6-9]\d{9}$/.test(digits) && digits !== partnerId) {
        return digits;
      }
    }
  }
  return "";
}

// Finds ID, name on a nearby line above it, and 10-digit mobile number if present.
export function parseRiderText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let partnerId = "";
  let name = "";

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ID_RE);
    if (!m) continue;
    partnerId = cleanDigits(m[1]);
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const candidate = lines[j]
        .replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!candidate || NOISE_NAME_RE.test(candidate)) continue;
      const letters = (candidate.match(/[A-Za-z]/g) || []).length;
      if (
        candidate.length >= 3 &&
        candidate.length <= 40 &&
        letters >= 3 &&
        letters / candidate.length >= 0.75 &&
        /^[A-Za-z][A-Za-z .]*$/.test(candidate)
      ) {
        name = candidate;
        break;
      }
    }
    break;
  }

  const mobile = extractMobile(lines, partnerId);
  return { partnerId, name, mobile };
}

async function recognise(buffer, psm) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(buffer);
  return parseRiderText(data.text);
}

// Returns {partnerId, name, mobile}; empty strings when nothing could be read. Never throws.
export function readRiderScreenshot(buffer) {
  const job = queue.then(async () => {
    // "Sparse text" reads app screens best; the general mode is a second try.
    let r = await recognise(buffer, PSM.SPARSE_TEXT);
    if (!r.partnerId || !r.mobile) {
      const alt = await recognise(buffer, PSM.AUTO);
      r = {
        partnerId: r.partnerId || alt.partnerId,
        name: r.name || alt.name,
        mobile: r.mobile || alt.mobile,
      };
    }
    return r;
  });
  queue = job.catch(() => {});
  const timeout = new Promise((resolve) =>
    setTimeout(
      () => resolve({ partnerId: "", name: "", mobile: "", timedOut: true }),
      TIMEOUT_MS,
    ).unref?.(),
  );
  return Promise.race([job, timeout]).catch((err) => {
    console.error("Screenshot reading failed:", err.message);
    return { partnerId: "", name: "", mobile: "" };
  });
}
