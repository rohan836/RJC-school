# RJC School Document Portal — Complete Architecture, Security & Workflow Guide

> **For Future AI Coding Agents & School Maintainers**
> Read this file first before modifying any module, database table, UI tab, launcher, or backup flow.

---

## 1. System Architecture Overview

RJC School Document Portal is an **offline-first, local-first Windows 11 school counter system** built on **Node.js (>= 22)**, **Express 5**, **SQLite (`better-sqlite3` in WAL + `synchronous=FULL` mode)**, and **Puppeteer-Core (Edge/Chrome A4 PDF & kiosk auto-printing)** with zero frontend build step (`public/index.html`).

### Core Design Principles
1. **Student data stays on the school PC**: Raw student records, Aadhaar suffixes, guardian mobile numbers, collector camera photos, and generated PDFs live strictly inside local `school.db` and never leave to third-party servers or Telegram.
2. **Telegram is Approval-Only**: Remote teachers receive approval summaries and captured collector face photos in Telegram (`/approve_<id>`, `/reject_<id>`) or the staff web portal (`/teacher`) — full certificates never travel through Telegram.
3. **Every Physical Sheet Is Cryptographically Tracked (2FA)**:
   - Every issued document gets a unique serial (`RJC-YYYY-XXXXX`), HMAC-SHA256 `doc_signature`, and short `security_code` (`RJC-XXXX-XXXX`).
   - Every physical sheet printed (`#1 ORIGINAL`, `#2 DUPLICATE #2`, etc.) receives a distinct `print_security_code` (`PRT-01-XXXX-XXXX`), `print_token`, and `page_no` (`Page 1 of 1 (Sheet #01)`), locked inside the **bottom bordered verification box** of the A4 page.
   - Scanning the QR (`/verify/:serial?v=...&p=...&c=...`) lets anyone verify authenticity worldwide and cross-check any printed sheet code (`PRT-...`) against `print_logs`.
4. **Dual-Monitor Hardware Isolation (Windows 11)**:
   - **Monitor 1 (`/staff-host`)**: Staff Room PC monitor — Admin Panel, Daily Queue, Print Queue, `--kiosk-printing` auto-print poller.
   - **Monitor 2 (`/kiosk` or `/parent-screen`)**: Parent Counter display — QR Code + Private Parent Front Panel only. Admin tabs, Daily Queue, and cross-parent `localStorage` history are strictly blocked on Monitor 2, and sessions auto-clear 25s after print or on clicking **Clear / New Parent**.

---

## 2. Module Map (File-by-File)

