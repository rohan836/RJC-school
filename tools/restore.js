#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const Database = require("better-sqlite3");
const {
  isEncryptedBackupBuffer,
  isSqliteBuffer,
  decryptBackupBuffer,
  verifySqliteSnapshot,
} = require("../backup-crypto");

function parseArgs(argv) {
  const opts = { backupPath: "", passphrase: "", dataDir: "" };
  for (const arg of argv) {
    if (arg.startsWith("--data-dir=")) {
      opts.dataDir = arg.slice("--data-dir=".length);
    } else if (arg.startsWith("--passphrase=")) {
      opts.passphrase = arg.slice("--passphrase=".length);
    } else if (!opts.backupPath) {
      opts.backupPath = arg;
    } else if (!opts.passphrase) {
      opts.passphrase = arg;
    }
  }
  return opts;
}

/**
 * Safely restores school.db from either a plain SQLite backup (.db) or an
 * encrypted RJC backup (.rjcbackup). Verifies integrity on a temporary copy
 * before touching the live database and saves a pre-restore safety snapshot.
 */
async function restoreDatabaseFromBackup({
  backupPath,
  dataDir,
  passphrase = "",
  DatabaseCtor = Database,
}) {
  const resolvedBackup = path.resolve(backupPath);
  if (!fs.existsSync(resolvedBackup)) {
    throw new Error(`Backup file not found: ${resolvedBackup}`);
  }
  const targetDir = path.resolve(
    dataDir || process.env.KIOSK_DATA_DIR || path.resolve(__dirname, ".."),
  );
  fs.mkdirSync(targetDir, { recursive: true });
  const targetDb = path.join(targetDir, "school.db");
  const backupsDir = path.join(targetDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });

  const rawBytes = fs.readFileSync(resolvedBackup);
  let sqliteBytes;
  let wasEncrypted = false;
  if (isEncryptedBackupBuffer(rawBytes)) {
    wasEncrypted = true;
    sqliteBytes = decryptBackupBuffer(rawBytes, passphrase);
  } else if (isSqliteBuffer(rawBytes)) {
    sqliteBytes = rawBytes;
  } else {
    throw new Error(
      "Unsupported file. Select a .rjcbackup or SQLite .db backup file.",
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-restore-"));
  const tempDb = path.join(tempDir, "verified.db");
  try {
    fs.writeFileSync(tempDb, sqliteBytes);
    const verified = verifySqliteSnapshot(DatabaseCtor, tempDb);

    let preRestoreFile = "";
    if (fs.existsSync(targetDb)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      preRestoreFile = path.join(backupsDir, `pre-restore-${ts}.db`);
      const existingDb = new DatabaseCtor(targetDb, { readonly: true });
      try {
        await existingDb.backup(preRestoreFile);
      } finally {
        existingDb.close();
      }
    }

    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = targetDb + suffix;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }

    const stagingTarget = path.join(targetDir, `.school.restore-${process.pid}.db`);
    fs.copyFileSync(tempDb, stagingTarget);
    fs.renameSync(stagingTarget, targetDb);

    // Put restored DB cleanly back into WAL + synchronous=FULL mode and verify once more.
    const reopened = new DatabaseCtor(targetDb);
    try {
      reopened.pragma("journal_mode = WAL");
      reopened.pragma("synchronous = FULL");
      const postCheck = reopened.pragma("integrity_check", { simple: true });
      if (postCheck !== "ok") {
        throw new Error(`Post-restore integrity check failed: ${postCheck}`);
      }
    } finally {
      reopened.close();
    }

    return {
      ok: true,
      targetDb,
      wasEncrypted,
      preRestoreFile,
      counts: verified.counts,
      schemaVersion: verified.schemaVersion,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.backupPath) {
    console.log(
      "Usage:\n  node tools/restore.js <backup-file.db|.rjcbackup> [passphrase] [--data-dir=PATH]\n",
    );
    process.exit(1);
  }
  const resolved = path.resolve(opts.backupPath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const head = Buffer.alloc(8);
  const fd = fs.openSync(resolved, "r");
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  let passphrase = opts.passphrase;
  if (head.toString("ascii") === "RJCBAK01" && !passphrase) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      passphrase = await rl.question("Enter backup decryption passphrase: ");
    } finally {
      rl.close();
    }
  }
  const result = await restoreDatabaseFromBackup({
    backupPath: resolved,
    dataDir: opts.dataDir,
    passphrase,
  });
  console.log("\nRestore verified and completed!");
  console.log(`  Database:   ${result.targetDb}`);
  console.log(`  Encrypted:  ${result.wasEncrypted ? "Yes (AES-256-GCM)" : "No (.db snapshot)"}`);
  if (result.preRestoreFile) {
    console.log(`  Saved old:  ${result.preRestoreFile}`);
  }
  console.log(
    `  Records:    ${result.counts.students} students · ${result.counts.issuedLogs} issued logs · ${result.counts.approvalRequests} approvals · ${result.counts.printLogs} prints`,
  );
  console.log("\nStart the portal now with Start_RJC.bat or Start_Dual_Monitor_Windows11.bat.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Restore failed:", err?.message || err);
    process.exit(1);
  });
}

module.exports = { restoreDatabaseFromBackup };
