// HTTP routes for Helpline / Support. Storage: support-tickets.js. Email: support-mail.js. Incoming Gmail:
// support-inbound.js. Email wording: support-email-text.js.
import fs from "node:fs";
import multer from "multer";
import rateLimit from "express-rate-limit";
import {
  partnerPortalType,
  SUPPORT_PHOTO_MAX_BYTES,
  SUPPORT_STATUSES,
  SupportError,
} from "./support-tickets.js";
import {
  FOLLOWUP_SUBJECT,
  followUpBody,
  NEW_TICKET_SUBJECT,
  newTicketBody,
  REPLY_SUBJECT,
  replyBody,
} from "./support-email-text.js";

const PHONE_OK = /^[6-9]\d{9}$/;
const EMAIL_OK = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function extractContactPhone(text = "") {
  const m = String(text || "").match(
    /(?:Contact\s*Phone|Phone|Mobile|WhatsApp)\s*[:\-]\s*([+\d][\d\s\-()]{5,20})/i,
  );
  return m ? m[1].trim() : "";
}

function emailSentence(job) {
  if (!job) return "";
  if (job.status === "Sent")
    return "Our support team has been emailed about it.";
  if (job.status === "Failed")
    return "The email alert to our team could not be sent right now, but your ticket is saved and our team will view it in the portal.";
  return "The email alert is queued and will be retried automatically.";
}