| File | Responsibility | Pure/Test Notes |
|---|---|---|
| `server.js` | Express 5 server, all REST APIs, rate limits, host/origin security, `autoBackup()`, WAL checkpoint shutdown | Runs on `PORT=3000`, `HOST=0.0.0.0` |
| `db.js` | SQLite WAL + `synchronous=FULL` initialization, additive schema migrations (`PRAGMA user_version = 3`), scrypt password hashing | **Never drop columns/tables**; increment `user_version` for new migrations |
| `backup-crypto.js` | AES-256-GCM + `scrypt` encryption/decryption (`RJCBAK01` `.rjcbackup`), SQLite `integrity_check` & `quick_check` | Pure/unit-tested in `test/backup-and-crash-safety.test.js` |
| `approval-service.js` | Request state machine (`PENDING` -> `APPROVED`/`REJECTED`), sequential serials, HMAC seal assignment, print copy tracking (`print_logs`), scan logging | Tested in `test/approval-workflow.test.js` |
| `verification-seal.js` | HMAC-SHA256 document seal & per-sheet `PRT-XX-XXXX-XXXX` 2FA seal computation and verification | Pure/unit-tested in `test/verification-seal.test.js` |
| `certificate.js` | A4 certificate HTML & Chrome/Edge PDF generation, bottom bordered verification box, UDISE formatting | Supports bundled `@fontsource/noto-sans-devanagari` |
| `data-exchange.js` | Multi-format Excel (`.xlsx`/`.xls`), `.csv`, `.json` student import/export, filtered log exports & 5-sheet portal workbook | Pure/unit-tested in `test/data-exchange-and-ux.test.js` |
| `parent-auth.js` | Birth-year / exact-DOB + phone verification, guardian one-time QR tokens, 3-attempt / 15-min DB-persisted lockout | Backed by `verification_attempts` table |
| `student-search.js` | Fuzzy search ranking across name, GR number, class/division, registered mobile (privacy-safe ref tokens) | Pure ranking logic |
| `print-queue.js` | Browser kiosk print polling + optional Windows OS print spooler dispatch | Auto-print runs ONLY on `/staff-host` or `standard` mode |
| `telegram.js` | Long-polling Telegram bot, `/join`, `/setgroup`, `/setchannel`, `/approve_`, `/reject_`, group/forum topic routing | Never leaks raw certificates |
| `notify-service.js` | Optional Email (Nodemailer SMTP / Gmail preset) and Meta WhatsApp ready alerts | Triggered after approval/print |
| `whatsapp.js` | Meta WhatsApp Cloud API OTP transport & webhook signature verification | HMAC-verified webhooks |
| `zip-export.js` | Streaming ZIP archive generator for yearly audit exports (`/api/admin/logs/archive`) | Zero external zip binary needed |
| `public/index.html` | Single-file UI for Parent Wizard, Staff Daily Queue, Admin Dashboard (6 tabs), and Verify Page | **Layout test constraint** — see Section 6 |
| `public/dual-monitor.js` | UMD module resolving screen mode (`parent` vs `staff-host` vs `standard`), strict UI/storage isolation, Chrome multi-window args | Unit-tested in `test/dual-monitor.test.js` |
| `public/face-check.js` | Permissive collector face-presence & low-light camera capture helper | No over-strict blink/pose lockouts |
| `public/keypad-history.js` | Counter keypad history (automatically disabled in `parent` / `/kiosk` mode) | Privacy-isolated |
| `public/teacher.html` | Mobile-friendly Teacher Approval Portal (`/teacher`) | PIN-authenticated |
| `tools/launch.js` | Cross-platform Chrome/Edge launcher (`--dual-monitor` places Monitor 1 at `0,0` and Monitor 2 at `primaryWidth,0`) | Creates isolated browser profiles in `data/profiles/` |
| `tools/restore.js` | Atomic verified CLI database restore for `.db` and `.rjcbackup` files | Paired with `Restore_Backup.bat` |
| `tools/Export_To_USB.bat` | 1-click Windows USB portable package builder (bundles runtime, `node_modules`, and online DB snapshot) | Re-copies all modular `.js` & `.bat` files |
| `tools/Start_Public_Tunnel.bat` | Launches `cloudflared` HTTPS tunnel and writes `public-url` so printed QR codes work on any network | Optional when school has no static domain |

---

## 3. End-to-End Document Request, Approval & Print Workflow

```
Parent Counter (/kiosk) or Phone QR
  │
  ├─► 1. Student Lookup (fuzzy search -> opaque 15-min studentRef token)
  ├─► 2. Family Verification (Birth Year or DOB + Parent Mobile Last 4 · 3 fails = 15m lockout)
  │        OR Counter Guardian 10-min QR Approval
  ├─► 3. Live Collector Photo Capture (non-strict low-light camera check) + Reason + Optional Doc
  │
  ▼
POST /api/parent/request ──► approval_requests (status = 'PENDING')
  │
  ├──► Telegram Bot (Teachers Group / Topics + Top Teachers if template requires)
  ├──► Staff Room Monitor 1 (/staff-host) Live Daily Queue Modal
  └──► Teacher Mobile Portal (/teacher)
  │
  ▼  Teacher/Admin approves (PIN or Telegram /approve_<id>)
approveRequest() inside DB transaction:
  ├─ Generates Serial (RJC-YYYY-XXXXX), HMAC doc_signature, security_code (RJC-XXXX-XXXX)
  ├─ Inserts permanent record into issued_logs
  └─ Marks approval_requests APPROVED + print_status = 'QUEUED'
  │
  ▼
Monitor 1 (/staff-host) Auto-Print Poller (or 2-Step Staff Counter Confirm):
  ├─ Assigns Copy #N (ORIGINAL for #1, DUPLICATE #N for reprints)
  ├─ Computes unique Print 2FA Code (PRT-0N-XXXX-XXXX) & Page 1 of 1 (Sheet #0N)
  ├─ Records row in print_logs
  ├─ Prints A4 PDF via Edge/Chrome --kiosk-printing with bottom bordered QR + 2FA box
  ├─ Updates Monitor 2 (/kiosk) Step 6 via polling (shows only THIS parent's own request status)
  └─ Fires optional WhatsApp / Gmail ready notification
```

