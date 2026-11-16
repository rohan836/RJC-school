"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const { openDatabase } = require("../db");
const {
  encryptBackupBuffer,
  decryptBackupBuffer,
  isEncryptedBackupBuffer,
  isSqliteBuffer,
  verifySqliteSnapshot,
  checkDbHealth,
} = require("../backup-crypto");
const { restoreDatabaseFromBackup } = require("../tools/restore");

test("encryptBackupBuffer and decryptBackupBuffer round-trip and reject wrong passphrases or tampering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-cryp-"));
  try {
    const db = openDatabase(dir);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const raw = fs.readFileSync(path.join(dir, "school.db"));
    assert.equal(isSqliteBuffer(raw), true);

    assert.throws(
      () => encryptBackupBuffer(raw, "short"),
      /at least 8 characters/i,
    );

    const enc = encryptBackupBuffer(raw, "SchoolSafe#2026");
    assert.equal(isEncryptedBackupBuffer(enc), true);
    assert.equal(isSqliteBuffer(enc), false);

    const dec = decryptBackupBuffer(enc, "SchoolSafe#2026");
    assert.equal(dec.equals(raw), true);

    assert.throws(
      () => decryptBackupBuffer(enc, "WrongPass#2026"),
      /wrong passphrase|corrupted/i,
    );

    // Flip 1 bit inside ciphertext -> AES-256-GCM auth tag must reject
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 10] ^= 0xff;
    assert.throws(
      () => decryptBackupBuffer(tampered, "SchoolSafe#2026"),
      /wrong passphrase|corrupted/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifySqliteSnapshot & checkDbHealth validate schema and WAL settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-hlth-"));
  try {
    const db = openDatabase(dir);
    const dbFile = path.join(dir, "school.db");
    const health = checkDbHealth(db, dbFile);
    assert.equal(health.ok, true);
    assert.equal(health.quickCheck, "ok");
    assert.equal(health.journalMode, "wal");
    assert.equal(health.synchronous, 2); // FULL = 2
    assert.ok(health.counts.students >= 6);
    db.close();

    const snap = verifySqliteSnapshot(Database, dbFile);
    assert.equal(snap.ok, true);
    assert.equal(snap.integrity, "ok");
    assert.ok(snap.counts.students >= 6);

    // Corrupted / non-sqlite file must be rejected
    const bogus = path.join(dir, "not-a-db.db");
    fs.writeFileSync(bogus, "corrupted garbage data");
    assert.throws(() => verifySqliteSnapshot(Database, bogus), /not a valid SQLite/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreDatabaseFromBackup restores an encrypted .rjcbackup cleanly and preserves pre-restore snapshot", async () => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-src-"));
  const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-dst-"));
  try {
    const srcDb = openDatabase(srcDir);
    srcDb
      .prepare(
        "INSERT INTO students(gr_number, full_name, father_name, class_name, division, dob, birth_year, parent_phone, status) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "9901",
        "Test Crash Recovery Student",
        "Parent Name",
        "10th",
        "A",
        "01/01/2011",
        "2011",
        "9876543210",
        "ACTIVE",
      );
    const snapPath = path.join(srcDir, "snap.db");
    await srcDb.backup(snapPath);
    srcDb.close();

    const encPath = path.join(srcDir, "backup.rjcbackup");
    fs.writeFileSync(
      encPath,
      encryptBackupBuffer(fs.readFileSync(snapPath), "RecoverKey#99"),
    );

    // Initialize an older database at dstDir without student 9901
    const oldDb = openDatabase(dstDir);
    oldDb.close();

    // Wrong passphrase must fail WITHOUT destroying existing dstDir/school.db
    await assert.rejects(
      () =>
        restoreDatabaseFromBackup({
          backupPath: encPath,
          dataDir: dstDir,
          passphrase: "BadPassword123",
        }),
      /wrong passphrase|corrupted/i,
    );

    const res = await restoreDatabaseFromBackup({
      backupPath: encPath,
      dataDir: dstDir,
      passphrase: "RecoverKey#99",
    });
    assert.equal(res.ok, true);
    assert.equal(res.wasEncrypted, true);
    assert.ok(fs.existsSync(res.preRestoreFile), "pre-restore safety copy created");

    const restoredDb = openDatabase(dstDir);
    const recovered = restoredDb
      .prepare("SELECT full_name FROM students WHERE gr_number='9901'")
      .get();
    assert.equal(recovered?.full_name, "Test Crash Recovery Student");
    restoredDb.close();
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(dstDir, { recursive: true, force: true });
  }
});

