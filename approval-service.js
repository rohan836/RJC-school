const crypto = require("node:crypto");
const { computeVerificationSeal } = require("./verification-seal");

function formatIstDateTime(iso) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso || "");
  return dt.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function createApprovalService({
  db,
  clean,
  esc,
  safeSettings,
  portalUrl,
  verifyUrl,
  verificationSecret,
  now = () => new Date(),
}) {
  function nextSerial() {
    const year = new Intl.DateTimeFormat("en", {
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }).format(now());
    const prefix = `RJC-${year}-`;
    if (
      db
        .prepare("SELECT count(*) AS n FROM issued_logs WHERE serial_no LIKE ?")
        .get(prefix + "%").n >= 90000
    ) {
      throw Object.assign(new Error("Annual serial number capacity reached."), {
        status: 409,
      });
    }
    let serialNo;
    do {
      serialNo = prefix + crypto.randomInt(10000, 100000);
    } while (
      db.prepare("SELECT 1 FROM issued_logs WHERE serial_no=?").get(serialNo)
    );
    return serialNo;
  }

  function nextRequestId() {
    const d = now();
    const ymd = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("");
    let id;
    do {
      id = `REQ-${ymd}-${crypto.randomInt(1000, 10000)}`;
    } while (
      db.prepare("SELECT 1 FROM approval_requests WHERE id=?").get(id)
    );
    return id;
  }

  function createRequest({
    student,
    tpl,
    lang,
    verifiedPhone,
    authMethod,
    isGuardian,
    guardianPhone,
    parentPhotoData,
    supportingDoc,
    reason = "",
    campusCodeUsed = "",
  }) {
    const id = nextRequestId();
    const cleanLang = ["mr", "hi", "en"].includes(lang) ? lang : "en";
    const docTitle = tpl["title_" + cleanLang] || tpl.title_en;
    const cleanReason = String(reason || "").trim().slice(0, 200);
    const cleanCampus = String(campusCodeUsed || "").trim().slice(0, 16);
    const createdAt = now().toISOString();
    db.prepare(
      `INSERT INTO approval_requests(
        id, gr_number, student_name, template_id, doc_title, lang,
        verified_phone, auth_method, is_guardian, guardian_phone,
        parent_photo_data, supporting_doc_name, supporting_doc_mime, supporting_doc_data,
        reason, campus_code_used,
        status, print_status, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      student.gr_number,
      student.full_name,
      tpl.id,
      docTitle,
      cleanLang,
      verifiedPhone || "",
      authMethod || "family",
      isGuardian ? 1 : 0,
      guardianPhone || "",
      parentPhotoData || "",
      supportingDoc?.fileName || "",
      supportingDoc?.mime || "",
      supportingDoc?.dataUrl || "",
      cleanReason,
      cleanCampus,
      "PENDING",
      "WAITING",
      createdAt,
    );
    return db.prepare("SELECT * FROM approval_requests WHERE id=?").get(id);
  }

  function approveRequest({ requestId, teacher, channel = "web" }) {
    return db.transaction(() => {
      const reqRow = db
        .prepare("SELECT * FROM approval_requests WHERE id=?")
        .get(requestId);
      if (!reqRow) {
        return { notFound: true };
      }
      if (reqRow.status !== "PENDING") {
        return { alreadyHandled: true, request: reqRow };
      }

      const student = db
        .prepare("SELECT * FROM students WHERE gr_number=?")
        .get(reqRow.gr_number);
      const tpl = db
        .prepare("SELECT * FROM document_templates WHERE id=?")
        .get(reqRow.template_id);
      if (!student || !tpl) {
        throw Object.assign(
          new Error("Student or document template is no longer available."),
          { status: 404 },
        );
      }

      if (tpl.require_top_teacher && !teacher?.is_top_teacher) {
        return { forbiddenTopOnly: true, request: reqRow };
      }

      const serialNo = nextSerial();
      const reviewIso = now().toISOString();
      const issuedYear = Number(
        new Intl.DateTimeFormat("en", {
          year: "numeric",
          timeZone: "Asia/Kolkata",
        }).format(now()),
      );
      const issuedAtDisplay = now().toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      const lang = ["mr", "hi", "en"].includes(reqRow.lang) ? reqRow.lang : "en";
      const body =
        lang === "en" ? tpl.body_html : tpl["body_" + lang] || tpl.body_html;
      const vals = {
        student_name: student.full_name,
        father_name: student.father_name || "",
        mother_name: student.mother_name || "",
        class_name: student.class_name,
        division: student.division,
        gr_number: student.gr_number,
        roll_no: student.roll_no || "",
        academic_year: student.academic_year || "",
        blood_group: student.blood_group || "",
        house: student.house || "",
        apaar_id: student.apaar_id || "",
        address: student.address || "",
        dob: student.dob,
        issue_date: issuedAtDisplay,
      };
      const approverName = String(teacher?.name || "School Teacher").trim();
      const approverRole = String(teacher?.role || "Teacher").trim();
      const renderedBodyHtml = clean(body).replace(/{{(\w+)}}/g, (_, key) =>
        esc(vals[key] || ""),
      );
      const docTitle = tpl["title_" + lang] || reqRow.doc_title;
      const secretRow =
        (typeof verificationSecret === "function" ? verificationSecret() : "") ||
        db.prepare("SELECT verification_secret FROM school_settings WHERE id=1").get()?.verification_secret ||
        "";
      const seal = secretRow
        ? computeVerificationSeal(secretRow, {
            serialNo,
            grNumber: student.gr_number,
            studentName: student.full_name,
            docTitle,
            issuedAt: issuedAtDisplay,
            bodyHtml: renderedBodyHtml,
          })
        : { sig: "", securityCode: "", contentHash: "" };
      const defaultVerifyUrl = (sNo, sig) =>
        sig
          ? `${portalUrl()}/verify/${sNo}?v=${encodeURIComponent(sig)}`
          : `${portalUrl()}/verify/${sNo}`;
      const verificationUrl =
        typeof verifyUrl === "function"
          ? verifyUrl(serialNo, seal.sig)
          : defaultVerifyUrl(serialNo, seal.sig);
      const collectorLabel = reqRow.is_guardian
        ? "Authorized Guardian"
        : "Parent / Family Collector";
      const cert = {
        serialNo,
        issuedAt: issuedAtDisplay,
        docTitle,
        reason: reqRow.reason || "",
        collectorLabel,
        supportingDocName: reqRow.supporting_doc_name || "",
        approvedByName: approverName,
        approvedByRole: approverRole,
        approvedAtDisplay: formatIstDateTime(reviewIso),
        securityCode: seal.securityCode,
        docSignature: seal.sig,
        contentHash: seal.contentHash,
        bodyHtml: renderedBodyHtml,
        sigPos: tpl.sig_pos,
        stampPos: tpl.stamp_pos,
        lang,
        settings: safeSettings(),
        student: {
          full_name: student.full_name,
          gr_number: student.gr_number,
          class_name: student.class_name,
          division: student.division,
        },
        verificationUrl,
      };

      const settingRow = db
        .prepare("SELECT staff_print_confirm FROM school_settings WHERE id=1")
        .get();
      const twoPersonPrint = Number(settingRow?.staff_print_confirm || 0) === 1;
      const initialPrintStatus = twoPersonPrint ? "HOLD_STAFF" : "QUEUED";

      const downloadToken = crypto.randomBytes(32).toString("hex");
      db.prepare(
        `INSERT INTO issued_logs(
          serial_no, gr_number, student_name, doc_title, verified_phone,
          is_guardian, issued_at, certificate_json, download_hash, reason,
          supporting_doc_name, supporting_doc_mime, supporting_doc_data,
          request_id, approved_by_name, approved_by_role, parent_photo_data,
          scan_count, last_scanned_at, issued_year, doc_signature, security_code,
          campus_code_used
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        serialNo,
        student.gr_number,
        student.full_name,
        cert.docTitle,
        reqRow.guardian_phone || reqRow.verified_phone,
        reqRow.is_guardian ? 1 : 0,
        reviewIso,
        JSON.stringify(cert),
        crypto.createHash("sha256").update(downloadToken).digest("hex"),
        reqRow.reason || "",
        reqRow.supporting_doc_name || "",
        reqRow.supporting_doc_mime || "",
        reqRow.supporting_doc_data || "",
        reqRow.id,
        approverName,
        approverRole,
        reqRow.parent_photo_data || "",
        0,
        "",
        issuedYear,
        seal.sig,
        seal.securityCode,
        reqRow.campus_code_used || "",
      );

      db.prepare(
        `UPDATE approval_requests SET
          status='APPROVED',
          approved_by_teacher_id=?,
          reviewed_by_name=?,
          reviewed_by_role=?,
          review_channel=?,
          serial_no=?,
          print_status=?,
          reviewed_at=?
        WHERE id=? AND status='PENDING'`,
      ).run(
        teacher?.id || null,
        approverName,
        approverRole,
        channel,
        serialNo,
        initialPrintStatus,
        reviewIso,
        reqRow.id,
      );

      const updated = db
        .prepare("SELECT * FROM approval_requests WHERE id=?")
        .get(reqRow.id);
      return { alreadyHandled: false, request: updated, cert };
    })();
  }

  function rejectRequest({ requestId, teacher, channel = "web", reason = "" }) {
    return db.transaction(() => {
      const reqRow = db
        .prepare("SELECT * FROM approval_requests WHERE id=?")
        .get(requestId);
      if (!reqRow) return { notFound: true };
      if (reqRow.status !== "PENDING") {
        return { alreadyHandled: true, request: reqRow };
      }
      const reviewIso = now().toISOString();
      const approverName = String(teacher?.name || "School Teacher").trim();
      const approverRole = String(teacher?.role || "Teacher").trim();
      const cleanReason = String(reason || "Declined by teacher.")
        .trim()
        .slice(0, 240);
      db.prepare(
        `UPDATE approval_requests SET
          status='REJECTED',
          approved_by_teacher_id=?,
          reviewed_by_name=?,
          reviewed_by_role=?,
          review_channel=?,
          rejection_reason=?,
          print_status='CANCELLED',
          reviewed_at=?
        WHERE id=? AND status='PENDING'`,
      ).run(
        teacher?.id || null,
        approverName,
        approverRole,
        channel,
        cleanReason,
        reviewIso,
        reqRow.id,
      );
      return {
        alreadyHandled: false,
        request: db
          .prepare("SELECT * FROM approval_requests WHERE id=?")
          .get(reqRow.id),
      };
    })();
  }

  function recordQrScan(serialNo, sourceHint = "") {
    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT serial_no, gr_number, student_name, doc_title, issued_at,
            is_guardian, approved_by_name, approved_by_role, parent_photo_data,
            supporting_doc_name, reason, campus_code_used,
            COALESCE(print_count, 0) AS print_count, printer_name, printed_by_name, last_printed_at,
            scan_count, last_scanned_at,
            certificate_json, doc_signature, security_code
          FROM issued_logs WHERE serial_no=?`,
        )
        .get(serialNo);
      if (!row) return null;
      const scannedAt = now().toISOString();
      db.prepare(
        "INSERT INTO qr_scans(serial_no, scanned_at, source_hint) VALUES(?,?,?)",
      ).run(serialNo, scannedAt, String(sourceHint || "").slice(0, 120));
      db.prepare(
        "UPDATE issued_logs SET scan_count = COALESCE(scan_count, 0) + 1, last_scanned_at = ? WHERE serial_no=?",
      ).run(scannedAt, serialNo);
      const updated = db
        .prepare(
          `SELECT serial_no, gr_number, student_name, doc_title, issued_at,
            is_guardian, approved_by_name, approved_by_role, parent_photo_data,
            supporting_doc_name, reason, campus_code_used,
            COALESCE(print_count, 0) AS print_count, printer_name, printed_by_name, last_printed_at,
            scan_count, last_scanned_at,
            certificate_json, doc_signature, security_code
          FROM issued_logs WHERE serial_no=?`,
        )
        .get(serialNo);
      const recentScans = db
        .prepare(
          "SELECT scanned_at, source_hint FROM qr_scans WHERE serial_no=? ORDER BY id DESC LIMIT 15",
        )
        .all(serialNo);
      return { ...updated, recentScans };
    })();
  }

  return {
    createRequest,
    approveRequest,
    rejectRequest,
    recordQrScan,
    formatIstDateTime,
  };
}

module.exports = { createApprovalService, formatIstDateTime };