---

## 4. Database Safety & PC-Crash Protection Model

### Is the database safe against crashes and tampering?
**Yes — for a single-PC school server, the architecture is crash-safe and tamper-evident, provided you mirror backups off the PC drive.**

#### Built-In Crash & Security Protections
1. **SQLite WAL + `synchronous = FULL`** (`db.js`): Every committed transaction is fsynced to disk. Sudden Windows power loss or forced reboot cannot corrupt committed records; uncommitted writes roll back cleanly on next open.
2. **Startup Integrity Self-Check** (`server.js` + `backup-crypto.js`): Every startup runs `PRAGMA quick_check(1)` and logs `[DB OK]` or `[DB WARNING]`.
3. **Clean Shutdown WAL Checkpoint**: `SIGINT`/`SIGTERM` triggers `PRAGMA wal_checkpoint(TRUNCATE)` before `db.close()`.
4. **Online Snapshots Only (`db.backup()`)**: Never copy `school.db` manually with Explorer while the server runs. Both automatic backups, manual backups, USB exports, and encrypted downloads use SQLite's online backup API + `verifySqliteSnapshot()` (`PRAGMA integrity_check === 'ok'` + 7-table schema validation).
5. **Authenticated Off-PC Encrypted Backups (`.rjcbackup`)**:
   - **Algorithm**: `scrypt` key derivation (`N=16384, r=8, p=1`, 16-byte salt) + **AES-256-GCM** (12-byte IV, 16-byte authentication tag, AAD = `RJCBAK01`).
   - Wrong passphrase or single-byte corruption is rejected automatically before any restore touches `school.db`.
   - Safe to store on **Google Drive, OneDrive, school email, or an external USB stick** without exposing student PII.
6. **Automatic Off-PC Mirroring via `.env`**:
   - Set `BACKUP_DIR=D:\RJC_Backups` (or `C:\Users\<User>\OneDrive\RJC_Backups` / Google Drive Desktop folder) and `BACKUP_PASSPHRASE=<8+ char secret>` in `.env`.
   - Every daily auto-backup and manual backup automatically verifies and writes an encrypted `.rjcbackup` copy to `BACKUP_DIR`, keeping 14 rolling daily copies.
7. **Verified Atomic Restore (`Restore_Backup.bat` / `tools/restore.js`)**:
   - Decrypts & verifies `PRAGMA integrity_check` in a temp directory **first**.
   - Archives the current `school.db` to `backups/pre-restore-<timestamp>.db`.
   - Clears stale `-wal`/`-shm` sidecars and swaps cleanly.

