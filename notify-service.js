const nodemailer = require("nodemailer");

function normalizeIndianPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

function buildReadyMessageText({ schoolName, studentName, docTitle, serialNo, approverName }) {
  const lines = [
    `Namaste from ${schoolName || "School Office"}.`,
    `Your document request has been approved:`,
    `• Student: ${studentName}`,
    `• Document: ${docTitle}`,
    serialNo ? `• Ref No: ${serialNo}` : "",
    approverName ? `• Approved by: ${approverName}` : "",
    "",
    "Please visit the school office counter to collect your original stamped copy in person (no online PDF is sent).",
  ].filter(Boolean);
  return lines.join("\n");
}

function buildWhatsAppReadyUrl({ phone, schoolName, studentName, docTitle, serialNo, approverName, verifyUrl }) {
  const num = normalizeIndianPhone(phone);
  if (!num) return "";
  const msg = buildReadyMessageText({
    schoolName,
    studentName,
    docTitle,
    serialNo,
    approverName,
    verifyUrl,
  });
  return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
}

function createNotifyService({
  db,
  settings,
  portalUrl,
  verifyUrl,
  smtpFactory = (cfg) => nodemailer.createTransport(cfg),
  fetchImpl = globalThis.fetch,
}) {
  function getSmtpConfig() {
    const s = settings() || {};
    const host = String(s.smtp_host || process.env.SMTP_HOST || "").trim();
    const port = Number(s.smtp_port || process.env.SMTP_PORT || 587) || 587;
    const user = String(s.smtp_user || process.env.SMTP_USER || "").trim();
    const pass = String(s.smtp_pass || process.env.SMTP_PASS || "").trim();
    const from = String(s.smtp_from || process.env.SMTP_FROM || user || "").trim();
    if (!host || !user || !pass) return null;
    return {
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      from: from || user,
    };
  }

  async function sendEmailReady({ toEmail, studentName, docTitle, serialNo, approverName }) {
    const cfg = getSmtpConfig();
    if (!cfg || !toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(toEmail).trim())) {
      return { sent: false, skipped: true };
    }
    const s = settings() || {};
    const verifyUrlLink =
      typeof verifyUrl === "function"
        ? verifyUrl(serialNo)
        : serialNo && typeof portalUrl === "function" && portalUrl()
          ? `${portalUrl()}/verify/${encodeURIComponent(serialNo)}`
          : "";
    const textBody = buildReadyMessageText({
      schoolName: s.school_name || "R. J. Chaware Convent",
      studentName,
      docTitle,
      serialNo,
      approverName,
      verifyUrl: verifyUrlLink,
    });
    const transporter = smtpFactory({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.auth,
    });
    await transporter.sendMail({
      from: `"${String(s.school_name || "School Office").replace(/"/g, "")}" <${cfg.from}>`,
      to: String(toEmail).trim(),
      subject: `${docTitle} Ready — ${studentName} (${serialNo || "Approved"})`,
      text: textBody,
    });
    return { sent: true, channel: "email", to: String(toEmail).trim() };
  }

  function getWhatsAppConfig() {
    const s = settings() || {};
    const token = String(s.whatsapp_token || process.env.WHATSAPP_TOKEN || "").trim();
    const phoneId = String(s.whatsapp_phone_id || process.env.PHONE_NUMBER_ID || "").trim();
    const templateName = String(
      s.whatsapp_ready_template || process.env.WHATSAPP_READY_TEMPLATE || "",
    ).trim();
    if (!token || !phoneId || !templateName) return null;
    return { token, phoneId, templateName };
  }

  async function sendWhatsAppCloudReady({ phone, studentName, docTitle, serialNo }) {
    const waCfg = getWhatsAppConfig();
    const num = normalizeIndianPhone(phone);
    if (!waCfg || !num) {
      return { sent: false, skipped: true };
    }
    const version = process.env.WHATSAPP_API_VERSION || "v25.0";
    const res = await fetchImpl(
      `https://graph.facebook.com/${version}/${waCfg.phoneId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${waCfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: num,
          type: "template",
          template: {
            name: waCfg.templateName,
            language: { code: "en_US" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(studentName || "") },
                  { type: "text", text: String(docTitle || "") },
                  { type: "text", text: String(serialNo || "") },
                ],
              },
            ],
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`WhatsApp Cloud notification failed (${res.status})`);
    }
    return { sent: true, channel: "whatsapp_cloud", to: num };
  }

  async function notifyParentOnApproval(reqRow) {
    if (!reqRow || reqRow.status !== "APPROVED") return { channels: [] };
    const student = db
      .prepare("SELECT parent_phone, parent_email FROM students WHERE gr_number=?")
      .get(reqRow.gr_number);
    const toEmail = String(student?.parent_email || "").trim();
    const toPhone = String(reqRow.guardian_phone || reqRow.verified_phone || student?.parent_phone || "").trim();
    const channels = [];
    const errors = [];

    if (toEmail) {
      try {
        const res = await sendEmailReady({
          toEmail,
          studentName: reqRow.student_name,
          docTitle: reqRow.doc_title,
          serialNo: reqRow.serial_no,
          approverName: reqRow.reviewed_by_name,
        });
        if (res.sent) channels.push(`Email (${toEmail})`);
      } catch (e) {
        errors.push(`Email: ${e?.message || "failed"}`);
      }
    }

    if (toPhone && getWhatsAppConfig()) {
      try {
        const res = await sendWhatsAppCloudReady({
          phone: toPhone,
          studentName: reqRow.student_name,
          docTitle: reqRow.doc_title,
          serialNo: reqRow.serial_no,
        });
        if (res.sent) channels.push("WhatsApp");
      } catch (e) {
        errors.push(`WhatsApp: ${e?.message || "failed"}`);
      }
    }

    const statusText = channels.length
      ? `Sent: ${channels.join(", ")}`
      : errors.length
        ? `Failed: ${errors.join("; ")}`
        : "Ready for 1-click WhatsApp";

    db.prepare(
      "UPDATE approval_requests SET notification_status=?, notified_at=? WHERE id=?",
    ).run(statusText.slice(0, 180), channels.length ? new Date().toISOString() : "", reqRow.id);

    return { channels, errors, statusText };
  }

  async function testSmtpConnection() {
    const cfg = getSmtpConfig();
    if (!cfg) {
      throw Object.assign(
        new Error("Enter SMTP Host, Username, and App Password first."),
        { status: 400 },
      );
    }
    const transporter = smtpFactory({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.auth,
    });
    if (typeof transporter.verify === "function") {
      await transporter.verify();
    }
    return { ok: true, host: cfg.host, user: cfg.auth.user };
  }

  return {
    notifyParentOnApproval,
    sendEmailReady,
    testSmtpConnection,
    buildWhatsAppReadyUrl,
  };
}

module.exports = {
  createNotifyService,
  buildWhatsAppReadyUrl,
  buildReadyMessageText,
  normalizeIndianPhone,
};
