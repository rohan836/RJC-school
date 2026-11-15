const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computePrintCopySeal } = require("./verification-seal");

function createPrintQueue({ db, settings, decorate, pdf }) {
  function sanitizePrinterName(name) {
    return String(name || "")
      .replace(/[^\w\s.\-():/]/g, "")
      .trim()
      .slice(0, 120);
  }

  function resolvedPrinterName() {
    return sanitizePrinterName(settings()?.printer_name || "") || "School Counter Printer";
  }

  function copyInfoForCount(nextCopy) {
    const copyNumber = Math.max(1, Number(nextCopy || 1));
    return {
      copyNumber,
      copyLabel: copyNumber === 1 ? "ORIGINAL" : `DUPLICATE #${copyNumber}`,
    };
  }

  function computeCopySealForSerial(serialNo, copyNumber) {
    const secret = String(settings()?.verification_secret || "rjc-default-verify-secret").trim();
    const logRow = serialNo
      ? db.prepare("SELECT doc_signature FROM issued_logs WHERE serial_no=?").get(serialNo)
      : null;
    return computePrintCopySeal(secret, {
      serialNo: serialNo || "",
      copyNumber,
      docSignature: logRow?.doc_signature || "",
    });
  }

  function recordPrintCompletion(requestId, actorName = "") {
    return db.transaction(() => {
      const latest = db
        .prepare("SELECT * FROM approval_requests WHERE id=? AND status='APPROVED'")
        .get(requestId);
      if (!latest) return null;
      const { copyNumber, copyLabel } = copyInfoForCount(Number(latest.print_count || 0) + 1);
      const printerName = resolvedPrinterName();
      const printedByName = String(
        actorName || latest.printed_by_name || latest.reviewed_by_name || "School Counter Staff",
      )
        .trim()
        .slice(0, 100);
      const nowIso = new Date().toISOString();
      const copySeal = computeCopySealForSerial(latest.serial_no, copyNumber);
      db.prepare(
        `UPDATE approval_requests SET
          print_status='PRINTED',
          print_error='',
          printed_at=?,
          print_count=?,
          printer_name=?,
          printed_by_name=?,
          last_print_code=?
         WHERE id=? AND status='APPROVED'`,
      ).run(
        nowIso,
        copyNumber,
        printerName,
        printedByName,
        copySeal.printSecurityCode,
        requestId,
      );

      if (latest.serial_no) {
        db.prepare(
          `UPDATE issued_logs SET
            print_count=?,
            printer_name=?,
            printed_by_name=?,
            last_printed_at=?,
            last_print_code=?
           WHERE serial_no=?`,
        ).run(
          copyNumber,
          printerName,
          printedByName,
          nowIso,
          copySeal.printSecurityCode,
          latest.serial_no,
        );

        db.prepare(
          `INSERT INTO print_logs(serial_no, request_id, copy_number, copy_label, printer_name, printed_by_name, printed_at, page_no, print_token, print_security_code)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          latest.serial_no,
          latest.id,
          copyNumber,
          copyLabel,
          printerName,
          printedByName,
          nowIso,
          copySeal.pageNo,
          copySeal.printToken,
          copySeal.printSecurityCode,
        );
      }
      return db.prepare("SELECT * FROM approval_requests WHERE id=?").get(requestId);
    })();
  }

  function printPdfFileWithOs(filePath, printerName) {
    return new Promise((resolve, reject) => {
      const cleanPrinter = sanitizePrinterName(printerName);
      if (process.platform === "win32") {
        // Windows shell PrintTo / default verb works with default PDF handler
        const psScript = cleanPrinter
          ? `Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb PrintTo -ArgumentList '${cleanPrinter.replace(/'/g, "''")}' -WindowStyle Hidden`
          : `Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb Print -WindowStyle Hidden`;
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", psScript],
          { timeout: 15000 },
          (err) => (err ? reject(err) : resolve()),
        );
        return;
      }
      const args = cleanPrinter ? ["-d", cleanPrinter, filePath] : [filePath];
      execFile("lp", args, { timeout: 15000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async function dispatchOsPrint(requestId, actorName = "") {
    const reqRow = db
      .prepare("SELECT * FROM approval_requests WHERE id=?")
      .get(requestId);
    if (!reqRow || reqRow.status !== "APPROVED" || !reqRow.serial_no) return;
    const logRow = db
      .prepare("SELECT certificate_json FROM issued_logs WHERE serial_no=?")
      .get(reqRow.serial_no);
    if (!logRow?.certificate_json) return;

    const { copyNumber, copyLabel } = copyInfoForCount(Number(reqRow.print_count || 0) + 1);
    const copySeal = computeCopySealForSerial(reqRow.serial_no, copyNumber);
    const printerName = resolvedPrinterName();
    const collectorLabel = reqRow.is_guardian
      ? "Authorized Guardian"
      : "Parent / Family Collector";
    const tempPath = path.join(
      os.tmpdir(),
      `rjc-print-${reqRow.serial_no}-c${copyNumber}-${Date.now()}.pdf`,
    );
    try {
      const cert = await decorate(JSON.parse(logRow.certificate_json), {
        copyNumber,
        copyLabel,
        printerName,
        collectorLabel,
        printSecurityCode: copySeal.printSecurityCode,
        printToken: copySeal.printToken,
        pageNo: copySeal.pageNo,
      });
      const pdfBytes = await pdf(cert.certificateHtml);
      fs.writeFileSync(tempPath, pdfBytes);
      await printPdfFileWithOs(tempPath, settings()?.printer_name || "");
      recordPrintCompletion(reqRow.id, actorName);
    } catch (e) {
      db.prepare(
        "UPDATE approval_requests SET print_status='FAILED', print_error=? WHERE id=?",
      ).run(String(e?.message || "Printer spooler unavailable").slice(0, 200), reqRow.id);
    } finally {
      setTimeout(() => {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
      }, 15000).unref();
    }
  }

  async function onRequestApproved(requestId) {
    const reqRow = db
      .prepare("SELECT print_status FROM approval_requests WHERE id=?")
      .get(requestId);
    if (!reqRow || reqRow.print_status !== "QUEUED") return;
    const mode = String(settings()?.auto_print_mode || "browser_kiosk");
    if (mode === "os_spooler") {
      await dispatchOsPrint(requestId);
    }
  }

  async function releaseStaffPrint(requestId, actorName = "") {
    return requeuePrint(requestId, actorName);
  }

  async function getNextBrowserJob() {
    const job = db
      .prepare(
        `SELECT id, serial_no, student_name, doc_title, reviewed_by_name, reviewed_by_role, reviewed_at, print_count, is_guardian
         FROM approval_requests
         WHERE status='APPROVED' AND print_status='QUEUED'
         ORDER BY reviewed_at ASC
         LIMIT 1`,
      )
      .get();
    if (!job || !job.serial_no) return null;
    const logRow = db
      .prepare("SELECT certificate_json FROM issued_logs WHERE serial_no=?")
      .get(job.serial_no);
    if (!logRow?.certificate_json) return null;
    const { copyNumber, copyLabel } = copyInfoForCount(Number(job.print_count || 0) + 1);
    const copySeal = computeCopySealForSerial(job.serial_no, copyNumber);
    const printerName = resolvedPrinterName();
    const collectorLabel = job.is_guardian
      ? "Authorized Guardian"
      : "Parent / Family Collector";
    const cert = await decorate(JSON.parse(logRow.certificate_json), {
      copyNumber,
      copyLabel,
      printerName,
      collectorLabel,
      printSecurityCode: copySeal.printSecurityCode,
      printToken: copySeal.printToken,
      pageNo: copySeal.pageNo,
    });
    return {
      requestId: job.id,
      serialNo: job.serial_no,
      studentName: job.student_name,
      docTitle: job.doc_title,
      approvedBy: job.reviewed_by_name,
      copyNumber,
      copyLabel,
      printerName,
      printSecurityCode: copySeal.printSecurityCode,
      pageNo: copySeal.pageNo,
      certificateBody: cert.certificateBody,
      certificateCss: cert.certificateCss,
      certificateHtml: cert.certificateHtml,
    };
  }

  function acknowledgeBrowserPrint(requestId, ok = true, error = "", actorName = "") {
    if (ok) {
      return recordPrintCompletion(requestId, actorName);
    }
    db.prepare(
      "UPDATE approval_requests SET print_status='FAILED', print_error=? WHERE id=? AND status='APPROVED'",
    ).run(String(error || "Print failed").slice(0, 200), requestId);
    return null;
  }

  async function requeuePrint(requestId, actorName = "") {
    const row = db
      .prepare("SELECT * FROM approval_requests WHERE id=? AND status='APPROVED'")
      .get(requestId);
    if (!row) return null;
    const cleanActor = String(actorName || "").trim().slice(0, 100);
    if (cleanActor) {
      db.prepare(
        "UPDATE approval_requests SET print_status='QUEUED', print_error=?, printed_by_name=? WHERE id=?",
      ).run("", cleanActor, requestId);
    } else {
      db.prepare(
        "UPDATE approval_requests SET print_status='QUEUED', print_error='' WHERE id=?",
      ).run(requestId);
    }
    if (String(settings()?.auto_print_mode || "browser_kiosk") === "os_spooler") {
      await dispatchOsPrint(requestId, cleanActor);
    }
    return db.prepare("SELECT * FROM approval_requests WHERE id=?").get(requestId);
  }

  return {
    onRequestApproved,
    releaseStaffPrint,
    getNextBrowserJob,
    acknowledgeBrowserPrint,
    requeuePrint,
  };
}

module.exports = { createPrintQueue };