### Critical Windows 11 Operational Rule
- **Do not rely solely on `C:\RJC\backups\`**: If the PC's SSD physically dies, files on `C:\` die with it. Always enable **one** off-PC backup target:
  1. OneDrive / Google Drive synced folder in `BACKUP_DIR` + `BACKUP_PASSPHRASE` in `.env`, **OR**
  2. Weekly download of `.rjcbackup` from **Admin → Security & Backup → Download encrypted**, **OR**
  3. Weekly run of **`tools\Export_To_USB.bat`** onto a locked office USB drive.

---

## 5. GitHub Repository Safety & Crashed-PC Recovery Runbook

### What goes on GitHub (Safe & Clean)
`.gitignore` guarantees **zero student data or secrets** are ever pushed to GitHub:
- Ignored: `school.db`, `*.db-wal`, `*.db-shm`, `backups/`, `*.rjcbackup`, `.env`, `admin-credentials.txt`, `*.csv`, `data/`, `node_modules/`, `portable-node/`, `runtime/`, `public-url`, `*.log`, `.playwright-cli/`.
- **Important**: Always keep the GitHub repository **Private** as an extra safeguard.

### Initial Push to GitHub (First Time Setup on School PC)
```powershell
cd C:\RJC
git init
git branch -M main
git add .
git status   # Verify NO .db, .env, .csv, backups/, or admin-credentials.txt appear!
git commit -m "RJC School Document Portal ready for Windows 11 dual-monitor & encrypted backup"
git remote add origin https://github.com/<your-username>/<your-private-repo>.git
git push -u origin main
```

### Full Recovery After a PC Crash (New / Wiped Windows 11 PC)
1. Install **Node.js 22 LTS** and **Git for Windows** (`winget install OpenJS.NodeJS.LTS Git.Git`).
2. Pull the exact working portal from GitHub:
   ```powershell
   git clone https://github.com/<your-username>/<your-private-repo>.git C:\RJC
   cd C:\RJC
   npm run setup
   ```
3. Restore your student records, issued history, templates, and Print 2FA logs from your latest off-PC backup (`rjc-school-backup-YYYY-MM-DD.rjcbackup` from Drive/USB):
   - Double-click **`Restore_Backup.bat`** (or run `node tools\restore.js "D:\Backups\rjc-school-backup-2026-11-15.rjcbackup"`).
   - Enter your backup decryption passphrase.
4. Copy back your `.env` secrets (if using Telegram/SMTP/WhatsApp) or configure them in Admin UI.
5. Double-click **`Start_Dual_Monitor_Windows11.bat`** (or `Start_RJC.bat`). **Back online in under 5 minutes.**

---

## 6. Agent Rules & Mandatory Checklist Before Any Commit/PR

Future AI agents modifying this repo MUST follow these invariants:
1. **Desktop Admin Vertical Fit (`test/admin-layout.test.js`)**:
   - Every desktop admin tab (`students`, `templates`, `branding`, `logs`, `security`) must fit inside `1366x768`, `1440x900`, and `1920x1080` with `documentElement.scrollHeight <= innerHeight + 1` and zero horizontal overflow (`scrollWidth <= innerWidth`), with primary action buttons (`#student-form button.primary`, `#template-form button.primary`, `#branding-form button.primary`, `#refresh-logs`, `#backup-button`) visible above the fold.
2. **Additive Schema Migrations Only**:
   - Add new columns/tables inside `db.js` guarded by `PRAGMA table_info(...)` and bump `PRAGMA user_version`. Never break existing `school.db` backups restored from older dates!
3. **Dual-Monitor Privacy Invariant**:
   - `/kiosk` (`parent` screen mode) must never reveal Admin tabs, Daily Queue, or previous parent data in `localStorage`.
   - `/api/parent/request-status/:id` requires the matching `x-parent-token`.
4. **Full Verification Gate**:
   - Run `npm run check` (runs syntax checks across all server/client modules + all `node:test` suites in `test/*.test.js`).
   - All tests must pass 100% with exit code 0 before pushing to GitHub or deploying.

---

## 7. Real-World Deployment Checklist & Recommended Future Upgrades

### Before Go-Live at the School Counter
- [ ] Replace seeded demo students (`GR 4501–4506`) with real CSV student import in **Admin → Students**.
- [ ] Change default `admin` password (`school1234`) in **Admin → Security & Backup** (10+ characters) and delete or lock `admin-credentials.txt`.
- [ ] Upload official school logo, Principal signature PNG, and school stamp PNG, plus real **UDISE number** in **Admin → Branding & Portal**.
- [ ] Configure **Public School Domain** (e.g. Cloudflare Tunnel via `tools/Start_Public_Tunnel.bat` or custom HTTPS domain) so printed QRs scan on any mobile network.
- [ ] Configure `BACKUP_DIR` (Google Drive / OneDrive synced folder or secondary drive `D:\RJC_Backups`) and `BACKUP_PASSPHRASE` in `.env` so off-PC encrypted backups run automatically every day.
- [ ] Print 1 real Bonafide test copy on the Windows 11 school printer and scan its bottom QR code from a phone on 4G/5G data.

### Simple High-Impact Future Improvements (Backlog)
1. **Windows Task Scheduler Auto-Start + Sleep Disable**: Register `Start_Dual_Monitor_Windows11.bat` at Windows sign-in and disable sleep on the counter PC so parents can use the kiosk all day without lockouts.
2. **BitLocker Drive Encryption**: Turn on Windows 11 Device Encryption / BitLocker on `C:\` so physical theft of the PC cannot expose `school.db`.
3. **UPS (Uninterruptible Power Supply)**: Connect the counter PC and printer to a 600VA+ UPS; WAL protects committed data, while a UPS prevents mid-print jams during voltage drops.
4. **Periodic Test-Restore Drill**: Once a month, run `node tools/restore.js <latest.rjcbackup> --data-dir=%TEMP%\rjc-drill` to confirm your passphrase works and your backup restores cleanly.