export function registerSupportRoutes(
  app,
  {
    auth,
    service,
    mailer,
    inbound,
    supportEmail,
    adminRecipients,
    baseUrl = "",
  },
) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: SUPPORT_PHOTO_MAX_BYTES,
      files: 1,
      fields: 12,
      fieldSize: 20000,
    },
  });

  const submitLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req) => `ip:${req.ip}`,
    message: {
      error:
        "You have sent several support requests in a short time. Please wait about ten minutes, then try again.",
    },
  });

  // Generous read limiter for partner ticket refreshes & background polling
  const mineLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req) => `support-mine:${req.ip}`,
    message: {
      error: "Too many refresh requests. Please wait a moment and try again.",
    },
  });

  const partnerGuard = async (req, res, next) => {
    const s =
      (await auth.getSession(req, "vendor")) ||
      (await auth.getSession(req, "franchise"));
    if (!s)
      return res
        .status(401)
        .json({ error: "Please sign in again.", code: "NOT_SIGNED_IN" });
    if (s.account.must_change_password)
      return res.status(403).json({
        error: "Please set a new password first.",
        code: "PASSWORD_CHANGE_REQUIRED",
      });
    req.partner = s.account;
    next();
  };
  const adminGuard = auth.requireRole("admin");

  const fail = (res, err, context) => {
    if (err instanceof SupportError)
      return res.status(err.status).json({
        error: err.message,
        ...(err.field ? { field: err.field } : {}),
      });
    console.error(context, err && err.message);
    return res
      .status(500)
      .json({ error: "Something went wrong. Please try again." });
  };

  const admins = async () => {
    const list =
      typeof adminRecipients === "function"
        ? await adminRecipients()
        : adminRecipients || [];
    return list.filter(Boolean);
  };
  const copyList = async () =>
    (await admins()).filter(
      (a) => a.toLowerCase() !== String(supportEmail || "").toLowerCase(),
    );

  const lastMessageId = async (ticketId) => {
    if (typeof service.events !== "function") return "";
    const evs = await service.events(ticketId);
    const ids = (evs || []).filter((e) => e.messageId);
    return ids.length ? ids[ids.length - 1].messageId : "";
  };

  async function enrichPhone(ticket) {
    if (!ticket || ticket.phone) return ticket;
    const fromSubject = extractContactPhone(
      ticket.description || ticket.subject || "",
    );
    if (fromSubject) return { ...ticket, phone: fromSubject };
    if (typeof service.events === "function") {
      try {
        const evs = await service.events(ticket.id);
        for (const ev of evs || []) {
          const found = extractContactPhone(ev?.body || "");
          if (found) return { ...ticket, phone: found };
        }
      } catch {}
    }
    return ticket;
  }

  async function notifyNewTicket(ticket) {
    try {
      if (typeof inbound?.queueTicketEmails === "function") {
        await inbound.queueTicketEmails(ticket);
      }
      const jobs =
        typeof mailer?.forTicket === "function"
          ? await mailer.forTicket(ticket.id)
          : [];
      for (const j of jobs || []) {
        if (j.status === "Pending" && typeof mailer?.attempt === "function") {
          try {
            await mailer.attempt(j.id);
          } catch (mailErr) {
            console.error(
              "Support mail attempt failed:",
              mailErr && mailErr.message,
            );
          }
        }
      }
      const nowJobs =
        typeof mailer?.forTicket === "function"
          ? await mailer.forTicket(ticket.id)
          : [];
      return {
        newTicket: (nowJobs || []).find((j) => j.kind === "new_ticket") || null,
        confirmation:
          (nowJobs || []).find((j) => j.kind === "customer_confirmation") ||
          null,
      };
    } catch (err) {
      console.error("notifyNewTicket error:", err && err.message);
      return { newTicket: null, confirmation: null };
    }
  }

  // ----- public submit (Vendor, Franchise, or not signed in) -----
  app.post("/api/support", submitLimiter, (req, res) => {
    upload.single("photo")(req, res, async (err) => {
      if (err)
        return res.status(400).json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "The photo is too large. Please attach an image under 5 MB."
              : "Could not read the attached photo. Please try another image.",
        });
      try {
        const sentPortal = String(req.body?.portal || "");
        const fromForm = sentPortal.startsWith("Vendor")
          ? "Vendor"
          : sentPortal.startsWith("Franchise")
            ? "Franchise"
            : "Unknown";
        const vendorSession = await auth.getSession(req, "vendor");
        const franchiseSession = await auth.getSession(req, "franchise");
        const signed =
          fromForm === "Vendor"
            ? vendorSession
            : fromForm === "Franchise"
              ? franchiseSession
              : vendorSession || franchiseSession;
        if (fromForm !== "Unknown" && !signed)
          return res.status(401).json({
            error: `Please sign in to the ${fromForm} Portal again, then send your request.`,
            code: "NOT_SIGNED_IN",
          });
        if (signed && signed.account.must_change_password)
          return res.status(403).json({
            error: "Please set a new password first.",
            code: "PASSWORD_CHANGE_REQUIRED",
          });

        const portalType = signed
          ? partnerPortalType(signed.account.role)
          : fromForm;
        const oneLine = (v) =>
          String(v || "")
            .replace(/[\r\n]+/g, " ")
            .trim();
        const limits = service.TEXT_LIMITS || {
          name: 160,
          email: 254,
          phone: 20,
          description: 10000,
        };
        const name = oneLine(req.body?.name).slice(0, limits.name);
        const email = oneLine(req.body?.email).slice(0, limits.email);
        const phone = oneLine(req.body?.phone).slice(0, limits.phone);
        const description = String(req.body?.description || "")
          .trim()
          .slice(0, limits.description);
        const photo = req.file;

        if (!name || !email || !description || !photo)
          return res.status(400).json({
            error:
              "Please provide your name, email, problem description, and a photo.",
          });
        if (/\d/.test(name))
          return res.status(400).json({
            error: "The name cannot contain numbers.",
            field: "name",
          });

        let phoneDigits = phone.replace(/\D/g, "");
        if (phoneDigits.length === 12 && phoneDigits.startsWith("91"))
          phoneDigits = phoneDigits.slice(2);
        if (phoneDigits.length === 11 && phoneDigits.startsWith("0"))
          phoneDigits = phoneDigits.slice(1);
        if (phone && !PHONE_OK.test(phoneDigits))
          return res.status(400).json({
            error: "The contact number must be a 10-digit mobile number.",
            field: "phone",
          });
        if (!EMAIL_OK.test(email))
          return res.status(400).json({
            error: "Please provide a valid email address.",
            field: "email",
          });

        const submissionKey = /^[A-Za-z0-9-]{8,64}$/.test(
          req.body?.submissionId || "",
        )
          ? req.body.submissionId
          : null;
        const created = await service.create({
          portalType,
          signedIn: !!signed,
          account: signed ? signed.account : null,
          name,
          email,
          phone: phoneDigits.length === 10 ? phoneDigits : phone,
          description,
          photo,
          submissionKey,
        });
        const ticket = created.ticket;
        const jobs = created.duplicate
          ? {
              newTicket:
                typeof mailer?.newTicketStatus === "function"
                  ? await mailer.newTicketStatus(ticket.id)
                  : null,
              confirmation: null,
            }
          : await notifyNewTicket(ticket);
        const job = jobs.newTicket;
        const confirm = jobs.confirmation;
        const ccCount = (await copyList()).length;

        return res.status(created.duplicate ? 200 : 201).json({
          ok: true,
          duplicate: created.duplicate,
          ticketId: ticket.ticket_no,
          emailStatus: job ? job.status : "Not queued",
          emailSent: !!job && job.status === "Sent",
          emailError:
            job && job.status !== "Sent"
              ? job.lastError || "Email delivery failed"
              : "",
          customerEmailStatus: confirm ? confirm.status : "Not queued",
          adminCopy: ccCount > 0,
          message:
            `${created.duplicate ? "This request was already received." : "Your issue has been submitted."} ` +
            `Your Ticket ID is ${ticket.ticket_no}. ${emailSentence(job)}` +
            (confirm && confirm.status === "Sent"
              ? " A confirmation has been sent to your email address."
              : ""),
        });
      } catch (e) {
        fail(res, e, "Support submission failed:");
      }
    });
  });

  // ----- partner (Vendor / Franchise) -----
  app.get("/api/support/mine", mineLimiter, partnerGuard, async (req, res) => {
    try {
      const list = await service.listForAccount(req.partner);
      res.json({ tickets: await Promise.all((list || []).map(enrichPhone)) });
    } catch (e) {
      fail(res, e, "Support list failed:");
    }
  });
  app.get(
    "/api/support/mine/:id",
    mineLimiter,
    partnerGuard,
    async (req, res) => {
      try {
        const d = await service.getForAccount(req.params.id, req.partner);
        res.json({ ...d, ticket: await enrichPhone(d.ticket) });
      } catch (e) {
        fail(res, e, "Support ticket read failed:");
      }
    },
  );
  app.get(
    "/api/support/mine/:id/photo",
    mineLimiter,
    partnerGuard,
    async (req, res) => {
      await sendPhoto(req, res, (id) => service.rowForAccount(id, req.partner));
    },
  );
  app.post("/api/support/mine/:id/messages", partnerGuard, async (req, res) => {
    try {
      const body = String(req.body?.message || "");
      const out = await service.partnerFollowUp(
        req.params.id,
        req.partner,
        body,
      );
      const ticket = out.ticket;
      try {
        const { job } = await mailer.enqueue({
          ticketId: ticket.id,
          dedupeKey: `followup:${out.eventId}`,
          kind: "followup",
          to: supportEmail,
          cc: await copyList(),
          subject: FOLLOWUP_SUBJECT(ticket.ticket_no),
          body: followUpBody(
            {
              ...ticket,
              ticket_no: ticket.ticket_no,
              customer_name: ticket.customer_name,
              portal_type: ticket.portal_type,
            },
            { author: req.partner.login_id, text: body.trim(), baseUrl },
          ),
          sourceEventId: null,
        });
        if (job?.id && typeof mailer.attempt === "function")
          await mailer.attempt(job.id);
      } catch (mailErr) {
        console.error("Follow-up email failed:", mailErr && mailErr.message);
      }
      res.json(out.detail);
    } catch (e) {
      fail(res, e, "Support follow-up failed:");
    }
  });

  // ----- admin -----
  app.get("/api/admin/support/tickets", adminGuard, async (req, res) => {
    try {
      const out = await service.listForAdmin({
        status: String(req.query.status || ""),
        portal: String(req.query.portal || ""),
        q: String(req.query.q || "").slice(0, 120),
      });
      out.tickets = await Promise.all(
        (out.tickets || []).map(async (t) => {
          const withPhone = await enrichPhone(t);
          return {
            ...withPhone,
            newTicketEmail:
              typeof mailer?.newTicketStatus === "function"
                ? await mailer.newTicketStatus(t.id)
                : null,
          };
        }),
      );
      const failedEmails =
        typeof mailer?.failedCount === "function"
          ? await mailer.failedCount()
          : 0;
      out.summary = { ...out.summary, failedEmails };
      res.json(out);
    } catch (e) {
      fail(res, e, "Admin support list failed:");
    }
  });
  app.get("/api/admin/support/tickets/:id", adminGuard, async (req, res) => {
    try {
      const d = await service.getForAdmin(req.params.id);
      const emailJobs =
        typeof mailer?.forTicket === "function"
          ? await mailer.forTicket(d.ticket.id)
          : [];
      res.json({ ...d, ticket: await enrichPhone(d.ticket), emailJobs });
    } catch (e) {
      fail(res, e, "Support ticket read failed:");
    }
  });
  app.get(
    "/api/admin/support/tickets/:id/photo",
    adminGuard,
    async (req, res) => {
      await sendPhoto(req, res, (id) => service.rowById(id));
    },
  );
  app.post(
    "/api/admin/support/tickets/:id/reply",
    adminGuard,
    async (req, res) => {
      try {
        const actor = req.adminEmail || req.account.login_id;
        const out = await service.adminReply(
          req.params.id,
          actor,
          req.body?.message,
        );
        const t = out.ticket;
        let sent = null;
        try {
          const { job } = await mailer.enqueue({
            ticketId: t.id,
            dedupeKey: `reply:${out.eventId}`,
            kind: "customer_reply",
            to: t.email,
            subject: REPLY_SUBJECT(t.ticket_no),
            body: replyBody(
              t.ticket_no,
              String(req.body?.message || "").trim(),
            ),
            inReplyTo: await lastMessageId(t.id),
            sourceEventId: out.eventId,
          });
          if (job?.id && typeof mailer.attempt === "function")
            sent = await mailer.attempt(job.id);
        } catch (mailErr) {
          console.error(
            "Support reply email failed:",
            mailErr && mailErr.message,
          );
        }
        const updated = await service.getForAdmin(t.id);
        const emailJobs =
          typeof mailer?.forTicket === "function"
            ? await mailer.forTicket(t.id)
            : [];
        res.json({
          ...updated,
          ticket: await enrichPhone(updated.ticket),
          emailJobs,
          replyEmail: sent,
        });
      } catch (e) {
        fail(res, e, "Support reply failed:");
      }
    },
  );
  app.post(
    "/api/admin/support/tickets/:id/status",
    adminGuard,
    async (req, res) => {
      try {
        const status = String(req.body?.status || "");
        if (!SUPPORT_STATUSES.includes(status))
          throw new SupportError("Unknown status.", 400);
        const actor = req.adminEmail || req.account.login_id;
        const d = await service.setStatus(
          req.params.id,
          actor,
          status,
          req.body?.note,
        );
        const emailJobs =
          typeof mailer?.forTicket === "function"
            ? await mailer.forTicket(d.ticket.id)
            : [];
        res.json({ ...d, ticket: await enrichPhone(d.ticket), emailJobs });
      } catch (e) {
        fail(res, e, "Support status change failed:");
      }
    },
  );
  app.post(
    "/api/admin/support/emails/:jobId/retry",
    adminGuard,
    async (req, res) => {
      try {
        const job = await mailer.retry(req.params.jobId);
        if (!job) return res.status(404).json({ error: "Email not found." });
        res.json({ job });
      } catch (e) {
        if (/Only a failed/.test(e.message))
          return res.status(409).json({ error: e.message });
        fail(res, e, "Email retry failed:");
      }
    },
  );
  app.get("/api/admin/support/inbound", adminGuard, (req, res) => {
    res.json(inbound.status());
  });
  app.post("/api/admin/support/inbound/check", adminGuard, async (req, res) => {
    if (!inbound.enabled())
      return res.status(409).json({ error: inbound.status().setupNote });
    const handled = await inbound.pollOnce();
    res.json({ ...inbound.status(), handled });
  });

  async function sendPhoto(req, res, lookup) {
    try {
      const row = await lookup(req.params.id);
      if (!row) return res.status(404).json({ error: "Photo not found." });
      const file = await service.photoFor(row);
      if (!file) return res.status(404).json({ error: "Photo not found." });
      const ext =
        (file.mime && file.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "")) ||
        "jpg";
      res.set({
        "Content-Type": file.mime,
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${row.ticket_no}.${ext}"`,
      });
      if (Buffer.isBuffer(file.buffer)) {
        return res.send(file.buffer);
      }
      if (!file.abs || !fs.existsSync(file.abs)) {
        return res.status(404).json({ error: "Photo not found." });
      }
      const stream = fs.createReadStream(file.abs);
      stream.on("error", () => {
        if (!res.headersSent)
          res.status(404).json({ error: "Photo not found." });
        else res.end();
      });
      stream.pipe(res);
    } catch (e) {
      fail(res, e, "Support photo failed:");
    }
  }
}
