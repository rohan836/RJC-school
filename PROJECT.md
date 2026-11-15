# RJC — School Document Portal

Concise project reference. For Windows 11 setup see [WINDOWS_11_SETUP.md](./WINDOWS_11_SETUP.md), and for complete architecture, database safety, GitHub recovery, and coding agent rules see [PROJECT_WORKFLOW.md](./PROJECT_WORKFLOW.md).

## What it is
An offline-first web app for a school document counter: parents/guardians verify their child, capture collector photo proof, get approval via the Staff Daily Queue or Telegram Bot, and receive an A4 certificate with a tamper-proof bottom verification QR + unique per-sheet Print 2FA code (`PRT-01-…`). Supports **Windows 11 Dual-Monitor Mode** (`Monitor 1 /staff-host` in the staff room, `Monitor 2 /kiosk` at the parent counter).

## Quick facts
| | |
|---|---|
| Project location | `C:\RJC` |
| Application name | RJC — School Document Portal (R. J. Chaware Convent) |
| Stack | Node.js >= 22 · Express 5 · `better-sqlite3` (WAL, `synchronous=FULL`) · `puppeteer-core` |
| Dual-Monitor Routes | `/staff-host` (Monitor 1: Admin + Daily Queue + Auto-Print) · `/kiosk` (Monitor 2: Private Parent Front Panel + QR) · `/teacher` (Mobile staff approvals) |
| Database & Backups | `school.db` (SQLite WAL) + startup `quick_check(1)` + 14-day `backups/auto-*.db` + AES-256-GCM `.rjcbackup` off-PC downloads + `BACKUP_DIR` auto-mirror |
| Port | 3000 (`HOST=0.0.0.0`); admin via `http://localhost:3000/admin` or `/staff-host` |
| Entry points | `Start_Dual_Monitor_Windows11.bat` (2 monitors) · `Start_RJC.bat` (1 monitor) · `Restore_Backup.bat` (verified restore) |

## Layout
| Path | Purpose |
|---|---|
| `server.js` | Express app, APIs, auth/rate limits, startup DB health check, `autoBackup()` + `BACKUP_DIR` mirroring, WAL checkpoint shutdown |
| `db.js` | Schema + additive migrations (`user_version = 3`), demo seeds, `scrypt` hashing |
| `backup-crypto.js` | AES-256-GCM + `scrypt` `.rjcbackup` encryption/decryption, SQLite `integrity_check` & `quick_check` helpers |
| `approval-service.js` | Request approval workflow, sequential serials, HMAC seal assignment, `print_logs` 2FA sheets, scan logs |
| `verification-seal.js` | Cryptographic HMAC document seal (`RJC-...`) and per-sheet `PRT-XX-...` verification |
| `certificate.js` | A4 HTML/PDF renderer with clean body and bottom bordered QR + Print 2FA verification box |
| `data-exchange.js` | All-rounder Excel (`.xlsx`/`.xls`), `.csv`, and `.json` student import/export, filtered log exports, and 5-sheet workbook |
| `telegram.js` / `notify-service.js` / `whatsapp.js` | Telegram Bot approval-only bridge, Email (SMTP), and WhatsApp Cloud notifications |
| `public/dual-monitor.js` | Strict screen isolation (`parent` vs `staff-host`), multi-monitor Chromium launch plan |
| `tools/restore.js` / `Restore_Backup.bat` | Atomic verified restore for `.db` and `.rjcbackup` backups |
| `tools/Export_To_USB.bat` | 1-click Windows USB portable packager with live online DB snapshot |

## Verify & test
- `npm run check` — syntax-checks all modules and runs all `node:test` suites (API/E2E, dual-monitor isolation, approval workflow, crypto seals, backup/restore safety, and multi-viewport admin desktop/mobile layout).
- CI: GitHub Actions on Windows/Ubuntu × Node 22/24 running `npm run check`.

## Git & ignore policy
`.gitignore` excludes `node_modules/`, `portable-node/`, `runtime/`, `data/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`, `backups/`, `*.rjcbackup`, `*.log`, `admin-credentials.txt`, `*.csv`, `.playwright-cli/`. Student databases, backups, and credentials **never** reach GitHub. See [PROJECT_WORKFLOW.md](./PROJECT_WORKFLOW.md) for full GitHub push and crashed-PC recovery commands.

