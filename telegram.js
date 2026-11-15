const QRCode = require("qrcode");
const { formatIstDateTime } = require("./approval-service");

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(
    String(dataUrl || ""),
  );
  if (!m) return null;
  return {
    mime: m[1],
    buffer: Buffer.from(m[2], "base64"),
  };
}

function collectorRoleLabel(isGuardian) {
  return Number(isGuardian) === 1
    ? "Authorized Guardian"
    : "Parent / Family Collector";
}

function createTelegramBot({
  db,
  settings,
  approvalService,
  portalUrl,
  hashPassword = null,
  generatePdfForRequest = null,
  qrCodeGenerator = null,
  onApproved = () => {},
  fetchImpl = globalThis.fetch,
}) {
  let polling = false;
  let stopped = false;
  let pollTimer = null;
  let commandsSyncedForToken = "";
  const pendingPrompt = new Map();
  const verifiedJoinChats = new Set();
  const recentDiscoveredChats = new Map();
  const PREDEFINED_ROLES = [
    "Principal",
    "Vice Principal",
    "Headmaster",
    "Senior Teacher",
    "Class Teacher",
    "Office Clerk",
    "Top Teacher",
    "Staff",
  ];

  function getBotToken() {
    try {
      const s = settings();
      return String(
        s?.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || "",
      ).trim();
    } catch {
      return String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
    }
  }

  function getStorageChatId() {
    try {
      const s = settings();
      return String(
        s?.telegram_storage_chat_id || process.env.TELEGRAM_STORAGE_CHAT_ID || "",
      ).trim();
    } catch {
      return String(process.env.TELEGRAM_STORAGE_CHAT_ID || "").trim();
    }
  }

  function getTopicId(kind) {
    try {
      const s = settings() || {};
      const raw =
        kind === "pending"
          ? s.telegram_topic_pending
          : kind === "approved"
            ? s.telegram_topic_approved
            : kind === "scans"
              ? s.telegram_topic_scans
              : "";
      const num = Number(raw);
      return Number.isInteger(num) && num > 1 ? num : null;
    } catch {
      return null;
    }
  }

  async function callApi(method, payload, multipart = false) {
    const token = getBotToken();
    if (!token) return null;
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetchImpl(url, {
      method: "POST",
      ...(multipart
        ? { body: payload }
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const msg = data?.description || `Telegram ${method} failed (${res.status})`;
      throw Object.assign(new Error(msg), { telegramStatus: res.status });
    }
    return data.result;
  }

  async function callTopicApi(method, chatId, topicKind, payload, isForm = false) {
    const threadId = getTopicId(topicKind);
    if (!threadId) return callApi(method, payload, isForm);
    try {
      if (isForm) {
        payload.append("message_thread_id", String(threadId));
        return await callApi(method, payload, true);
      }
      return await callApi(method, { ...payload, message_thread_id: threadId }, false);
    } catch (e) {
      if (/thread|topic/i.test(String(e?.message || ""))) {
        if (isForm && typeof payload.delete === "function") {
          payload.delete("message_thread_id");
          return await callApi(method, payload, true);
        }
        return await callApi(method, payload, false);
      }
      throw e;
    }
  }

  function formatRequestCaption(reqRow, extraStatus = "") {
    const collectorDesc = reqRow.is_guardian
      ? `Authorized Guardian (${reqRow.guardian_phone || "Verified"})`
      : `Parent / Family Collector (${reqRow.verified_phone || "Verified"})`;
    const lines = [
      `RJC DOCUMENT REQUEST · ${reqRow.id}`,
      `Student: ${reqRow.student_name} (GR: ${reqRow.gr_number})`,
      `Document: ${reqRow.doc_title}`,
      `Collector: ${collectorDesc}`,
      reqRow.reason ? `Purpose: ${reqRow.reason}` : "",
      reqRow.campus_code_used ? `Campus Code: ${reqRow.campus_code_used}` : "",
      `Requested: ${formatIstDateTime(reqRow.created_at)}`,
      reqRow.supporting_doc_name
        ? `Attachment: ${reqRow.supporting_doc_name}`
        : `Attachment: None`,
    ].filter(Boolean);
    if (extraStatus) lines.push("", extraStatus);
    return lines.join("\n").slice(0, 1020);
  }

  function buildInlineKeyboard(reqId, portalBase) {
    const rows = [
      [
        { text: "✓ Approve & Print", callback_data: `approve:${reqId}` },
        { text: "✕ Reject", callback_data: `reject:${reqId}` },
      ],
    ];
    if (portalBase && /^https?:\/\//i.test(portalBase)) {
      rows.push([
        {
          text: "Open Teacher Mobile Portal",
          url: `${portalBase}/teacher?req=${encodeURIComponent(reqId)}`,
        },
      ]);
    }
    return { inline_keyboard: rows };
  }

  async function sendRequestNotifications(reqRow) {
    const token = getBotToken();
    if (!token) return { sent: 0, skipped: true };
    const recipients = db
      .prepare(
        "SELECT id, name, role, telegram_chat_id FROM teachers WHERE is_active=1 AND COALESCE(telegram_chat_id,'')!=''",
      )
      .all();
    const storageChatId = getStorageChatId();
    if (!recipients.length && !storageChatId) return { sent: 0, skipped: true };

    const tplRow = reqRow.template_id
      ? db.prepare("SELECT require_top_teacher FROM document_templates WHERE id=?").get(reqRow.template_id)
      : null;
    const portalBase = portalUrl();
    const lockNote = tplRow?.require_top_teacher
      ? "⚠ Top Teacher (Slot 1–3) approval required"
      : "";
    const caption = formatRequestCaption(reqRow, lockNote);
    const replyMarkup = buildInlineKeyboard(reqRow.id, portalBase);
    const photoPart = dataUrlToBuffer(reqRow.parent_photo_data);
    const docPart = dataUrlToBuffer(reqRow.supporting_doc_data);
    const sentMessages = [];

    for (const teacher of recipients) {
      const chatId = String(teacher.telegram_chat_id).trim();
      if (!chatId) continue;
      try {
        let msg;
        if (photoPart && photoPart.mime.startsWith("image/")) {
          const form = new FormData();
          form.append("chat_id", chatId);
          form.append("caption", caption);
          form.append("reply_markup", JSON.stringify(replyMarkup));
          const ext = photoPart.mime.includes("png") ? "png" : "jpg";
          form.append(
            "photo",
            new Blob([photoPart.buffer], { type: photoPart.mime }),
            `parent-face-${reqRow.id}.${ext}`,
          );
          msg = await callApi("sendPhoto", form, true);
          sentMessages.push({
            chatId,
            messageId: msg.message_id,
            hasPhoto: true,
          });
        } else {
          msg = await callApi("sendMessage", {
            chat_id: chatId,
            text: caption,
            reply_markup: replyMarkup,
          });
          sentMessages.push({
            chatId,
            messageId: msg.message_id,
            hasPhoto: false,
          });
        }

        if (docPart) {
          const docForm = new FormData();
          docForm.append("chat_id", chatId);
          docForm.append(
            "caption",
            `Supporting application for ${reqRow.student_name} (${reqRow.id})`,
          );
          docForm.append(
            "document",
            new Blob([docPart.buffer], { type: docPart.mime }),
            reqRow.supporting_doc_name || `application-${reqRow.id}`,
          );
          await callApi("sendDocument", docForm, true);
        }
      } catch (e) {
        console.error(
          `Telegram send failed for ${teacher.name} (${chatId}):`,
          e?.message || e,
        );
      }
    }

    if (
      storageChatId &&
      !sentMessages.some((m) => m.chatId === storageChatId)
    ) {
      try {
        const groupCaption = formatRequestCaption(
          reqRow,
          lockNote
            ? `${lockNote}\nGROUP HUB · Waiting for approval`
            : "TEACHERS GROUP HUB · Waiting for approval",
        );
        let groupMsg;
        if (photoPart && photoPart.mime.startsWith("image/")) {
          const form = new FormData();
          form.append("chat_id", storageChatId);
          form.append("caption", groupCaption);
          form.append("reply_markup", JSON.stringify(replyMarkup));
          const ext = photoPart.mime.includes("png") ? "png" : "jpg";
          form.append(
            "photo",
            new Blob([photoPart.buffer], { type: photoPart.mime }),
            `collector-face-${reqRow.id}.${ext}`,
          );
          groupMsg = await callTopicApi("sendPhoto", storageChatId, "pending", form, true);
          sentMessages.push({
            chatId: storageChatId,
            messageId: groupMsg.message_id,
            hasPhoto: true,
          });
        } else {
          groupMsg = await callTopicApi("sendMessage", storageChatId, "pending", {
            chat_id: storageChatId,
            text: groupCaption,
            reply_markup: replyMarkup,
          });
          sentMessages.push({
            chatId: storageChatId,
            messageId: groupMsg.message_id,
            hasPhoto: false,
          });
        }
        if (docPart) {
          const docForm = new FormData();
          docForm.append("chat_id", storageChatId);
          docForm.append(
            "caption",
            `Application upload · ${reqRow.student_name} (${reqRow.id})`,
          );
          docForm.append(
            "document",
            new Blob([docPart.buffer], { type: docPart.mime }),
            reqRow.supporting_doc_name || `application-${reqRow.id}`,
          );
          await callTopicApi("sendDocument", storageChatId, "pending", docForm, true);
        }
      } catch (e) {
        console.error(
          `Telegram teachers group/archive copy failed (${storageChatId}):`,
          e?.message || e,
        );
      }
    }

    if (sentMessages.length) {
      db.prepare(
        "UPDATE approval_requests SET telegram_messages_json=? WHERE id=?",
      ).run(JSON.stringify(sentMessages), reqRow.id);
    }
    return { sent: sentMessages.length };
  }

  async function sendApprovedArchive(reqRow) {
    const token = getBotToken();
    const storageChatId = getStorageChatId();
    if (!token || !storageChatId || !reqRow || reqRow.status !== "APPROVED") {
      return { sent: false };
    }
    const logRow = reqRow.serial_no
      ? db
          .prepare(
            "SELECT doc_signature, security_code, COALESCE(last_print_code,'') AS last_print_code, COALESCE(print_count,0) AS print_count, printer_name, reason, campus_code_used FROM issued_logs WHERE serial_no=?",
          )
          .get(reqRow.serial_no)
      : null;
    const base = portalUrl();
    const sigPart = logRow?.doc_signature
      ? `?v=${encodeURIComponent(logRow.doc_signature)}`
      : "";
    const verifyLink =
      base && reqRow.serial_no
        ? `${base}/verify/${encodeURIComponent(reqRow.serial_no)}${sigPart}`
        : "";
    const purposeText = reqRow.reason || logRow?.reason || "";
    const campusText = reqRow.campus_code_used || logRow?.campus_code_used || "";
    const printCodeText = reqRow.last_print_code || logRow?.last_print_code || "";
    const summary = [
      `✓ APPROVED AUDIT & QR PROOF · ${reqRow.serial_no || reqRow.id}${logRow?.security_code ? ` · Seal: ${logRow.security_code}` : ""}`,
      printCodeText ? `Print 2FA Code: ${printCodeText} · Sheet #${String(Math.max(1, Number(logRow?.print_count || 1))).padStart(2, "0")}` : "",
      `Student: ${reqRow.student_name} (GR: ${reqRow.gr_number})`,
      `Document: ${reqRow.doc_title}`,
      `Collector: ${collectorRoleLabel(reqRow.is_guardian)}`,
      purposeText ? `Purpose: ${purposeText}` : "",
      campusText ? `Campus Code: ${campusText}` : "",
      `Requested at: ${formatIstDateTime(reqRow.created_at)}`,
      `Approved by: ${reqRow.reviewed_by_name} (${reqRow.reviewed_by_role}) via ${reqRow.review_channel}`,
      `Approved at: ${formatIstDateTime(reqRow.reviewed_at)}`,
      `Office Record: Certificate PDF stays strictly on School Counter PC`,
      verifyLink ? `Verification QR Link: ${verifyLink}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1020);
    try {
      let qrPngBuffer = null;
      if (verifyLink) {
        if (typeof qrCodeGenerator === "function") {
          qrPngBuffer = await qrCodeGenerator(verifyLink);
        } else {
          qrPngBuffer = await QRCode.toBuffer(verifyLink, {
            width: 320,
            margin: 2,
            errorCorrectionLevel: "M",
          });
        }
      }
      if (qrPngBuffer && qrPngBuffer.length) {
        const form = new FormData();
        form.append("chat_id", storageChatId);
        form.append("caption", summary);
        form.append(
          "photo",
          new Blob([qrPngBuffer], { type: "image/png" }),
          `qr-proof-${reqRow.serial_no || reqRow.id}.png`,
        );
        await callTopicApi("sendPhoto", storageChatId, "approved", form, true);
      } else {
        await callTopicApi("sendMessage", storageChatId, "approved", {
          chat_id: storageChatId,
          text: summary,
        });
      }
      return { sent: true };
    } catch (e) {
      console.error(
        `Telegram approved QR proof failed (${storageChatId}):`,
        e?.message || e,
      );
      return { sent: false };
    }
  }

  async function sendQrScanAlert(scanRecord) {
    const token = getBotToken();
    const storageChatId = getStorageChatId();
    const s = settings();
    if (!token || !storageChatId || !scanRecord || Number(s?.notify_qr_scans ?? 1) === 0) {
      return { sent: false };
    }
    const textMsg = [
      `🔍 QR VERIFICATION SCAN #${scanRecord.scan_count || 1}`,
      `Ref: ${scanRecord.serial_no}${scanRecord.security_code ? ` · Seal: ${scanRecord.security_code}` : ""}${scanRecord.last_print_code ? ` · 2FA: ${scanRecord.last_print_code}` : ""}`,
      `Student: ${scanRecord.student_name} (GR: ${scanRecord.gr_number})`,
      `Document: ${scanRecord.doc_title}`,
      `Collector: ${collectorRoleLabel(scanRecord.is_guardian)}`,
      `Approved by: ${scanRecord.approved_by_name || "School Office"}${scanRecord.approved_by_role ? ` (${scanRecord.approved_by_role})` : ""}`,
      scanRecord.print_count
        ? `Prints Issued: ${scanRecord.print_count} Sheet(s)${scanRecord.printer_name ? ` · Printer: ${scanRecord.printer_name}` : ""}`
        : "",
      scanRecord.issued_at ? `Issued at: ${formatIstDateTime(scanRecord.issued_at)}` : "",
      `Scanned at: ${formatIstDateTime(scanRecord.last_scanned_at || new Date().toISOString())}`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await callTopicApi("sendMessage", storageChatId, "scans", {
        chat_id: storageChatId,
        text: textMsg,
      });
      return { sent: true };
    } catch {
      return { sent: false };
    }
  }

  async function syncReviewedMessages(reqRow) {
    const token = getBotToken();
    if (!token) return;
    let msgs = [];
    try {
      msgs = JSON.parse(reqRow.telegram_messages_json || "[]");
    } catch {}
    if (!Array.isArray(msgs) || !msgs.length) return;

    const statusLine =
      reqRow.status === "APPROVED"
        ? `${reqRow.print_status === "HOLD_STAFF" ? "✓ APPROVED · Waiting Staff confirmation at counter to print" : "✓ APPROVED & SENT TO PRINTER"}\nApproved by: ${reqRow.reviewed_by_name} (${reqRow.reviewed_by_role})\nChannel: ${reqRow.review_channel}\nSerial: ${reqRow.serial_no}${reqRow.last_print_code ? ` · Print 2FA: ${reqRow.last_print_code}` : ""}\nTime: ${formatIstDateTime(reqRow.reviewed_at)}`
        : `✕ REJECTED\nReviewed by: ${reqRow.reviewed_by_name} (${reqRow.reviewed_by_role})\nReason: ${reqRow.rejection_reason || "Declined"}\nTime: ${formatIstDateTime(reqRow.reviewed_at)}`;

    const updatedCaption = formatRequestCaption(reqRow, statusLine);
    for (const m of msgs) {
      try {
        if (m.hasPhoto) {
          await callApi("editMessageCaption", {
            chat_id: m.chatId,
            message_id: m.messageId,
            caption: updatedCaption,
            reply_markup: { inline_keyboard: [] },
          });
        } else {
          await callApi("editMessageText", {
            chat_id: m.chatId,
            message_id: m.messageId,
            text: updatedCaption,
            reply_markup: { inline_keyboard: [] },
          });
        }
      } catch {}
    }
  }

  function buildHubKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: "📋 Pending Requests", callback_data: "hub:pending" },
          { text: "📊 Today Summary", callback_data: "hub:today" },
        ],
        [
          { text: "🔍 Recent Logs", callback_data: "hub:logs" },
          { text: "👁 QR Scans", callback_data: "hub:scans" },
        ],
        [
          { text: "👥 Team Roster", callback_data: "hub:team" },
          { text: "⚙ Setup Menu", callback_data: "hub:menu" },
        ],
      ],
    };
  }

  function buildMainMenuKeyboard(teacher) {
    const rows = [];
    if (teacher) {
      rows.push([
        { text: "📋 Pending Requests", callback_data: "hub:pending" },
        { text: "📊 Today Summary", callback_data: "hub:today" },
      ]);
      rows.push([
        { text: "🔍 Recent Logs", callback_data: "hub:logs" },
        { text: "👁 QR Scans", callback_data: "hub:scans" },
      ]);
      rows.push([
        { text: "🔄 Switch Slot / Staff", callback_data: "menu:switch" },
        { text: "🏷 Change Title / Role", callback_data: "menu:role" },
      ]);
      rows.push([
        { text: "✏ Change Name", callback_data: "menu:name" },
        { text: "🔑 Set Web PIN", callback_data: "menu:pin" },
      ]);
      rows.push([
        { text: "👥 View Team", callback_data: "menu:team" },
        { text: "➕ Predefine Teacher / Staff", callback_data: "menu:predefine" },
      ]);
      rows.push([
        teacher.is_active
          ? { text: "⏸ Pause My Alerts", callback_data: "menu:pause" }
          : { text: "▶ Resume My Alerts", callback_data: "menu:resume" },
      ]);
    } else {
      rows.push([
        { text: "🚀 Join / Link Account", callback_data: "menu:join" },
        { text: "➕ Predefine Teacher / Staff", callback_data: "menu:predefine" },
      ]);
    }
    return { inline_keyboard: rows };
  }

  function buildRosterPickKeyboard() {
    const all = db
      .prepare(
        "SELECT id, slot_number, name, role, is_top_teacher, telegram_chat_id FROM teachers ORDER BY is_top_teacher DESC, CASE WHEN slot_number > 0 THEN slot_number ELSE 99 END ASC, id ASC",
      )
      .all();
    const rows = [];
    for (let slot = 1; slot <= 3; slot++) {
      const slotRow = all.find((t) => t.is_top_teacher === 1 && Number(t.slot_number) === slot);
      if (slotRow) {
        const tag = slotRow.telegram_chat_id ? "Linked" : "Predefined";
        rows.push([
          {
            text: `⭐ Slot ${slot}: ${slotRow.name} (${slotRow.role || "Top Teacher"} · ${tag})`,
            callback_data: `claim_teacher:${slotRow.id}`,
          },
        ]);
      } else {
        rows.push([
          {
            text: `⭐ Slot ${slot}: Empty — Tap to Claim`,
            callback_data: `pick_slot:${slot}`,
          },
        ]);
      }
    }
    const extraTopRows = all.filter((t) => t.is_top_teacher === 1 && Number(t.slot_number) === 0).slice(0, 6);
    for (const t of extraTopRows) {
      const tag = t.telegram_chat_id ? "Linked" : "Tap to link";
      rows.push([
        {
          text: `⭐ Top Teacher: ${t.name} (${t.role || "Top Teacher"} · ${tag})`,
          callback_data: `claim_teacher:${t.id}`,
        },
      ]);
    }
    const staffRows = all.filter((t) => !t.is_top_teacher).slice(0, 8);
    for (const s of staffRows) {
      const tag = s.telegram_chat_id ? "Linked" : "Tap to link";
      rows.push([
        {
          text: `👤 Staff: ${s.name}${s.role && s.role !== "Staff" ? ` · ${s.role}` : ""} (${tag})`,
          callback_data: `claim_teacher:${s.id}`,
        },
      ]);
    }
    rows.push([
      { text: "⭐ Join as Additional Top Teacher", callback_data: "pick_slot:4" },
      { text: "➕ Join as New Staff", callback_data: "pick_slot:0" },
    ]);
    rows.push([
      { text: "📝 Predefine Teacher / Staff", callback_data: "menu:predefine" },
    ]);
    return { inline_keyboard: rows };
  }

  function buildRolePickKeyboard(prefix = "set_role") {
    const rows = [];
    for (let i = 0; i < PREDEFINED_ROLES.length; i += 2) {
      const pair = PREDEFINED_ROLES.slice(i, i + 2).map((r) => ({
        text: r,
        callback_data: `${prefix}:${r}`,
      }));
      rows.push(pair);
    }
    rows.push([{ text: "✎ Type Custom Title", callback_data: `${prefix}:__custom__` }]);
    return { inline_keyboard: rows };
  }

  function buildPredefinePositionKeyboard() {
    const all = db
      .prepare("SELECT slot_number, name, role, is_top_teacher FROM teachers WHERE is_top_teacher=1")
      .all();
    const rows = [];
    for (let slot = 1; slot <= 3; slot++) {
      const cur = all.find((t) => Number(t.slot_number) === slot);
      rows.push([
        {
          text: cur
            ? `⭐ Update Slot ${slot}: ${cur.name} (${cur.role || "Top Teacher"})`
            : `⭐ Predefine Top Teacher Slot ${slot}`,
          callback_data: `predefine_pos:${slot}`,
        },
      ]);
    }
    rows.push([
      { text: "⭐ Add Extra Top Teacher", callback_data: "predefine_pos:4" },
      { text: "➕ Add Predefined Staff", callback_data: "predefine_pos:0" },
    ]);
    return { inline_keyboard: rows };
  }

  function hasVerifiedAccess(chatId, actorId = "") {
    const s = getStorageChatId();
    if (s && String(chatId) === s) return true;
    for (const id of [chatId, actorId]) {
      const cid = String(id || "").trim();
      if (!cid) continue;
      if (verifiedJoinChats.has(cid)) return true;
      const row = db.prepare("SELECT id FROM teachers WHERE telegram_chat_id=?").get(cid);
      if (row) {
        verifiedJoinChats.add(cid);
        return true;
      }
    }
    return false;
  }

  function isValidJoinCode(code) {
    const expectedCode = String(settings()?.staff_join_code || "").trim();
    return Boolean(expectedCode && String(code || "").trim().toUpperCase() === expectedCode.toUpperCase());
  }

  async function sendRosterPicker(chatId, intro = "Tap a Top Teacher slot, a predefined person, or Join as New Staff:") {
    await callApi("sendMessage", {
      chat_id: chatId,
      text: intro,
      reply_markup: buildRosterPickKeyboard(),
    }).catch(() => {});
  }

  function istDayStartIso() {
    const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
    const ymd = nowIst.toISOString().slice(0, 10);
    return new Date(`${ymd}T00:00:00+05:30`).toISOString();
  }

  async function sendHubOverview(chatId) {
    const dayStart = istDayStartIso();
    const pendingCount = Number(
      db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE status='PENDING'").get()?.n || 0,
    );
    const holdCount = Number(
      db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE status='APPROVED' AND print_status='HOLD_STAFF'").get()?.n || 0,
    );
    const approvedToday = Number(
      db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE status='APPROVED' AND reviewed_at >= ?").get(dayStart)?.n || 0,
    );
    const printedToday = Number(
      db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE print_status='PRINTED' AND reviewed_at >= ?").get(dayStart)?.n || 0,
    );
    const rejectedToday = Number(
      db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE status='REJECTED' AND reviewed_at >= ?").get(dayStart)?.n || 0,
    );
    const totalScans = Number(
      db.prepare("SELECT COALESCE(SUM(scan_count), 0) AS n FROM issued_logs").get()?.n || 0,
    );
    const scansToday = Number(
      db.prepare("SELECT COUNT(*) AS n FROM qr_scans WHERE scanned_at >= ?").get(dayStart)?.n || 0,
    );
    const text = [
      `📊 RJC SCHOOL INFORMATION HUB · TODAY`,
      `• Pending Requests: ${pendingCount}`,
      `• Waiting Counter Print (HOLD_STAFF): ${holdCount}`,
      `• Approved Today: ${approvedToday} (Printed: ${printedToday})`,
      `• Rejected Today: ${rejectedToday}`,
      `• QR Scans Today: ${scansToday} (All-time total: ${totalScans})`,
      ``,
      `Tap a button below or use /pending, /logs, /scans, /team:`,
    ].join("\n");
    await callApi("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: buildHubKeyboard(),
    }).catch(() => {});
  }

  async function sendPendingList(chatId) {
    const rows = db
      .prepare(
        `SELECT r.*, COALESCE(t.require_top_teacher, 0) AS require_top_teacher
         FROM approval_requests r
         LEFT JOIN document_templates t ON t.id = r.template_id
         WHERE r.status='PENDING'
         ORDER BY r.created_at DESC
         LIMIT 8`,
      )
      .all();
    if (!rows.length) {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "✓ No pending document requests right now.",
        reply_markup: buildHubKeyboard(),
      }).catch(() => {});
      return;
    }
    const lines = rows.map((r, i) => {
      const lock = r.require_top_teacher ? " [Top Teacher Only]" : "";
      const who = r.is_guardian
        ? `Guardian (${r.guardian_phone || "Verified"})`
        : r.verified_phone || "Verified";
      return `${i + 1}. ${r.id} · ${r.student_name} (GR: ${r.gr_number})\n   Doc: ${r.doc_title}${lock} · Contact: ${who}\n   Attachment: ${r.supporting_doc_name || "None"} · ${formatIstDateTime(r.created_at)}`;
    });
    const quickButtons = rows.slice(0, 3).map((r) => [
      { text: `✓ Approve ${r.id}`, callback_data: `approve:${r.id}` },
      { text: `✕ Reject ${r.id}`, callback_data: `reject:${r.id}` },
    ]);
    quickButtons.push([
      { text: "📊 Today Summary", callback_data: "hub:today" },
      { text: "🔍 Recent Logs", callback_data: "hub:logs" },
    ]);
    await callApi("sendMessage", {
      chat_id: chatId,
      text: `📋 PENDING REQUESTS (${rows.length}):\n\n${lines.join("\n\n")}`.slice(0, 4000),
      reply_markup: { inline_keyboard: quickButtons },
    }).catch(() => {});
  }

  async function sendLogsList(chatId, searchQuery = "") {
    const q = String(searchQuery || "").trim();
    const rows = q
      ? db
          .prepare(
            `SELECT serial_no, student_name, gr_number, doc_title, approved_by_name, approved_by_role, COALESCE(security_code,'') AS security_code, COALESCE(last_print_code,'') AS last_print_code, COALESCE(print_count,0) AS print_count, scan_count, issued_at
             FROM issued_logs
             WHERE student_name LIKE ? OR gr_number LIKE ? OR serial_no LIKE ? OR COALESCE(approved_by_name,'') LIKE ? OR COALESCE(security_code,'') LIKE ? OR COALESCE(last_print_code,'') LIKE ?
             ORDER BY issued_at DESC
             LIMIT 8`,
          )
          .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
      : db
          .prepare(
            `SELECT serial_no, student_name, gr_number, doc_title, approved_by_name, approved_by_role, COALESCE(security_code,'') AS security_code, COALESCE(last_print_code,'') AS last_print_code, COALESCE(print_count,0) AS print_count, scan_count, issued_at
             FROM issued_logs
             ORDER BY issued_at DESC
             LIMIT 8`,
          )
          .all();
    if (!rows.length) {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: q ? `No issued certificates found matching "${q}".` : "No certificates have been issued yet.",
        reply_markup: buildHubKeyboard(),
      }).catch(() => {});
      return;
    }
    const lines = rows.map(
      (r, i) =>
        `${i + 1}. ${r.serial_no} · ${r.student_name} (GR: ${r.gr_number})\n   Doc: ${r.doc_title} · Approved by: ${r.approved_by_name || "Office"} (${r.approved_by_role || "Staff"})${r.security_code ? `\n   Seal: ${r.security_code}` : ""}${r.last_print_code ? ` · 2FA: ${r.last_print_code}` : ""} · Prints: ${r.print_count || 0}\n   QR Scans: ${r.scan_count || 0} · Issued: ${formatIstDateTime(r.issued_at)}`,
    );
    await callApi("sendMessage", {
      chat_id: chatId,
      text: `🔍 ${q ? `ISSUED LOGS FOR "${q}"` : "RECENT ISSUED LOGS"}:\n\n${lines.join("\n\n")}`.slice(0, 4000),
      reply_markup: buildHubKeyboard(),
    }).catch(() => {});
  }

  async function sendScansList(chatId) {
    const rows = db
      .prepare(
        `SELECT serial_no, student_name, gr_number, doc_title, approved_by_name, COALESCE(security_code,'') AS security_code, COALESCE(last_print_code,'') AS last_print_code, scan_count, last_scanned_at
         FROM issued_logs
         WHERE scan_count > 0
         ORDER BY last_scanned_at DESC
         LIMIT 8`,
      )
      .all();
    if (!rows.length) {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "👁 No certificate QR codes have been scanned yet.",
        reply_markup: buildHubKeyboard(),
      }).catch(() => {});
      return;
    }
    const lines = rows.map(
      (r, i) =>
        `${i + 1}. ${r.serial_no} · ${r.student_name} (GR: ${r.gr_number})\n   ${r.doc_title}${r.security_code ? ` · Seal: ${r.security_code}` : ""}${r.last_print_code ? ` · 2FA: ${r.last_print_code}` : ""}\n   Scans: ${r.scan_count} · Last scan: ${formatIstDateTime(r.last_scanned_at)} · Approved by: ${r.approved_by_name || "School Office"}`,
    );
    await callApi("sendMessage", {
      chat_id: chatId,
      text: `👁 QR VERIFICATION SCANS:\n\n${lines.join("\n\n")}`.slice(0, 4000),
      reply_markup: buildHubKeyboard(),
    }).catch(() => {});
  }

  async function sendTeamList(chatId) {
    const roster = db
      .prepare("SELECT slot_number, name, role, is_top_teacher, is_active, telegram_chat_id FROM teachers ORDER BY is_top_teacher DESC, CASE WHEN slot_number > 0 THEN slot_number ELSE 99 END ASC, id ASC")
      .all();
    const lines = roster.length
      ? roster.map((r) => {
          const kind = r.is_top_teacher
            ? r.slot_number >= 1 && r.slot_number <= 3
              ? `Top ${r.slot_number}`
              : "Top Teacher"
            : "Staff";
          const state = r.is_active ? "Active" : "Paused";
          const tg = r.telegram_chat_id ? "TG Linked" : "Predefined";
          return `• ${r.name} [${kind} · ${r.role}] — ${state} · ${tg}`;
        })
      : ["No teachers configured yet."];
    await callApi("sendMessage", {
      chat_id: chatId,
      text: `👥 RJC Approval Team:\n${lines.join("\n")}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 Switch / Link", callback_data: "menu:switch" },
            { text: "➕ Predefine Teacher / Staff", callback_data: "menu:predefine" },
          ],
          [
            { text: "📋 Pending", callback_data: "hub:pending" },
            { text: "📊 Today", callback_data: "hub:today" },
          ],
        ],
      },
    }).catch(() => {});
  }

  async function handleSingleCommand({ chatId, senderId = "", raw, username, senderName, chatType, threadId = null }) {
    let cleanCmd = raw.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1").trim();
    if (!cleanCmd) return;

    if (!cleanCmd.startsWith("/") && pendingPrompt.has(chatId)) {
      const pending = pendingPrompt.get(chatId);
      pendingPrompt.delete(chatId);
      if (typeof pending === "string") {
        if (pending === "join") {
          const tokens = cleanCmd.split(/\s+/);
          if (tokens.length === 1 && isValidJoinCode(tokens[0])) {
            verifiedJoinChats.add(chatId);
            await sendRosterPicker(chatId);
            return;
          }
        }
        if (pending === "predefine_code") {
          if (!isValidJoinCode(cleanCmd)) {
            await callApi("sendMessage", {
              chat_id: chatId,
              text: "Invalid Staff Join Code. Check Admin → Teachers & Printing and try /predefine again.",
            }).catch(() => {});
            return;
          }
          verifiedJoinChats.add(chatId);
          await callApi("sendMessage", {
            chat_id: chatId,
            text: "Pick which Top Teacher slot or Staff position you want to predefine:",
            reply_markup: buildPredefinePositionKeyboard(),
          }).catch(() => {});
          return;
        }
        cleanCmd = `/${pending} ${cleanCmd}`;
      } else if (pending && typeof pending === "object") {
        if (pending.type === "join_name") {
          const targetSlot = Number(pending.slot || 0);
          const nameClean = cleanCmd.slice(0, 80);
          if (targetSlot >= 1 && targetSlot <= 4) {
            const actualSlot = targetSlot === 4 ? 0 : targetSlot;
            const slotRow =
              actualSlot >= 1
                ? db
                    .prepare("SELECT * FROM teachers WHERE is_top_teacher=1 AND slot_number=?")
                    .get(actualSlot)
                : null;
            const existingChat = db
              .prepare("SELECT * FROM teachers WHERE telegram_chat_id=?")
              .get(chatId);
            if (existingChat && (!slotRow || existingChat.id !== slotRow.id)) {
              db.prepare("UPDATE teachers SET telegram_chat_id='', telegram_username='' WHERE id=?").run(existingChat.id);
            }
            if (slotRow) {
              db.prepare(
                "UPDATE teachers SET name=?, telegram_chat_id=?, telegram_username=?, is_active=1, joined_via_bot=1 WHERE id=?",
              ).run(nameClean, chatId, username, slotRow.id);
            } else {
              db.prepare(
                `INSERT INTO teachers(slot_number, name, role, is_top_teacher, telegram_chat_id, telegram_username, is_active, joined_via_bot, created_at)
                 VALUES(?, ?, 'Top Teacher', 1, ?, ?, 1, 1, ?)`,
              ).run(actualSlot, nameClean, chatId, username, new Date().toISOString());
            }
            const linked = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
            await callApi("sendMessage", {
              chat_id: chatId,
              text: `✓ Linked as ${actualSlot ? `Top Teacher Slot ${actualSlot}` : "Top Teacher"}: ${nameClean}.\nPick a title/role or edit anytime below:`,
              reply_markup: buildMainMenuKeyboard(linked),
            }).catch(() => {});
            return;
          }
          const existingChat = db
            .prepare("SELECT * FROM teachers WHERE telegram_chat_id=?")
            .get(chatId);
          if (existingChat && existingChat.is_top_teacher === 0) {
            db.prepare("UPDATE teachers SET name=?, telegram_username=?, is_active=1 WHERE id=?").run(
              nameClean,
              username,
              existingChat.id,
            );
          } else {
            if (existingChat) {
              db.prepare("UPDATE teachers SET telegram_chat_id='', telegram_username='' WHERE id=?").run(existingChat.id);
            }
            db.prepare(
              `INSERT INTO teachers(slot_number, name, role, is_top_teacher, telegram_chat_id, telegram_username, is_active, joined_via_bot, created_at)
               VALUES(0, ?, 'Staff', 0, ?, ?, 1, 1, ?)`,
            ).run(nameClean, chatId, username, new Date().toISOString());
          }
          const linked = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
          await callApi("sendMessage", {
            chat_id: chatId,
            text: `✓ Joined as Staff: ${nameClean}.\nPick a title/role or manage your profile below:`,
            reply_markup: buildMainMenuKeyboard(linked),
          }).catch(() => {});
          return;
        }
        if (pending.type === "predefine_name") {
          const targetSlot = Number(pending.slot || 0);
          const nameClean = cleanCmd.slice(0, 100);
          let savedId;
          if (targetSlot >= 1 && targetSlot <= 3) {
            const existingSlot = db
              .prepare("SELECT * FROM teachers WHERE is_top_teacher=1 AND slot_number=?")
              .get(targetSlot);
            if (existingSlot) {
              db.prepare("UPDATE teachers SET name=?, is_active=1 WHERE id=?").run(nameClean, existingSlot.id);
              savedId = existingSlot.id;
            } else {
              const ins = db
                .prepare(
                  `INSERT INTO teachers(slot_number, name, role, is_top_teacher, is_active, created_at)
                   VALUES(?, ?, 'Top Teacher', 1, 1, ?)`,
                )
                .run(targetSlot, nameClean, new Date().toISOString());
              savedId = Number(ins.lastInsertRowid);
            }
          } else if (targetSlot === 4) {
            const ins = db
              .prepare(
                `INSERT INTO teachers(slot_number, name, role, is_top_teacher, is_active, created_at)
                 VALUES(0, ?, 'Top Teacher', 1, 1, ?)`,
              )
              .run(nameClean, new Date().toISOString());
            savedId = Number(ins.lastInsertRowid);
          } else {
            const ins = db
              .prepare(
                `INSERT INTO teachers(slot_number, name, role, is_top_teacher, is_active, created_at)
                 VALUES(0, ?, 'Staff', 0, 1, ?)`,
              )
              .run(nameClean, new Date().toISOString());
            savedId = Number(ins.lastInsertRowid);
          }
          await callApi("sendMessage", {
            chat_id: chatId,
            text: `✓ Predefined ${targetSlot >= 1 && targetSlot <= 3 ? `Top Teacher Slot ${targetSlot}` : targetSlot === 4 ? "Top Teacher" : "Staff"}: ${nameClean}.\nTap a predefined title for ${nameClean}:`,
            reply_markup: buildRolePickKeyboard(`pre_role:${savedId}`),
          }).catch(() => {});
          return;
        }
        if (pending.type === "predefine_custom_role") {
          const roleClean = cleanCmd.slice(0, 60);
          db.prepare("UPDATE teachers SET role=? WHERE id=?").run(roleClean, pending.teacherId);
          const row = db.prepare("SELECT * FROM teachers WHERE id=?").get(pending.teacherId);
          const me = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
          await callApi("sendMessage", {
            chat_id: chatId,
            text: `✓ Saved ${row ? row.name : "teacher"} with title: ${roleClean}.\nThey now appear in /join, Admin, and /teacher.`,
            reply_markup: buildMainMenuKeyboard(me),
          }).catch(() => {});
          return;
        }
      }
    } else if (cleanCmd.startsWith("/")) {
      pendingPrompt.delete(chatId);
    }

    if (/^\/cancel\b/i.test(cleanCmd)) {
      pendingPrompt.delete(chatId);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Cancelled. Send /start or /help anytime.",
      }).catch(() => {});
      return;
    }

    if (/^\/start\b|^\/help\b|^\/menu\b/i.test(cleanCmd)) {
      const existing = db
        .prepare("SELECT * FROM teachers WHERE telegram_chat_id=?")
        .get(senderId || chatId);
      if (existing) verifiedJoinChats.add(senderId || chatId);
      const commandsHelp = [
        "Information Hub & Logs:",
        "/pending — View & approve pending requests",
        "/today — Today's school certificate summary",
        "/logs [name or GR] — Search issued certificate logs",
        "/scans — Check QR verification scan history",
        "/team — View Top Teachers & Staff roster",
        "",
        "Teacher Account & Group Setup:",
        "/join — Tap-button menu for Top Teachers & Staff",
        "/predefine — Predefine Top Teachers (1–3) or Staff",
        "/role — Pick title/role from quick buttons",
        "/name — Change your display name",
        "/pin — Set 4–8 digit /teacher portal PIN",
        "/setgroup CODE — Link a Teachers Group or Channel Hub",
        "/settopic — Assign Group Topics (Pending, Approved, Scans)",
      ].join("\n");
      const intro = existing
        ? `Registered as: ${existing.name} (${existing.is_top_teacher ? `Top Teacher Slot ${existing.slot_number}` : "Staff"} · ${existing.role})${existing.is_active ? " · Active" : " · Paused"}.\nYour Chat ID: ${chatId}\n\nTap a button below or use commands:\n\n${commandsHelp}`
        : `Welcome to RJC School Approval Bot.\nYour Telegram Chat ID: ${chatId}\n\nTap "Join / Link Account" below (you'll enter the Staff Join Code once, then choose from buttons) or type:\n/join YOUR-CODE\n\n${commandsHelp}`;
      await callApi("sendMessage", {
        chat_id: chatId,
        text: intro,
        reply_markup: hasVerifiedAccess(chatId, senderId) ? buildMainMenuKeyboard(existing) : buildMainMenuKeyboard(null),
      }).catch(() => {});
      return;
    }

    if (/^\/(today|summary|hub)\b/i.test(cleanCmd)) {
      if (!hasVerifiedAccess(chatId, senderId)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Verification required. Send /join YOUR-CODE first (or link this group with /setgroup YOUR-CODE).",
        }).catch(() => {});
        return;
      }
      await sendHubOverview(chatId);
      return;
    }

    if (/^\/pending\b/i.test(cleanCmd)) {
      if (!hasVerifiedAccess(chatId, senderId)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Verification required. Send /join YOUR-CODE first (or link this group with /setgroup YOUR-CODE).",
        }).catch(() => {});
        return;
      }
      await sendPendingList(chatId);
      return;
    }

    const logsMatch = /^\/logs(?:\s+(.+))?$/i.exec(cleanCmd);
    if (logsMatch) {
      if (!hasVerifiedAccess(chatId, senderId)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Verification required. Send /join YOUR-CODE first (or link this group with /setgroup YOUR-CODE).",
        }).catch(() => {});
        return;
      }
      await sendLogsList(chatId, logsMatch[1] || "");
      return;
    }

    if (/^\/scans\b/i.test(cleanCmd)) {
      if (!hasVerifiedAccess(chatId, senderId)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Verification required. Send /join YOUR-CODE first (or link this group with /setgroup YOUR-CODE).",
        }).catch(() => {});
        return;
      }
      await sendScansList(chatId);
      return;
    }

    if (/^\/switch\b/i.test(cleanCmd)) {
      if (!hasVerifiedAccess(chatId, senderId)) {
        pendingPrompt.set(chatId, "join");
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Send your Staff Join Code (from Admin → Teachers & Printing) to open the Top Teacher / Staff picker:",
        }).catch(() => {});
        return;
      }
      await sendRosterPicker(chatId);
      return;
    }

    if (/^\/(?:predefine|add)\b/i.test(cleanCmd)) {
      const parts = cleanCmd.split(/\s+/);
      const maybeCode = parts[1];
      if (maybeCode && isValidJoinCode(maybeCode)) {
        verifiedJoinChats.add(chatId);
      }
      if (!hasVerifiedAccess(chatId, senderId)) {
        pendingPrompt.set(chatId, "predefine_code");
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Enter your Staff Join Code (from Admin → Teachers & Printing) to predefine Top Teachers or Staff:",
        }).catch(() => {});
        return;
      }
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Pick which Top Teacher slot or Staff position you want to predefine:",
        reply_markup: buildPredefinePositionKeyboard(),
      }).catch(() => {});
      return;
    }

    async function replyWithGroupGuide(targetChatId, cmdWord = "/setchannel") {
      const codeHint = String(settings()?.staff_join_code || "YOUR-CODE").trim();
      const candidates = [...recentDiscoveredChats.values()].slice(-4).reverse();
      const kbRows = candidates.map((c) => [
        {
          text: `🔗 Link ${c.type === "channel" ? "Channel" : "Group"}: ${c.title || c.chatId}`,
          callback_data: `link_hub:${c.chatId}`,
        },
      ]);
      const lines = [
        `To link a Telegram Group or Channel, send ${cmdWord} ${codeHint} **inside that Group or Channel** (not in this private chat).`,
        ``,
        `How to link your Channel or Group in 3 steps:`,
        `1. Open your Group or Channel (e.g. RJC).`,
        `2. For a Channel: open Info → Administrators → Add Admin → search this bot and keep "Post Messages" ON.`,
        `3. Send ${cmdWord} ${codeHint} inside that Group/Channel — OR simply forward any post from that Channel to me here!`,
      ];
      await callApi("sendMessage", {
        chat_id: targetChatId,
        text: lines.join("\n"),
        ...(kbRows.length ? { reply_markup: { inline_keyboard: kbRows } } : {}),
      }).catch((e) => console.error("Telegram group guide error:", e?.message || e));
    }

    if (/^\/(setstorage|setgroup|setchannel)$/i.test(cleanCmd)) {
      const cmdName = cleanCmd.toLowerCase();
      if (chatType === "private" && (cmdName === "/setgroup" || cmdName === "/setchannel")) {
        await replyWithGroupGuide(chatId, cmdName);
        return;
      }
      if (senderId && hasVerifiedAccess(senderId)) {
        db.prepare("UPDATE school_settings SET telegram_storage_chat_id=? WHERE id=1").run(chatId);
        await callApi("sendMessage", {
          chat_id: chatId,
          text: `✓ This chat/group (${chatId}) is now linked as the RJC Teachers Hub & Archive Storage.\nAll parent requests, approve buttons, approved PDFs, QR scan alerts, and /pending /today /logs /scans work here.`,
          reply_markup: buildHubKeyboard(),
        }).catch((e) => console.error("Telegram hub confirm error:", e?.message || e));
        return;
      }
      pendingPrompt.set(chatId, "setstorage");
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Reply with your Staff Join Code (from Admin → Teachers & Printing) to link this group/channel as Teachers Hub & Archive, or send /setgroup YOUR-CODE.",
      }).catch((e) => console.error("Telegram setstorage prompt error:", e?.message || e));
      return;
    }
    if (/^\/(clearstorage|cleargroup)$/i.test(cleanCmd)) {
      pendingPrompt.set(chatId, "clearstorage");
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Reply with your Staff Join Code to clear the linked Teachers Group / Archive, or send /cleargroup YOUR-CODE.",
      }).catch(() => {});
      return;
    }

    const storageMatch = /^\/(setstorage|setgroup|setchannel|clearstorage|cleargroup)\s+(\S+)$/i.exec(cleanCmd);
    if (storageMatch) {
      const action = storageMatch[1].toLowerCase();
      const code = storageMatch[2].trim();
      if (!isValidJoinCode(code)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Invalid code. Check the exact Staff Join Code inside Admin → Teachers & Printing.",
        }).catch((e) => console.error("Telegram invalid code reply error:", e?.message || e));
        return;
      }
      verifiedJoinChats.add(chatId);
      if (action === "clearstorage" || action === "cleargroup") {
        db.prepare("UPDATE school_settings SET telegram_storage_chat_id='' WHERE id=1").run();
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Teachers group / archive storage chat cleared.",
        }).catch(() => {});
        return;
      }
      if (chatType === "private" && (action === "setgroup" || action === "setchannel")) {
        if (senderId) verifiedJoinChats.add(senderId);
        await replyWithGroupGuide(chatId, `/${action}`);
        return;
      }
      db.prepare("UPDATE school_settings SET telegram_storage_chat_id=? WHERE id=1").run(chatId);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ This chat (${chatId}) is now saved as the RJC Teachers Hub & Archive Storage.\nParent requests (with Approve/Reject buttons), uploaded applications, signed Verification QR proofs, and live QR scan alerts will post here.\nTip: If Topics are enabled on this Group, open any Topic and send /settopic to route subfolders separately.`,
        reply_markup: buildHubKeyboard(),
      }).catch((e) => console.error("Telegram hub linked reply error:", e?.message || e));
      return;
    }

    const topicCmd = /^\/settopic(?:\s+(pending|approved|scans|clear)(?:\s+(\S+))?)?$/i.exec(cleanCmd);
    if (topicCmd) {
      const topicKind = (topicCmd[1] || "").toLowerCase();
      const maybeCode = topicCmd[2] || "";
      if (maybeCode && !isValidJoinCode(maybeCode)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          text: "Invalid Staff Join Code. Check Admin → Teachers & Printing.",
        }).catch(() => {});
        return;
      }
      if (!hasVerifiedAccess(chatId, senderId) && !(maybeCode && isValidJoinCode(maybeCode))) {
        await callApi("sendMessage", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          text: "Verification required. Send /settopic pending YOUR-STAFF-CODE inside the group topic.",
        }).catch(() => {});
        return;
      }
      if (chatType === "private") {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Open a Telegram Supergroup with Topics enabled, go inside the specific Topic (e.g. Pending Requests, Approved Archive, or QR Scans), and send /settopic there.",
        }).catch(() => {});
        return;
      }
      if (!topicKind) {
        const tid = Number(threadId || 0);
        await callApi("sendMessage", {
          chat_id: chatId,
          ...(tid > 1 ? { message_thread_id: tid } : {}),
          text: tid > 1
            ? `Tap which folder/stream should post into THIS Topic (#${tid}):`
            : "This looks like the main/General chat (Topic ID not set). Open a named Topic in this group and send /settopic, or reset topics:",
          reply_markup: {
            inline_keyboard: tid > 1
              ? [
                  [{ text: "📋 Post Pending Requests here", callback_data: `set_topic:pending:${tid}` }],
                  [{ text: "✓ Post Approved & QR Proof here", callback_data: `set_topic:approved:${tid}` }],
                  [{ text: "🔍 Post Live QR Scans here", callback_data: `set_topic:scans:${tid}` }],
                  [{ text: "♻ Reset all topic folders", callback_data: "set_topic:clear:0" }],
                ]
              : [[{ text: "♻ Reset all topic folders", callback_data: "set_topic:clear:0" }]],
          },
        }).catch(() => {});
        return;
      }
      if (topicKind === "clear") {
        db.prepare(
          "UPDATE school_settings SET telegram_topic_pending='', telegram_topic_approved='', telegram_topic_scans='' WHERE id=1",
        ).run();
        await callApi("sendMessage", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          text: "✓ Topic subfolders cleared. All alerts will post in the main Teachers Group chat.",
        }).catch(() => {});
        return;
      }
      if (!threadId || Number(threadId) <= 1) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: `Send /settopic ${topicKind} inside a specific named Topic inside your Supergroup (enable Topics in Group Info → Edit → Topics).`,
        }).catch(() => {});
        return;
      }
      db.prepare("UPDATE school_settings SET telegram_storage_chat_id=? WHERE id=1").run(chatId);
      const col =
        topicKind === "pending"
          ? "telegram_topic_pending"
          : topicKind === "approved"
            ? "telegram_topic_approved"
            : "telegram_topic_scans";
      db.prepare(`UPDATE school_settings SET ${col}=? WHERE id=1`).run(String(threadId));
      await callApi("sendMessage", {
        chat_id: chatId,
        message_thread_id: Number(threadId),
        text: `✓ Linked Topic #${threadId} in group (${chatId}) for "${topicKind.toUpperCase()}" updates.`,
      }).catch(() => {});
      return;
    }

    if (/^\/join$/i.test(cleanCmd)) {
      if (hasVerifiedAccess(chatId)) {
        await sendRosterPicker(chatId);
        return;
      }
      pendingPrompt.set(chatId, "join");
      await callApi("sendMessage", {
        chat_id: chatId,
        text: [
          "Reply with your Staff Join Code (from Admin → Teachers & Printing) to open the quick Top Teacher / Staff button selector:",
          "",
          "Or send directly in one line:",
          "YOUR-CODE Your Full Name",
        ].join("\n"),
      }).catch(() => {});
      return;
    }

    const joinCodeOnlyMatch = /^\/join\s+(\S+)$/i.exec(cleanCmd);
    if (joinCodeOnlyMatch && !/^slot[123]$/i.test(joinCodeOnlyMatch[1])) {
      const code = joinCodeOnlyMatch[1].trim();
      if (!isValidJoinCode(code)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Invalid Staff Join Code. Check the exact code shown in Admin → Teachers & Printing → Staff Join Code and try again.",
        }).catch(() => {});
        return;
      }
      verifiedJoinChats.add(chatId);
      await sendRosterPicker(chatId);
      return;
    }

    const joinMatch = /^\/join\s+(\S+)(?:\s+(slot[123]))?(?:\s+(.+))?$/i.exec(cleanCmd);
    if (joinMatch) {
      const code = joinMatch[1].trim();
      const slotToken = (joinMatch[2] || "").toLowerCase();
      const requestedSlot = slotToken ? Number(slotToken.replace("slot", "")) : 0;
      const suppliedName = String(joinMatch[3] || senderName || "School Staff")
        .trim()
        .slice(0, 80);
      if (!isValidJoinCode(code)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Invalid Staff Join Code. Check the exact code shown in Admin → Teachers & Printing → Staff Join Code (e.g. RJC-xxxxxx) and try again.",
        }).catch(() => {});
        return;
      }
      verifiedJoinChats.add(chatId);

      if (requestedSlot >= 1 && requestedSlot <= 3) {
        const slotRow = db
          .prepare("SELECT * FROM teachers WHERE is_top_teacher=1 AND slot_number=?")
          .get(requestedSlot);
        const existingChat = db
          .prepare("SELECT * FROM teachers WHERE telegram_chat_id=?")
          .get(chatId);
        if (existingChat && (!slotRow || existingChat.id !== slotRow.id)) {
          db.prepare("UPDATE teachers SET telegram_chat_id='', telegram_username='' WHERE id=?").run(existingChat.id);
        }
        if (slotRow) {
          db.prepare(
            "UPDATE teachers SET name=?, telegram_chat_id=?, telegram_username=?, is_active=1, joined_via_bot=1 WHERE id=?",
          ).run(suppliedName || slotRow.name, chatId, username, slotRow.id);
        } else {
          db.prepare(
            `INSERT INTO teachers(slot_number, name, role, is_top_teacher, telegram_chat_id, telegram_username, is_active, joined_via_bot, created_at)
             VALUES(?, ?, 'Top Teacher', 1, ?, ?, 1, 1, ?)`,
          ).run(requestedSlot, suppliedName, chatId, username, new Date().toISOString());
        }
        const linked = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
        await callApi("sendMessage", {
          chat_id: chatId,
          text: `✓ Linked this Telegram chat as Top Teacher Slot ${requestedSlot}: ${suppliedName}.\nEdit anytime with buttons below or /name, /role:`,
          reply_markup: buildMainMenuKeyboard(linked),
        }).catch(() => {});
        return;
      }

      const existing = db
        .prepare("SELECT * FROM teachers WHERE telegram_chat_id=?")
        .get(chatId);
      if (existing && existing.is_top_teacher === 0) {
        db.prepare(
          "UPDATE teachers SET name=?, telegram_username=?, is_active=1 WHERE id=?",
        ).run(suppliedName || existing.name, username, existing.id);
      } else {
        if (existing) {
          db.prepare("UPDATE teachers SET telegram_chat_id='', telegram_username='' WHERE id=?").run(existing.id);
        }
        db.prepare(
          `INSERT INTO teachers(slot_number, name, role, is_top_teacher, telegram_chat_id, telegram_username, is_active, joined_via_bot, created_at)
           VALUES(0, ?, 'Staff', 0, ?, ?, 1, 1, ?)`,
        ).run(suppliedName, chatId, username, new Date().toISOString());
      }
      const linked = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ Joined RJC Approval Bot as ${suppliedName} (Staff).\nYou will receive parent requests and can approve printing from Telegram.\nTip: edit anytime using buttons below:`,
        reply_markup: buildMainMenuKeyboard(linked),
      }).catch(() => {});
      return;
    }

    const teacher = db
      .prepare("SELECT * FROM teachers WHERE telegram_chat_id=?")
      .get(chatId);

    if (/^\/(?:name|rename)$/i.test(cleanCmd)) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. Send /join first.",
        }).catch(() => {});
        return;
      }
      pendingPrompt.set(chatId, "name");
      const rows = senderName
        ? [[{ text: `Use Telegram name: ${senderName}`, callback_data: "use_tg_name" }]]
        : [];
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `Current name: ${teacher.name}\nReply with your new full name (or /cancel):`,
        ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
      }).catch(() => {});
      return;
    }

    const renameMatch = /^\/(?:name|rename)\s+(.+)$/i.exec(cleanCmd);
    if (renameMatch) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. First send /join YOUR-CODE Your Name",
        }).catch(() => {});
        return;
      }
      const nextName = renameMatch[1].trim().slice(0, 100);
      db.prepare("UPDATE teachers SET name=? WHERE id=?").run(nextName, teacher.id);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ Display name updated to: ${nextName}`,
      }).catch(() => {});
      return;
    }

    if (/^\/role$/i.test(cleanCmd)) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. Send /join first.",
        }).catch(() => {});
        return;
      }
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `Current title: ${teacher.role}\nTap a predefined title below or choose Custom:`,
        reply_markup: buildRolePickKeyboard("set_role"),
      }).catch(() => {});
      return;
    }

    const roleMatch = /^\/role\s+(.+)$/i.exec(cleanCmd);
    if (roleMatch) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. First send /join YOUR-CODE Your Name",
        }).catch(() => {});
        return;
      }
      const nextRole = roleMatch[1].trim().slice(0, 60);
      db.prepare("UPDATE teachers SET role=? WHERE id=?").run(nextRole, teacher.id);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ Title / role updated to: ${nextRole}`,
      }).catch(() => {});
      return;
    }

    if (/^\/pin$/i.test(cleanCmd)) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. Send /join first.",
        }).catch(() => {});
        return;
      }
      pendingPrompt.set(chatId, "pin");
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Reply with a 4–8 digit PIN for /teacher portal sign-in (example: 4521):",
      }).catch(() => {});
      return;
    }

    const pinMatch = /^\/pin\s+(.+)$/i.exec(cleanCmd);
    if (pinMatch) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. First send /join YOUR-CODE Your Name",
        }).catch(() => {});
        return;
      }
      const nextPin = pinMatch[1].trim();
      if (!/^\d{4,8}$/.test(nextPin) || typeof hashPassword !== "function") {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "PIN must be 4 to 8 digits (example: /pin 4521).",
        }).catch(() => {});
        return;
      }
      db.prepare("UPDATE teachers SET pin_hash=? WHERE id=?").run(hashPassword(nextPin), teacher.id);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "✓ Web portal PIN updated for /teacher login.",
      }).catch(() => {});
      return;
    }

    if (/^\/(pause|resume)\b/i.test(cleanCmd)) {
      if (!teacher) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. Send /join YOUR-CODE Your Name",
        }).catch(() => {});
        return;
      }
      const nextActive = cleanCmd.toLowerCase().startsWith("/resume") ? 1 : 0;
      db.prepare("UPDATE teachers SET is_active=? WHERE id=?").run(nextActive, teacher.id);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: nextActive
          ? "✓ Telegram alerts resumed for your account."
          : "⏸ Telegram alerts paused. Send /resume anytime to receive requests again.",
      }).catch(() => {});
      return;
    }

    if (/^\/team\b/i.test(cleanCmd)) {
      if (!hasVerifiedAccess(chatId, senderId)) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Not registered yet. Send /join first.",
        }).catch(() => {});
        return;
      }
      await sendTeamList(chatId);
      return;
    }

    if (cleanCmd.startsWith("/")) {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Command not recognized or incomplete. Send /start for the button menu or /help.",
      }).catch(() => {});
    } else if (chatType === "private") {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: "Send /start to open the quick button menu, or /help for commands.",
      }).catch(() => {});
    }
  }

  async function handleTextCommand(message) {
    const chatId = String(message?.chat?.id || "").trim();
    const chatType = String(message?.chat?.type || "").trim();
    const raw = String(message?.text || message?.caption || "").trim();
    const senderId = String(message?.from?.id || "").trim();
    const username = String(message?.from?.username || "").trim();
    const senderName = (
      [message?.from?.first_name, message?.from?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      String(message?.author_signature || message?.chat?.title || "").trim()
    );
    if (!chatId) return;

    // Remember group/channel whenever any message arrives from it
    if (chatType === "group" || chatType === "supergroup" || chatType === "channel") {
      recentDiscoveredChats.set(chatId, {
        chatId,
        title: String(message?.chat?.title || chatId),
        type: chatType,
        updatedAt: Date.now(),
      });
    }

    // Detect forwarded channel/group messages in private chat for 1-tap linking
    const fwdChat = message?.forward_origin?.chat || message?.forward_from_chat;
    if (chatType === "private" && fwdChat && (fwdChat.type === "channel" || fwdChat.type === "group" || fwdChat.type === "supergroup")) {
      const fId = String(fwdChat.id);
      const fTitle = String(fwdChat.title || fId);
      recentDiscoveredChats.set(fId, {
        chatId: fId,
        title: fTitle,
        type: fwdChat.type,
        updatedAt: Date.now(),
      });
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `Detected ${fwdChat.type === "channel" ? "Channel" : "Group"}: "${fTitle}" (${fId}).\nMake sure I am an Administrator there (with "Post Messages" ON for Channels), then tap below to link it:`,
        reply_markup: {
          inline_keyboard: [
            [{ text: `🔗 Link "${fTitle}" as Teachers Hub`, callback_data: `link_hub:${fId}` }],
          ],
        },
      }).catch((e) => console.error("Telegram forward detect reply error:", e?.message || e));
      return;
    }

    if (!raw) return;

    const threadId = message?.message_thread_id ? Number(message.message_thread_id) : null;
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length > 1 && lines.every((l) => l.startsWith("/"))) {
      for (const line of lines) {
        await handleSingleCommand({ chatId, senderId, raw: line, username, senderName, chatType, threadId });
      }
      return;
    }
    await handleSingleCommand({ chatId, senderId, raw, username, senderName, chatType, threadId });
  }

  async function handleMyChatMember(memberUpdate) {
    const chat = memberUpdate?.chat;
    const chatId = String(chat?.id || "").trim();
    const chatType = String(chat?.type || "").trim();
    const status = String(memberUpdate?.new_chat_member?.status || "").trim();
    const actorId = String(memberUpdate?.from?.id || "").trim();
    if (!chatId || (chatType !== "group" && chatType !== "supergroup" && chatType !== "channel")) return;

    if (status === "left" || status === "kicked") {
      recentDiscoveredChats.delete(chatId);
      return;
    }

    const title = String(chat?.title || chatId);
    const canPost =
      chatType !== "channel" || memberUpdate?.new_chat_member?.can_post_messages !== false;
    recentDiscoveredChats.set(chatId, {
      chatId,
      title,
      type: chatType,
      status,
      canPost,
      updatedAt: Date.now(),
    });

    if (actorId) {
      const hint =
        chatType === "channel" && !canPost
          ? `Added to Channel "${title}", but "Post Messages" Admin permission is OFF. Turn it ON in Channel Info → Administrators, then tap Link:`
          : `I was added to ${chatType === "channel" ? "Channel" : "Group"} "${title}" (${chatId}).\nTap below to make it the RJC Teachers Hub & Archive:`;
      await callApi("sendMessage", {
        chat_id: actorId,
        text: hint,
        reply_markup: {
          inline_keyboard: [
            [{ text: `🔗 Link "${title}" as Teachers Hub`, callback_data: `link_hub:${chatId}` }],
          ],
        },
      }).catch(() => {});
    }
  }

  function findCallbackTeacher(actorId, msgChatId, username) {
    for (const id of [actorId, msgChatId]) {
      if (!id) continue;
      const t = db
        .prepare("SELECT * FROM teachers WHERE telegram_chat_id=? AND is_active=1")
        .get(id);
      if (t) return t;
    }
    if (username) {
      const cleanUser = username.replace(/^@/, "").toLowerCase();
      const t = db
        .prepare("SELECT * FROM teachers WHERE LOWER(REPLACE(telegram_username,'@',''))=? AND is_active=1")
        .get(cleanUser);
      if (t) return t;
    }
    return null;
  }

  async function handleCallbackQuery(cb) {
    const id = cb?.id;
    const msgChatId = String(cb?.message?.chat?.id || cb?.from?.id || "").trim();
    const actorId = String(cb?.from?.id || "").trim();
    const chatType = String(cb?.message?.chat?.type || "").trim();
    const personalChatId = chatType === "private" || !actorId ? msgChatId : actorId;
    const chatId = msgChatId;
    const username = String(cb?.from?.username || "").trim();
    const senderName = [cb?.from?.first_name, cb?.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const data = String(cb?.data || "");

    const ack = async (text = "", showAlert = false) => {
      if (!id) return;
      await callApi("answerCallbackQuery", {
        callback_query_id: id,
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      }).catch(() => {});
    };

    if (data.startsWith("link_hub:")) {
      const targetId = data.slice("link_hub:".length).trim();
      if (!targetId) {
        await ack("Missing group/channel ID.", true);
        return;
      }
      if (!hasVerifiedAccess(actorId, msgChatId)) {
        pendingPrompt.set(personalChatId, "join");
        await ack("Enter your Staff Join Code first via /join.", true);
        await callApi("sendMessage", {
          chat_id: personalChatId,
          text: `First send your Staff Join Code (from Admin → Teachers & Printing), then tap the Link button again (or send /setchannel YOUR-CODE inside the channel).`,
        }).catch(() => {});
        return;
      }
      const meta = recentDiscoveredChats.get(targetId);
      const label = meta ? `${meta.title} (${targetId})` : targetId;
      try {
        await callApi("sendMessage", {
          chat_id: targetId,
          text: `✓ ${label} is now linked as the RJC Teachers Hub & Archive Storage.\nParent requests (with Approve/Reject buttons), approved PDFs, and live QR scan alerts will post here.`,
          reply_markup: buildHubKeyboard(),
        });
        db.prepare("UPDATE school_settings SET telegram_storage_chat_id=? WHERE id=1").run(targetId);
        await ack(`Linked ${meta?.title || targetId}!`);
        if (personalChatId && personalChatId !== targetId) {
          await callApi("sendMessage", {
            chat_id: personalChatId,
            text: `✓ Successfully linked "${meta?.title || targetId}" as the RJC Teachers Hub & Archive Storage!`,
            reply_markup: buildHubKeyboard(),
          }).catch(() => {});
        }
      } catch (e) {
        await ack("Bot cannot post in that channel/group yet.", true);
        await callApi("sendMessage", {
          chat_id: personalChatId || msgChatId,
          text: `Could not post to ${label}: ${e?.message || "Missing permissions"}.\n\nOpen that Group/Channel → Info → Administrators → select this bot → enable "Post Messages", then tap Link again.`,
        }).catch(() => {});
      }
      return;
    }

    if (data.startsWith("set_topic:")) {
      const parts = data.split(":");
      const topicKind = parts[1] || "";
      const tid = Number(parts[2] || 0);
      if (!hasVerifiedAccess(actorId, msgChatId)) {
        await ack("Join via /join first to configure topics.", true);
        return;
      }
      if (topicKind === "clear") {
        db.prepare(
          "UPDATE school_settings SET telegram_topic_pending='', telegram_topic_approved='', telegram_topic_scans='' WHERE id=1",
        ).run();
        await ack("Cleared all topic links.");
        await callApi("sendMessage", {
          chat_id: msgChatId,
          text: "✓ Topic subfolders cleared. Alerts post to the main Teachers Hub.",
        }).catch(() => {});
        return;
      }
      if (!["pending", "approved", "scans"].includes(topicKind) || tid <= 1) {
        await ack("Open a named group Topic first.", true);
        return;
      }
      db.prepare("UPDATE school_settings SET telegram_storage_chat_id=? WHERE id=1").run(msgChatId);
      const col =
        topicKind === "pending"
          ? "telegram_topic_pending"
          : topicKind === "approved"
            ? "telegram_topic_approved"
            : "telegram_topic_scans";
      db.prepare(`UPDATE school_settings SET ${col}=? WHERE id=1`).run(String(tid));
      await ack(`Linked Topic #${tid} (${topicKind})`);
      await callApi("sendMessage", {
        chat_id: msgChatId,
        message_thread_id: tid,
        text: `✓ Topic #${tid} is now set to receive "${topicKind.toUpperCase()}" updates.`,
      }).catch(() => {});
      return;
    }

    if (data.startsWith("hub:")) {
      const sub = data.slice(4);
      if (!hasVerifiedAccess(msgChatId, actorId)) {
        await ack("Link your teacher account via /join first.", true);
        return;
      }
      await ack();
      if (sub === "pending") await sendPendingList(msgChatId);
      else if (sub === "today") await sendHubOverview(msgChatId);
      else if (sub === "logs") await sendLogsList(msgChatId, "");
      else if (sub === "scans") await sendScansList(msgChatId);
      else if (sub === "team") await sendTeamList(msgChatId);
      else if (sub === "menu") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: "/start", username, senderName, chatType: "private" });
      }
      return;
    }

    if (data.startsWith("menu:")) {
      const sub = data.slice(5);
      await ack();
      if (sub === "team") {
        await sendTeamList(msgChatId);
      } else if (sub === "join" || sub === "switch") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: "/switch", username, senderName, chatType: "private" });
      } else if (sub === "predefine") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: "/predefine", username, senderName, chatType: "private" });
      } else if (sub === "role") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: "/role", username, senderName, chatType: "private" });
      } else if (sub === "name") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: "/name", username, senderName, chatType: "private" });
      } else if (sub === "pin") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: "/pin", username, senderName, chatType: "private" });
      } else if (sub === "pause" || sub === "resume") {
        await handleSingleCommand({ chatId: personalChatId, senderId: actorId, raw: `/${sub}`, username, senderName, chatType: "private" });
      }
      return;
    }

    if (data.startsWith("claim_teacher:")) {
      if (!hasVerifiedAccess(chatId)) {
        await ack("Enter Staff Join Code first via /join.", true);
        return;
      }
      const targetId = Number(data.split(":")[1] || 0);
      const target = db.prepare("SELECT * FROM teachers WHERE id=?").get(targetId);
      if (!target) {
        await ack("Teacher record no longer exists.", true);
        return;
      }
      const prev = db.prepare("SELECT id FROM teachers WHERE telegram_chat_id=?").get(chatId);
      if (prev && prev.id !== target.id) {
        db.prepare("UPDATE teachers SET telegram_chat_id='', telegram_username='' WHERE id=?").run(prev.id);
      }
      db.prepare(
        "UPDATE teachers SET telegram_chat_id=?, telegram_username=?, is_active=1, joined_via_bot=1 WHERE id=?",
      ).run(chatId, username, target.id);
      const linked = db.prepare("SELECT * FROM teachers WHERE id=?").get(target.id);
      await ack(`Linked as ${linked.name}`);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ Linked this Telegram phone as ${linked.name} (${linked.is_top_teacher ? (linked.slot_number ? `Top Teacher Slot ${linked.slot_number}` : "Top Teacher") : "Staff"} · ${linked.role}).`,
        reply_markup: buildMainMenuKeyboard(linked),
      }).catch(() => {});
      return;
    }

    if (data.startsWith("pick_slot:")) {
      if (!hasVerifiedAccess(chatId)) {
        await ack("Enter Staff Join Code first via /join.", true);
        return;
      }
      const slot = Number(data.split(":")[1] || 0);
      pendingPrompt.set(chatId, { type: "join_name", slot });
      await ack();
      const rows = senderName
        ? [[{ text: `Use my Telegram name: ${senderName}`, callback_data: "use_tg_name" }]]
        : [];
      await callApi("sendMessage", {
        chat_id: chatId,
        text:
          slot >= 1 && slot <= 3
            ? `Reply with the Full Name for Top Teacher Slot ${slot} (or tap below):`
            : slot === 4
              ? "Reply with your Full Name to join as an Additional Top Teacher (or tap below):"
              : "Reply with your Full Name to join as Staff (or tap below):",
        ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
      }).catch(() => {});
      return;
    }

    if (data === "use_tg_name") {
      await ack();
      if (!senderName) return;
      await handleSingleCommand({
        chatId,
        raw: senderName,
        username,
        senderName,
        chatType: "private",
      });
      return;
    }

    if (data.startsWith("set_role:")) {
      const roleVal = data.slice("set_role:".length);
      const teacher = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
      if (!teacher) {
        await ack("Join first via /join.", true);
        return;
      }
      if (roleVal === "__custom__") {
        pendingPrompt.set(chatId, "role");
        await ack();
        await callApi("sendMessage", {
          chat_id: chatId,
          text: `Current title: ${teacher.role}\nReply with your custom title/role (or /cancel):`,
        }).catch(() => {});
        return;
      }
      const cleanRole = roleVal.trim().slice(0, 60);
      db.prepare("UPDATE teachers SET role=? WHERE id=?").run(cleanRole, teacher.id);
      const updated = db.prepare("SELECT * FROM teachers WHERE id=?").get(teacher.id);
      await ack(`Title: ${cleanRole}`);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ Title / role updated to: ${cleanRole}`,
        reply_markup: buildMainMenuKeyboard(updated),
      }).catch(() => {});
      return;
    }

    if (data.startsWith("predefine_pos:")) {
      if (!hasVerifiedAccess(chatId)) {
        await ack("Verify Staff Join Code first via /predefine.", true);
        return;
      }
      const slot = Number(data.split(":")[1] || 0);
      pendingPrompt.set(chatId, { type: "predefine_name", slot });
      await ack();
      await callApi("sendMessage", {
        chat_id: chatId,
        text:
          slot >= 1 && slot <= 3
            ? `Reply with the Full Name for Top Teacher Slot ${slot} (e.g. Sunita Joshi):`
            : slot === 4
              ? "Reply with the Full Name for the new Additional Top Teacher:"
              : "Reply with the Full Name for the new predefined Staff member:",
      }).catch(() => {});
      return;
    }

    if (data.startsWith("pre_role:")) {
      const parts = data.split(":");
      const targetId = Number(parts[1] || 0);
      const roleVal = parts.slice(2).join(":");
      if (!targetId) {
        await ack("Teacher record missing.", true);
        return;
      }
      if (roleVal === "__custom__") {
        pendingPrompt.set(chatId, { type: "predefine_custom_role", teacherId: targetId });
        await ack();
        await callApi("sendMessage", {
          chat_id: chatId,
          text: "Reply with the custom title/role for this predefined teacher or staff member:",
        }).catch(() => {});
        return;
      }
      const cleanRole = roleVal.trim().slice(0, 60);
      db.prepare("UPDATE teachers SET role=? WHERE id=?").run(cleanRole, targetId);
      const target = db.prepare("SELECT * FROM teachers WHERE id=?").get(targetId);
      const me = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id=?").get(chatId);
      await ack(`Saved: ${cleanRole}`);
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `✓ Saved ${target ? target.name : "teacher"} (${target?.is_top_teacher ? (target.slot_number ? `Top Teacher Slot ${target.slot_number}` : "Top Teacher") : "Staff"} · ${cleanRole}).\nThey are now listed in /join buttons, Admin, and /teacher.`,
        reply_markup: buildMainMenuKeyboard(me),
      }).catch(() => {});
      return;
    }

    const m = /^(approve|reject):([A-Za-z0-9_-]+)$/.exec(data);
    if (!m) {
      await ack();
      return;
    }

    const teacher = findCallbackTeacher(actorId, msgChatId, username);
    if (!teacher) {
      await ack(
        "Link your teacher account first: message the bot privately with /join YOUR-CODE so approvals record your name.",
        true,
      );
      return;
    }

    const [, action, requestId] = m;
    if (action === "approve") {
      const res = approvalService.approveRequest({
        requestId,
        teacher,
        channel: "telegram",
      });
      if (res.notFound) {
        await ack("Request not found.", true);
        return;
      }
      if (res.forbiddenTopOnly) {
        await ack("Only Top Teachers (Slot 1–3) can approve this sensitive document.", true);
        return;
      }
      if (res.alreadyHandled) {
        await ack(`Already ${res.request.status.toLowerCase()} by ${res.request.reviewed_by_name}.`, true);
        await syncReviewedMessages(res.request);
        return;
      }
      await ack(
        res.request.print_status === "HOLD_STAFF"
          ? `Approved by ${teacher.name}. Staff can now confirm & print at counter.`
          : `Approved by ${teacher.name}. Printing at school counter.`,
      );
      await syncReviewedMessages(res.request);
      Promise.resolve(onApproved(res)).catch(() => {});
      return;
    }

    const res = approvalService.rejectRequest({
      requestId,
      teacher,
      channel: "telegram",
      reason: "Declined via Telegram",
    });
    if (res.notFound) {
      await ack("Request not found.", true);
      return;
    }
    if (res.alreadyHandled) {
      await ack(`Already ${res.request.status.toLowerCase()} by ${res.request.reviewed_by_name}.`, true);
      await syncReviewedMessages(res.request);
      return;
    }
    await ack(`Declined by ${teacher.name}.`);
    await syncReviewedMessages(res.request);
  }

  async function processUpdates(updates) {
    let maxOffset = Number(settings()?.telegram_update_offset || 0);
    for (const u of updates || []) {
      if (typeof u.update_id === "number" && u.update_id >= maxOffset) {
        maxOffset = u.update_id + 1;
      }
      if (u.callback_query) await handleCallbackQuery(u.callback_query);
      else if (u.my_chat_member) await handleMyChatMember(u.my_chat_member);
      else if (u.message) await handleTextCommand(u.message);
      else if (u.channel_post) await handleTextCommand(u.channel_post);
    }
    if (maxOffset > Number(settings()?.telegram_update_offset || 0)) {
      db.prepare("UPDATE school_settings SET telegram_update_offset=? WHERE id=1").run(
        maxOffset,
      );
    }
  }

  async function syncBotCommands() {
    const token = getBotToken();
    if (!token) return false;
    await callApi("setMyCommands", {
      commands: [
        { command: "start", description: "Open quick button menu & status" },
        { command: "pending", description: "View & approve pending requests" },
        { command: "today", description: "Today's summary, prints & QR scans" },
        { command: "logs", description: "Search issued certificate logs" },
        { command: "scans", description: "View QR verification scan alerts" },
        { command: "team", description: "View Top Teachers & Staff roster" },
        { command: "join", description: "Pick Top Teacher slot or Staff (buttons)" },
        { command: "predefine", description: "Predefine / add a teacher or staff" },
        { command: "role", description: "Pick title/role from buttons" },
        { command: "name", description: "Change display name" },
        { command: "pin", description: "Set /teacher web PIN" },
        { command: "setgroup", description: "Link Teachers Group or Channel Hub" },
        { command: "settopic", description: "Assign Group Topics (Pending/Approved/Scans)" },
        { command: "pause", description: "Pause Telegram alerts" },
        { command: "resume", description: "Resume Telegram alerts" },
        { command: "help", description: "Show all commands" },
      ],
    }).catch(() => {});
    commandsSyncedForToken = token;
    return true;
  }

  async function pollOnce() {
    if (polling || stopped) return;
    const token = getBotToken();
    if (!token) return;
    polling = true;
    try {
      if (commandsSyncedForToken !== token) {
        await syncBotCommands();
      }
      const offset = Number(settings()?.telegram_update_offset || 0);
      const url = `https://api.telegram.org/bot${token}/getUpdates`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: 15,
          allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member"],
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok && Array.isArray(data.result) && data.result.length) {
        await processUpdates(data.result);
      }
    } catch {
      // Transient offline / campus network interruption — retry quietly next cycle.
    } finally {
      polling = false;
    }
  }

  function start() {
    stopped = false;
    const loop = async () => {
      if (stopped) return;
      await pollOnce();
      if (!stopped) pollTimer = setTimeout(loop, getBotToken() ? 1500 : 5000);
      if (pollTimer?.unref) pollTimer.unref();
    };
    loop();
  }

  function stop() {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
  }

  async function testConnection() {
    const token = getBotToken();
    if (!token) {
      throw Object.assign(new Error("Enter a Telegram Bot Token first."), {
        status: 400,
      });
    }
    const me = await callApi("getMe", {});
    await syncBotCommands();
    const storageChatId = getStorageChatId();
    let storageInfo = null;
    if (storageChatId) {
      try {
        const chat = await callApi("getChat", { chat_id: storageChatId });
        let botStatus = chat.type === "private" ? "private" : "unknown";
        let canPost = chat.type === "private";
        if (chat.type !== "private" && me?.id) {
          try {
            const m = await callApi("getChatMember", { chat_id: storageChatId, user_id: me.id });
            botStatus = m?.status || "member";
            canPost =
              chat.type === "channel"
                ? botStatus === "administrator" && m?.can_post_messages !== false
                : botStatus === "administrator" || botStatus === "member";
          } catch {}
        }
        storageInfo = {
          chatId: storageChatId,
          title: chat.title || chat.username || chat.first_name || storageChatId,
          type: chat.type,
          botStatus,
          canPost,
        };
      } catch (e) {
        storageInfo = {
          chatId: storageChatId,
          error: e?.message || "Bot cannot access this chat/channel yet",
        };
      }
    }
    return {
      ok: true,
      username: me.username,
      firstName: me.first_name,
      storageInfo,
    };
  }

  return {
    sendRequestNotifications,
    sendApprovedArchive,
    sendQrScanAlert,
    syncReviewedMessages,
    syncBotCommands,
    processUpdates,
    pollOnce,
    testConnection,
    start,
    stop,
  };
}

module.exports = { createTelegramBot };
