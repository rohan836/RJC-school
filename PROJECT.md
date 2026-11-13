# RGC — School Document Portal

Concise project reference. For full operations details see [README.md](./README.md).

## What it is
An offline-first web app for a school document counter: parents/guardians scan a QR, verify their child, and instantly get a printed, signed, QR-verifiable certificate (Marathi / Hindi / English). Runs on one Windows PC and serves parents over the school Wi-Fi. No internet required for core operation.

## Quick facts
| | |
|---|---|
| Project location | `C:\RJC` |
| Application name | RJC — School Document Portal (R. J. Chaware Convent) |
| Stack | Node.js ≥ 22 (v26.13.0) · Express 5 · better-sqlite3 (WAL, synchronous FULL) · puppeteer-core (system Chrome/Edge for PDFs) |
| Frontend | Single-page `public/index.html` — two views: Front Panel (parent wizard + live QR) · Admin (no build step, no framework) |
| Database | `school.db` (SQLite, WAL) — seeded demo records; admin stored as scrypt hash |
| Port | 3000 (`HOST=0.0.0.0`); admin via `http://localhost:3000/admin` |
| Repository | Private GitHub: `rohan836/school-document-kiosk`, branch `main`, pushed 2026-11-13 |
| Entry point | `server.js` (`npm start`) |

## Two run modes
**1. Permanent (this PC, `C:\RJC`)**
- `Start_Server_Silent.vbs` starts the server hidden in the background; a shortcut sits in the **Startup folder** and launches it at login.
- `Start_RJC.bat` (also on the **Desktop**) starts the server if port 3000 is free, then opens Chrome/Edge in `--kiosk --kiosk-printing` mode. Works from any drive; uses `portable-node\node.exe` if present, else system `node`.

