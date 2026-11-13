const crypto = require("node:crypto");
const words = {
  en: {
    start: "Choose your language",
    phone: "Enter your registered 10-digit mobile number.",
    student: "Choose your student",
    birth: "Enter the child’s four-digit birth year.",
    code: "Enter the live four-digit campus code shown at school.",
    document: "Choose a document",
    missing:
      "No active student is registered to this WhatsApp number. Contact the school office.",
    expired: "Session ended. Send Hi to begin again.",
    done: "Your certificate is attached. This session is now cleared.",
    error:
      "Unable to complete this request. Check your details or contact school staff.",
  },
  mr: {
    start: "भाषा निवडा",
    phone: "नोंदणीकृत १० अंकी मोबाईल क्रमांक पाठवा.",
    student: "विद्यार्थी निवडा",
    birth: "विद्यार्थ्याचे चार अंकी जन्मवर्ष पाठवा.",
    code: "शाळेतील स्क्रीनवरील चार अंकी कॅम्पस कोड पाठवा.",
    document: "प्रमाणपत्र निवडा",
    missing: "या व्हॉट्सॲप क्रमांकावर सक्रिय विद्यार्थी नाही. शाळेशी संपर्क साधा.",
    expired: "सत्र संपले. पुन्हा सुरू करण्यासाठी Hi पाठवा.",
    done: "प्रमाणपत्र जोडले आहे. सत्रातील माहिती हटवली आहे.",
    error: "विनंती पूर्ण झाली नाही. माहिती तपासा किंवा शाळेशी संपर्क साधा.",
  },
  hi: {
    start: "भाषा चुनें",
    phone: "पंजीकृत 10 अंकों का मोबाइल नंबर भेजें।",
    student: "छात्र चुनें",
    birth: "बच्चे का चार अंकों का जन्म वर्ष भेजें।",
    code: "विद्यालय स्क्रीन पर दिख रहा चार अंकों का कैंपस कोड भेजें।",
    document: "प्रमाणपत्र चुनें",
    missing: "इस व्हाट्सऐप नंबर पर सक्रिय छात्र नहीं मिला। विद्यालय से संपर्क करें।",
    expired: "सत्र समाप्त हुआ। फिर शुरू करने के लिए Hi भेजें।",
    done: "प्रमाणपत्र संलग्न है। सत्र की जानकारी हटा दी गई है।",
    error: "अनुरोध पूरा नहीं हुआ। जानकारी जाँचें या विद्यालय से संपर्क करें।",
  },
};
function createWhatsApp({ db, issue, decorate, pdf, fail }, transport) {
  const sessions = new Map(),
    queues = new Map();
  const configured = () =>
    Boolean(
      process.env.WHATSAPP_TOKEN &&
      process.env.PHONE_NUMBER_ID &&
      process.env.WHATSAPP_APP_SECRET &&
      process.env.WHATSAPP_VERIFY_TOKEN,
    );
  const base = () =>
    `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v25.0"}/${process.env.PHONE_NUMBER_ID}`;
  async function api(endpoint, body) {
    const r = await fetch(base() + endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.WHATSAPP_TOKEN,
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error("WhatsApp service request failed");
    return r.json();
  }
  const send =
    transport?.send ||
    ((to, message) =>
      api("/messages", { messaging_product: "whatsapp", to, ...message }));
  const upload =
    transport?.upload ||
    (async (buffer, name) => {
      const f = new FormData();
      f.set("messaging_product", "whatsapp");
      f.set("type", "application/pdf");
      f.set("file", new Blob([buffer], { type: "application/pdf" }), name);
      return (await api("/media", f)).id;
    });
  const text = (to, body) => send(to, { type: "text", text: { body } });
  const list = (to, body, rows) =>
    send(to, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: "Select / निवडा",
          sections: [
            {
              title: "School",
              rows: rows
                .slice(0, 10)
                .map((r) => ({ id: r.id, title: r.title.slice(0, 24) })),
            },
          ],
        },
      },
    });
  const start = (to) =>
    send(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "भाषा निवडा / भाषा चुनें / Choose language" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "lang_mr", title: "मराठी" } },
            { type: "reply", reply: { id: "lang_hi", title: "हिंदी" } },
            { type: "reply", reply: { id: "lang_en", title: "English" } },
          ],
        },
      },
    });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
    db.prepare("DELETE FROM webhook_receipts WHERE updated_at < ?").run(
      now - 7 * 86400000,
    );
  }, 30000);
  timer.unref();
  async function deliver(to, serial) {
    const row = db
      .prepare("SELECT certificate_json FROM issued_logs WHERE serial_no=?")
      .get(serial);
    const cert = await decorate(JSON.parse(row.certificate_json));
    const id = await upload(await pdf(cert.certificateHtml), serial + ".pdf");
    await send(to, {
      type: "document",
      document: {
        id,
        filename: serial + ".pdf",
        caption: words[cert.lang || "en"].done,
      },
    });
  }
  async function handle(m) {
    if (!m.id || !/^\d{8,16}$/.test(String(m.from || ""))) return;
    const receipt = db
      .prepare("SELECT * FROM webhook_receipts WHERE id=?")
      .get(m.id);
    if (receipt?.status === "sent") return;
    db.prepare(
      "INSERT INTO webhook_receipts(id,status,updated_at) VALUES(?,'processing',?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",
    ).run(m.id, Date.now());
    const to = m.from;
    const value = String(
      m.interactive?.button_reply?.id ||
        m.interactive?.list_reply?.id ||
        m.text?.body ||
        "",
    ).trim();
    let s = sessions.get(to);
    let lang = s?.lang || "en";
    try {
      if (receipt?.serial_no) {
        try {
          await deliver(to, receipt.serial_no);
        } finally {
          sessions.delete(to);
        }
      } else if (/^lang_(mr|hi|en)$/.test(value)) {
        lang = value.slice(5);
        s = { lang, stage: "phone", expires: Date.now() + 300000 };
        sessions.set(to, s);
        await text(to, words[lang].phone);
      } else if (
        !s ||
        s.expires < Date.now() ||
        /^(hi|hello|start|reset)$/i.test(value)
      ) {
        sessions.delete(to);
        await start(to);
      } else {
        s.expires = Date.now() + 300000;
        if (s.stage === "phone") {
          const phone = value.replace(/\D/g, "").slice(-10);
          if (!/^\d{10}$/.test(phone) || phone !== to.slice(-10)) {
            await text(to, words[lang].missing);
            sessions.delete(to);
          } else {
            const students = db
              .prepare(
                "SELECT gr_number,full_name FROM students WHERE parent_phone=? AND status='ACTIVE'",
              )
              .all(phone);
            if (!students.length) {
              await text(to, words[lang].missing);
              sessions.delete(to);
            } else {
              s.students = students.map((r) => r.gr_number);
              s.stage = "student";
              await list(
                to,
                words[lang].student,
                students.map((r) => ({
                  id: "student_" + r.gr_number,
                  title: r.full_name,
                })),
              );
            }
          }
        } else if (s.stage === "student") {
          const gr = value.replace(/^student_/, "");
          if (!s.students.includes(gr)) await text(to, words[lang].student);
          else {
            s.grNumber = gr;
            s.stage = "birth";
            await text(to, words[lang].birth);
          }
        } else if (s.stage === "birth") {
          if (!/^\d{4}$/.test(value)) await text(to, words[lang].birth);
          else {
            s.birthYear = value;
            s.stage = "code";
            await text(to, words[lang].code);
          }
        } else if (s.stage === "code") {
          if (!/^\d{4}$/.test(value)) await text(to, words[lang].code);
          else {
            s.campusCode = value;
            s.stage = "document";
            const templates = db
              .prepare("SELECT * FROM document_templates WHERE is_active=1")
              .all();
            s.templates = templates.map((t) => String(t.id));
            await list(
              to,
              words[lang].document,
              templates.map((t) => ({
                id: "template_" + t.id,
                title: t["title_" + lang],
              })),
            );
          }
        } else if (s.stage === "document") {
          const id = value.replace(/^template_/, "");
          if (!s.templates.includes(id)) await text(to, words[lang].document);
          else {
            try {
              const cert = issue(
                {
                  grNumber: s.grNumber,
                  birthYear: s.birthYear,
                  campusCode: s.campusCode,
                  templateId: Number(id),
                  lang,
                },
                false,
                m.id,
              );
              db.prepare(
                "UPDATE webhook_receipts SET serial_no=? WHERE id=?",
              ).run(cert.serialNo, m.id);
              await deliver(to, cert.serialNo);
            } catch (e) {
              if (
                !db
                  .prepare("SELECT serial_no FROM webhook_receipts WHERE id=?")
                  .get(m.id)?.serial_no
              ) {
                await text(to, words[lang].error);
                if (e.status === 403) await text(to, words[lang].code);
              } else throw e;
            } finally {
              sessions.delete(to);
            }
          }
        }
      }
      db.prepare(
        "UPDATE webhook_receipts SET status='sent',updated_at=? WHERE id=?",
      ).run(Date.now(), m.id);
    } catch (e) {
      db.prepare(
        "UPDATE webhook_receipts SET status='failed',updated_at=? WHERE id=?",
      ).run(Date.now(), m.id);
      throw e;
    }
  }
  return {
    verify(req, res) {
      if (!process.env.WHATSAPP_VERIFY_TOKEN)
        return res.status(503).send("WhatsApp is not configured");
      if (
        req.query["hub.mode"] === "subscribe" &&
        req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN &&
        typeof req.query["hub.challenge"] === "string"
      )
        return res.status(200).send(req.query["hub.challenge"]);
      res.sendStatus(403);
    },
    async receive(req, res) {
      if (!configured() && !transport)
        return res
          .status(503)
          .json({ error: "Configure WhatsApp credentials first." });
      const signature = String(req.headers["x-hub-signature-256"] || "");
      if (!/^sha256=[0-9a-f]{64}$/i.test(signature))
        return res.sendStatus(401);
      const expected =
        "sha256=" +
        crypto
          .createHmac("sha256", process.env.WHATSAPP_APP_SECRET || "")
          .update(req.rawBody || Buffer.alloc(0))
          .digest("hex");
      if (
        !crypto.timingSafeEqual(
          Buffer.from(signature.toLowerCase(), "ascii"),
          Buffer.from(expected, "ascii"),
        )
      )
        return res.sendStatus(401);
      if (req.body.object !== "whatsapp_business_account")
        return res.sendStatus(404);
      try {
        for (const entry of req.body.entry || [])
          for (const change of entry.changes || [])
            for (const m of change.value?.metadata?.phone_number_id &&
            change.value.metadata.phone_number_id !==
              process.env.PHONE_NUMBER_ID
              ? []
              : change.value?.messages || []) {
              const previous = queues.get(m.from) || Promise.resolve();
              const task = previous.catch(() => {}).then(() => handle(m));
              queues.set(m.from, task);
              try {
                await task;
              } finally {
                if (queues.get(m.from) === task) queues.delete(m.from);
              }
            }
        res.sendStatus(200);
      } catch {
        res.sendStatus(503);
      }
    },
    close() {
      clearInterval(timer);
      sessions.clear();
    },
    sessionCount: () => sessions.size,
  };
}
module.exports = { createWhatsApp };
