// Helpline / Support: "My support requests" panel for the Vendor and Franchise portals.
// Shows only this account's tickets (the server enforces that), their status, the admin's replies,
// and lets the partner add a follow-up to one of its own tickets. Copy this file into both portal folders.
// The panel is rendered into #supportTracker. Other scripts can call window.OTWSupportTracker.refresh().
(function () {
  const root = document.getElementById("supportTracker");
  if (!root) return;

  const base = () =>
    window.OTW_API_BASE ||
    (location.protocol === "file:" ? "http://localhost:8080" : "");
  const esc = (v = "") =>
    String(v).replace(
      /[&<>'"]/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c],
    );
  const when = (v) => {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d) ? String(v || "") : d.toLocaleString();
  };
  const badge = (s) => {
    const st = String(s || "Open");
    const lower = st.toLowerCase();
    const cls =
      lower === "resolved" || lower === "closed"
        ? "success"
        : lower === "rejected"
          ? "danger"
          : "";
    return `<span class="badge ${cls}">${esc(st)}</span>`;
  };

  const state = {
    tickets: [],
    open: null,
    photoUrl: "",
    signedOut: false,
    error: "",
    rateLimitedUntil: 0,
    refreshing: false,
  };

  function parseRetryAfterMs(r, out) {
    const retryHeader = r.headers.get("retry-after");
    if (retryHeader) {
      const secs = Number(retryHeader);
      if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 10 * 60_000);
      const parsedDate = Date.parse(retryHeader);
      if (!Number.isNaN(parsedDate) && parsedDate > Date.now()) {
        return Math.min(parsedDate - Date.now(), 10 * 60_000);
      }
    }
    if (out && typeof out.retryAfter === "number" && out.retryAfter > 0) {
      return Math.min(out.retryAfter * 1000, 10 * 60_000);
    }
    return 60_000;
  }

  async function call(path, opts = {}) {
    const r = await fetch(base() + path, {
      credentials: "include",
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 401) {
      const err = new Error("signed-out");
      err.signedOut = true;
      throw err;
    }
    if (r.status === 429) {
      const waitMs = parseRetryAfterMs(r, out);
      const err = new Error(
        out.error ||
          `Too many requests right now. Please wait ${Math.ceil(waitMs / 1000)}s and try again.`,
      );
      err.rateLimited = true;
      err.retryAfterMs = waitMs;
      throw err;
    }
    if (!r.ok) throw new Error(out.error || "Request failed (" + r.status + ")");
    return out;
  }

  async function refresh({ manual = false } = {}) {
    if (!manual && Date.now() < state.rateLimitedUntil) {
      const secsLeft = Math.max(1, Math.ceil((state.rateLimitedUntil - Date.now()) / 1000));
      state.error = `Too many requests. Automatic refresh paused for ${secsLeft}s.`;
      paint();
      return;
    }
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const out = await call("/api/support/mine");
      state.tickets = out.tickets || [];
      state.signedOut = false;
      state.error = "";
      state.rateLimitedUntil = 0;
    } catch (e) {
      state.signedOut = !!e.signedOut;
      if (e.signedOut) {
        forget();
        state.error = "";
      } else if (e.rateLimited) {
        state.rateLimitedUntil = Date.now() + (e.retryAfterMs || 60_000);
        state.error = e.message;
      } else {
        state.error = e.message;
      }
    } finally {
      state.refreshing = false;
    }
    paint();
  }

  // Drops every ticket and open conversation from memory, so the next person to sign in never sees them.
  function forget() {
    state.tickets = [];
    state.open = null;
    state.photoUrl = "";
    state.rateLimitedUntil = 0;
  }

  function paint() {
    if (state.open) return paintDetail();
    if (state.signedOut) {
      root.innerHTML = `<div class="panel-head"><div><h3>My support requests</h3><p class="muted">Sign in to see the status of your requests.</p></div></div>`;
      return;
    }
    const rows = state.tickets.length
      ? state.tickets
          .map((t) => {
            const ticketCode = t.ticketId || t.ticket_no || t.ticket_id || t.id || "";
            const submittedRaw =
              t.submittedAt || t.submitted_at || t.createdAt || t.created_at || "";
            const latestReply =
              t.adminResponse || t.latestReply || t.latest_reply || "";
            return `<tr>
              <td><b>${esc(ticketCode)}</b></td>
              <td>${esc(submittedRaw ? when(submittedRaw) : "")}</td>
              <td>${badge(t.status)}</td>
              <td>${latestReply ? esc(String(latestReply).slice(0, 120)) : '<span class="muted">No reply yet</span>'}</td>
              <td><button class="secondary" type="button" data-track-open="${esc(t.id)}">View</button></td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="muted">You have not sent any support requests yet.</td></tr>`;
    root.innerHTML = `
      <div class="panel-head"><div><h3>My support requests</h3>
      <p class="muted">Track the status of each request you have sent. Our replies appear here.</p></div>
      <button class="secondary" type="button" data-track-refresh>Refresh</button></div>
      ${state.error ? `<p class="support-status error">${esc(state.error)}</p>` : ""}
      <div class="table-wrap"><table class="table"><thead><tr>
        <th>Ticket ID</th><th>Submitted</th><th>Status</th><th>Latest reply</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function open(id) {
    try {
      state.open = await call("/api/support/mine/" + encodeURIComponent(id));
      state.photoUrl = "";
      paintDetail();
      loadPhoto(id);
    } catch (e) {
      if (e.signedOut) {
        forget();
        state.signedOut = true;
      } else if (e.rateLimited) {
        state.rateLimitedUntil = Date.now() + (e.retryAfterMs || 60_000);
        state.error = e.message;
      } else {
        state.error = e.message;
      }
      paint();
    }
  }

  function paintDetail() {
    const { ticket: t, events } = state.open;
    const ticketCode = t.ticketId || t.ticket_no || t.ticket_id || t.id || "";
    const submittedRaw =
      t.submittedAt || t.submitted_at || t.createdAt || t.created_at || "";
    const history = (events || [])
      .map((ev) => {
        const who =
          ev.authorRole === "admin"
            ? "Support team"
            : ev.authorRole === "customer"
              ? "Customer"
              : "You";
        const label =
          ev.kind === "submitted"
            ? "Request sent"
            : ev.kind === "reply"
              ? "Reply from support"
              : ev.kind === "customer_email"
                ? "Email from the customer"
                : ev.kind === "followup"
                  ? "Your follow-up"
                  : "Status changed to " + ev.status;
        return `<div class="support-event" style="margin:8px 0;padding:10px;border-radius:10px;background:rgba(0,0,0,.04)">
          <div><b>${esc(label)}</b> · ${esc(who)} · <span class="muted">${esc(when(ev.createdAt || ev.created_at))}</span></div>
          ${ev.body ? `<p style="margin:6px 0 0">${esc(ev.body)}</p>` : ""}</div>`;
      })
      .join("");
    root.innerHTML = `
      <div class="panel-head"><div><h3>Ticket ${esc(ticketCode)}</h3>
      <p class="muted">Submitted ${esc(when(submittedRaw))} · Status ${badge(t.status)}</p></div>
      <button class="secondary" type="button" data-track-back>Back to my requests</button></div>
      <p><b>Problem:</b> ${esc(t.description)}</p>
      <div id="trackPhoto"><span class="muted">Loading photo…</span></div>
      <h4>Conversation</h4>
      ${history || '<p class="muted">No messages yet.</p>'}
      ${String(t.status || "").toLowerCase() === "closed" ? '<p class="muted">This ticket is closed. Please send a new request for a new issue.</p>' : `
      <label style="display:block;margin-top:12px">Add a follow-up
        <textarea id="trackFollowUp" rows="3" maxlength="2000" placeholder="Add more details for our support team"></textarea></label>
      <div style="margin-top:8px"><button class="primary" type="button" data-track-send>Send follow-up</button></div>`}
      <p class="support-status" id="trackStatus"></p>`;
  }

  async function loadPhoto(id) {
    try {
      const r = await fetch(
        base() + "/api/support/mine/" + encodeURIComponent(id) + "/photo",
        { credentials: "include" },
      );
      if (!r.ok) throw new Error("The photo could not be loaded.");
      state.photoUrl = URL.createObjectURL(await r.blob());
      const box = document.getElementById("trackPhoto");
      if (box)
        box.innerHTML = `<img src="${state.photoUrl}" alt="Photo you attached" style="max-width:100%;border-radius:10px;margin:8px 0">`;
    } catch (e) {
      const box = document.getElementById("trackPhoto");
      if (box)
        box.innerHTML = `<span class="support-status error">${esc(e.message)}</span>`;
    }
  }

  root.addEventListener("click", async (e) => {
    const openBtn = e.target.closest("[data-track-open]");
    if (openBtn) return open(openBtn.dataset.trackOpen);
    if (e.target.closest("[data-track-refresh]")) return refresh({ manual: true });
    if (e.target.closest("[data-track-back]")) {
      state.open = null;
      return refresh({ manual: true });
    }
    const send = e.target.closest("[data-track-send]");
    if (send) {
      const status = document.getElementById("trackStatus");
      const text = (document.getElementById("trackFollowUp")?.value || "").trim();
      if (!text) {
        status.className = "support-status error";
        status.textContent = "Please write your follow-up message.";
        return;
      }
      send.disabled = true;
      try {
        state.open = await call(
          `/api/support/mine/${encodeURIComponent(state.open.ticket.id)}/messages`,
          {
            method: "POST",
            body: { message: text },
          },
        );
        paintDetail();
        loadPhoto(state.open.ticket.id);
      } catch (err) {
        send.disabled = false;
        status.className = "support-status error";
        status.textContent = err.message;
      }
    }
  });

  // Called when the portal shows its sign-in page: clears the previous account's tickets from memory.
  function reset() {
    forget();
    state.signedOut = true;
    state.error = "";
    paint();
  }

  window.OTWSupportTracker = { refresh, reset };
  refresh();
  setInterval(() => {
    if (!state.open && !document.hidden) refresh();
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.open) refresh();
  });
})();