**2. USB portable (any Windows PC, no Node.js)**
- Double-click `tools/Export_To_USB.bat`, enter the USB drive letter → creates `<USB>:\RJC_Portable\` with the app, `node_modules`, a matching `portable-node\node.exe` (identical Node build, so the native better-sqlite3 works), a clean `school.db` snapshot via SQLite's online backup API, and `admin-credentials.txt` if present.
- On the target PC: plug in the stick → double-click `RJC_Portable\Start_RJC.bat`. No installation. Verify: tested end-to-end on a SUBST'd virtual drive.

## Layout
| Path | Purpose |
|---|---|
| `server.js` | Express app: LAN/IP detection, rotating 4-digit campus code (60 s + after each issuance), all API routes, admin auth, webhook wiring |
| `student-search.js` | Server-side fuzzy ranking for student names, GR numbers, registered phones and class/division queries |
| `db.js` | Schema + additive migrations, demo seeds, scrypt hashing, credential file |
| `certificate.js` | A4 HTML certificate renderer + PDF via puppeteer-core; UDISE normalization |
| `whatsapp.js` | Meta WhatsApp Cloud API bot (trilingual, HMAC-signed webhooks, retry-safe issuance) — **not configured** (needs Meta credentials) |
| `public/index.html` | The whole UI: parent wizard with unified student search, voice guidance (local voices preferred, any matching voice as fallback), admin 5 tabs. Desktop-first layout — header and workspace are `width: 94%; max-width: 1380px`, with a wide certificate preview and multi-column admin grids; single column below 860 px |
| `public/fonts/` | Bundled Noto Sans Devanagari (offline) |
| `backups/` | `pre-upgrade-*.db`, `qa/`, `previous-project/` archive, **auto-YYYY-MM-DD.db** (automatic, keeps 14) |
| `Start_school_kiosk.bat` → calls `Start_RJC.bat` | Wrapper |

## Database & data
Tables: `students` (6 records, GR 4501–4506) · `document_templates` (3, all active) · `admin_users` (1, scrypt) · `school_settings` (seeded R. J. Chaware Convent branding; logo/signature/stamp and Wi-Fi **not set**) · `issued_logs` · `verification_attempts` · `webhook_receipts`. Migrations via `user_version = 2` (v2 replaced the placeholder Nashik branding with the real school identity and added GR 4506). `issued_logs` is the permanent audit trail. `udise_no` is normalized (no double "UDISE:" prefix).

## Security model (local school network)
- Live campus code shown only on the school monitor; rotates every 60 s and after each issuance.
- Family verification = birth year (primary) or exact date of birth + registered parent mobile last-4 (detailed check); both paths share a 3-attempt / 15-minute lockout persisted in `verification_attempts` (survives restarts). GR means General Register, the school's student record number; parents can search by name without knowing it.
- LAN requests must present the campus code; localhost connections bypass it. Host-header allowlist, origin checks, strict CSP, `no-store`, 300 req/min `/api` rate limit, 15/15-min admin-login limit.
- Admin: single `admin` account; 30-min sessions; 10+ char passwords; change signs out all sessions; credentials file is local and gitignored (never print it).
- Certificates carry a verification QR (`/verify/<serial>` — confirms reference exists; not a fraud-proof of altered prints). PDF download tokens last 5 minutes. Raw bodies never leave the school; WhatsApp bot (if configured) also requires sender = registered parent number.

## Verify & test
- `npm run check` — syntax-checks server/db/certificate/whatsapp + runs 11 isolated tests: parent/Admin API and browser flows, mobile layout, fuzzy search and privacy-safe references, both verification methods and persisted lockouts, branding migration, serial/UDISE and A4 PDF output, campus rotation, public-host restrictions, CSV/backup authorization, and signed WhatsApp simulation with retry deduplication.
- CI: GitHub Actions on Windows/Ubuntu × Node 22/24 running `npm run check`; Dependabot weekly (npm + actions).

## Git & ignore policy
Private repo `rohan836/school-document-kiosk`, `main` in sync with `origin/main`. `.gitignore` excludes `node_modules/`, `portable-node/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`, `backups/`, `*.log`, `admin-credentials.txt`. Databases, backups, and credentials **never** reach GitHub.

## Before official use (known gaps)
Replace the remaining demo students (GR 4501–4505) with real records; upload the school logo/signature/stamp PNGs and Wi-Fi credentials; enter the correct UDISE number (the placeholder Nashik code was removed by the branding migration, so the field is empty until set in Admin → Branding & Portal); test the physical printer and signature/stamp placement; install Windows Marathi/Hindi speech-voice packs (else the app falls back to any matching voice or reports missing voices); enable LAN firewall rule for Node.js; HTTP only on LAN — never expose the portal publicly; WhatsApp automation needs Meta business setup + public HTTPS webhook (untested); Fee Clearance template assumes office confirmation (no fee ledger); only one admin account (no per-staff roles).

## Troubleshooting
| Symptom | Fix |
|---|---|
| Port 3000 already in use | `Start_RJC.bat` detects a listening port and skips starting; manually close the old server first |
| Server won't start / crashed | `node server.js` — read the console message; check `C:\RJC` is writable and `school.db` isn't open exclusively elsewhere |
| Voice guidance unavailable | Windows → Time & Language → Speech → install Marathi/Hindi voices; app falls back to any matching voice, else reports unavailable |
| USB stick on a foreign PC | Boot into `RJC_Portable` (double-click `Start_RJC.bat`); if `portable-node\node.exe` is missing, re-export from this PC |
| DB corruption suspicion | Server uses WAL + synchronous FULL; daily auto-backups live in `backups/auto-YYYY-MM-DD.db` (14 kept) plus manual snapshots; restore only with the server stopped |


Current Windows entry point: double-click `C:\RJC\Start_RJC.bat` (or the desktop shortcut). It verifies the running app belongs to this folder before reusing port 3000. The obsolete BAT/VBS launchers and automatic-start shortcut are archived in ignored `backups/old-launchers/`. Utility BATs are under `tools/`. Browser opens in a normal window; no kiosk profile is reused.