test(
  "server backup endpoints (/api/admin/backup/health, /backup, /backup/download) & clean WAL shutdown",
  { timeout: 60000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-srv-bak-"));
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-ext-bak-"));
    const port = 52000 + Math.floor(Math.random() * 1000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "../server.js")],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(port),
          KIOSK_DATA_DIR: dataDir,
          HOST: "127.0.0.1",
          BACKUP_DIR: extDir,
          BACKUP_PASSPHRASE: "MirrorSecret#2026",
          PUBLIC_PORTAL_URL: "",
          PUBLIC_WEBHOOK_URL: "",
        },
        stdio: "ignore",
      },
    );

    let token = "";
    try {
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }

      // Unauthenticated access rejected
      const unauth = await fetch(`${base}/api/admin/backup/health`);
      assert.equal(unauth.status, 401);

      const login = await fetch(`${base}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "school1234" }),
      });
      assert.equal(login.status, 200);
      const loginData = await login.json();
      token = loginData.token;

      // Check health endpoint
      const hRes = await fetch(`${base}/api/admin/backup/health`, {
        headers: { "x-admin-token": token },
      });
      assert.equal(hRes.status, 200);
      const h = await hRes.json();
      assert.equal(h.ok, true);
      assert.equal(h.journalMode, "wal");
      assert.equal(h.externalBackupConfigured, true);
      assert.equal(h.externalBackupEncrypted, true);

      // Trigger local backup + external encrypted mirror
      const bRes = await fetch(`${base}/api/admin/backup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({}),
      });
      assert.equal(bRes.status, 200);
      const bJson = await bRes.json();
      assert.equal(bJson.ok, true);
      assert.equal(bJson.externalMirrored, true);

      const extFiles = fs.readdirSync(extDir);
      assert.ok(
        extFiles.some((f) => f.endsWith(".rjcbackup")),
        "external BACKUP_DIR receives encrypted .rjcbackup when BACKUP_PASSPHRASE is set",
      );

      // Short passphrase rejected
      const badPass = await fetch(`${base}/api/admin/backup/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ passphrase: "123" }),
      });
      assert.equal(badPass.status, 400);

      // Download encrypted backup & verify decryption yields valid SQLite snapshot
      const dlRes = await fetch(`${base}/api/admin/backup/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ passphrase: "DownloadPass#88" }),
      });
      assert.equal(dlRes.status, 200);
      assert.equal(dlRes.headers.get("x-backup-encrypted"), "1");
      const encBuf = Buffer.from(await dlRes.arrayBuffer());
      assert.equal(isEncryptedBackupBuffer(encBuf), true);
      const plainBuf = decryptBackupBuffer(encBuf, "DownloadPass#88");
      const verifyFile = path.join(dataDir, "verify-dl.db");
      fs.writeFileSync(verifyFile, plainBuf);
      const verified = verifySqliteSnapshot(Database, verifyFile);
      assert.equal(verified.ok, true);
    } finally {
      if (token) {
        try {
          await fetch(`${base}/api/admin/system/shutdown`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-admin-token": token,
            },
            body: JSON.stringify({}),
          });
        } catch {}
      }
      child.kill(process.platform === "win32" ? "SIGINT" : "SIGTERM");
      await new Promise((r) =>
        child.exitCode !== null ? r() : child.once("exit", r),
      );
      // Clean WAL size check after signal checkpoint
      const walPath = path.join(dataDir, "school.db-wal");
      if (fs.existsSync(walPath)) {
        assert.equal(fs.statSync(walPath).size, 0, "WAL truncated cleanly on exit");
      }
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fs.rmSync(extDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);

test("GitHub & USB safety audit: .gitignore blocks sensitive files and Export_To_USB.bat includes all modules", () => {
  const root = path.resolve(__dirname, "..");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const requiredPattern of [
    "*.db",
    "*.db-wal",
    "*.db-shm",
    ".env",
    "backups/",
    "*.rjcbackup",
    "admin-credentials.txt",
    "*.csv",
    "data/",
    "node_modules/",
    ".playwright-cli/",
  ]) {
    assert.ok(
      gitignore.includes(requiredPattern),
      `.gitignore must include ${requiredPattern}`,
    );
  }

  const usbBat = fs.readFileSync(
    path.join(root, "tools", "Export_To_USB.bat"),
    "utf8",
  );
  for (const mod of [
    "backup-crypto.js",
    "verification-seal.js",
    "approval-service.js",
    "telegram.js",
    "print-queue.js",
    "Restore_Backup.bat",
    "Start_Dual_Monitor_Windows11.bat",
    ".env.example",
  ]) {
    assert.ok(usbBat.includes(mod), `Export_To_USB.bat must copy ${mod}`);
  }
});
