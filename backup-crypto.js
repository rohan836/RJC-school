"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BACKUP_MAGIC = Buffer.from("RJCBAK01", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES =
  BACKUP_MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES; // 52 bytes
const MIN_PASSPHRASE_LENGTH = 8;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

const REQUIRED_CORE_TABLES = [
  "admin_users",
  "school_settings",
  "students",
  "document_templates",
  "issued_logs",
  "approval_requests",
  "print_logs",
];

function validatePassphrase(passphrase) {
  const s = String(passphrase ?? "");
  if (!s.trim() || s.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
  return s;
}

function isEncryptedBackupBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > HEADER_BYTES &&
    buf.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
  );
}

function isSqliteBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 16 &&
    buf.subarray(0, 16).toString("ascii") === "SQLite format 3\0"
  );
}

/**
 * Encrypts a SQLite snapshot buffer into an authenticated .rjcbackup payload
 * using scrypt key derivation and AES-256-GCM.
 */
function encryptBackupBuffer(plainBuffer, passphrase) {
  if (!Buffer.isBuffer(plainBuffer) || plainBuffer.length < 100) {
    throw new Error("Invalid SQLite snapshot buffer.");
  }
  const pass = validatePassphrase(passphrase);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT_OPTIONS);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(BACKUP_MAGIC);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, salt, iv, tag, encrypted]);
}

/**
 * Decrypts and authenticates an .rjcbackup buffer. Throws on wrong passphrase,
 * corrupted header, or tampered bytes.
 */
function decryptBackupBuffer(encBuffer, passphrase) {
  if (!isEncryptedBackupBuffer(encBuffer)) {
    throw new Error("File is not a valid RJC encrypted backup (.rjcbackup).");
  }
  const pass = validatePassphrase(passphrase);
  let offset = BACKUP_MAGIC.length;
  const salt = encBuffer.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const iv = encBuffer.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = encBuffer.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = encBuffer.subarray(offset);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT_OPTIONS);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(BACKUP_MAGIC);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      "Could not decrypt backup. Wrong passphrase or corrupted backup file.",
    );
  }
  if (!isSqliteBuffer(plain)) {
    throw new Error("Decrypted backup is not a valid SQLite database.");
  }
  return plain;
}

/**
 * Verifies a standalone SQLite snapshot file on disk: checks SQLite header,
 * PRAGMA integrity_check === 'ok', presence of all required school tables, and
 * collects row counts.
 */
function verifySqliteSnapshot(DatabaseCtor, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Backup file does not exist.");
  }
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(16);
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!isSqliteBuffer(header)) {
    throw new Error("Backup file is not a valid SQLite database.");
  }
  const snapDb = new DatabaseCtor(filePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = snapDb.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${integrity}`);
    }
    const existingTables = new Set(
      snapDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    const missing = REQUIRED_CORE_TABLES.filter((t) => !existingTables.has(t));
    if (missing.length) {
      throw new Error(
        `Backup is missing required school tables: ${missing.join(", ")}`,
      );
    }
    const counts = {
      students: snapDb.prepare("SELECT COUNT(*) AS c FROM students").get().c,
      templates: snapDb
        .prepare("SELECT COUNT(*) AS c FROM document_templates")
        .get().c,
      issuedLogs: snapDb.prepare("SELECT COUNT(*) AS c FROM issued_logs").get()
        .c,
      approvalRequests: snapDb
        .prepare("SELECT COUNT(*) AS c FROM approval_requests")
        .get().c,
      printLogs: snapDb.prepare("SELECT COUNT(*) AS c FROM print_logs").get().c,
    };
    return {
      ok: true,
      integrity,
      schemaVersion: snapDb.pragma("user_version", { simple: true }),
      counts,
    };
  } finally {
    snapDb.close();
  }
}

/**
 * Inspects the live SQLite database health without locking writers unnecessarily.
 */
function checkDbHealth(db, dbPath) {
  const quickCheck = db.pragma("quick_check(1)", { simple: true });
  const journalMode = db.pragma("journal_mode", { simple: true });
  const synchronous = db.pragma("synchronous", { simple: true });
  const schemaVersion = db.pragma("user_version", { simple: true });
  const counts = {
    students: db.prepare("SELECT COUNT(*) AS c FROM students").get().c,
    templates: db
      .prepare("SELECT COUNT(*) AS c FROM document_templates")
      .get().c,
    issuedLogs: db.prepare("SELECT COUNT(*) AS c FROM issued_logs").get().c,
    approvalRequests: db
      .prepare("SELECT COUNT(*) AS c FROM approval_requests")
      .get().c,
    printLogs: db.prepare("SELECT COUNT(*) AS c FROM print_logs").get().c,
  };
  let dbBytes = 0;
  let walBytes = 0;
  try {
    if (dbPath && fs.existsSync(dbPath)) {
      dbBytes = fs.statSync(dbPath).size;
    }
    const walPath = dbPath ? `${dbPath}-wal` : "";
    if (walPath && fs.existsSync(walPath)) {
      walBytes = fs.statSync(walPath).size;
    }
  } catch {}
  return {
    ok: quickCheck === "ok",
    quickCheck,
    journalMode: String(journalMode || "").toLowerCase(),
    synchronous: Number(synchronous),
    schemaVersion: Number(schemaVersion || 0),
    dbBytes,
    walBytes,
    counts,
    backupsDir: dbPath ? path.join(path.dirname(dbPath), "backups") : "",
  };
}

module.exports = {
  BACKUP_MAGIC,
  MIN_PASSPHRASE_LENGTH,
  REQUIRED_CORE_TABLES,
  validatePassphrase,
  isEncryptedBackupBuffer,
  isSqliteBuffer,
  encryptBackupBuffer,
  decryptBackupBuffer,
  verifySqliteSnapshot,
  checkDbHealth,
};
