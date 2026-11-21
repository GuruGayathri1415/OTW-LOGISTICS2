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
  note.textContent = "Reading the Rider ID, name, and mobile from the screenshot…";
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