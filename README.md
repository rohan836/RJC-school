# RJC — School Document Portal

The active project lives in **RJC**. RJC is the application name, for **R. J. Chaware Convent** (Jain Minority Institute · Karanja Education Society's · Chaware Line, Karanja (Lad), Dist. Washim, Maharashtra 444105). The old project remains archived under the ignored `backups/previous-project` directory.

## Permanent install at C:\RJC & USB portable package

The project lives at **C:\RJC**. On this PC, `Start_Server_Silent.vbs` starts the server hidden in the background (a shortcut sits in the Startup folder, pointing at `C:\RJC`), and `Start_RJC.bat` (also on the Desktop) starts the server if port 3000 is free and opens Chrome/Edge in `--kiosk --kiosk-printing` mode. `Start_RJC.bat` works from any drive — it uses `cd /d "%~dp0"` and prefers a bundled `portable-node\node.exe`, falling back to system Node.js.

For a **USB plug-and-play copy** (for a PC without Node.js): double-click `tools/Export_To_USB.bat` on this PC and enter the USB drive letter. It creates `<USB>:\RJC_Portable\` with the app, `node_modules`, a matching portable `portable-node\node.exe` (same Node build, so the native better-sqlite3 module works), a clean `school.db` snapshot produced with SQLite's online backup API, and `admin-credentials.txt` if present. Plug the USB stick into any Windows PC and double-click `RJC_Portable\Start_RJC.bat` — no installation required. `portable-node/` and `*.db` are gitignored and never pushed to GitHub. The same helper is noted in **Admin → Security & Backup**.

## Set up on any computer (from GitHub)

1. Install **Node.js 22 LTS** or newer (plus Chrome or Edge for full Devanagari PDF rendering; a built-in PDF generator works as a fallback if neither is installed).
2. Clone the repository and run the one-step setup:
   ```bash
   git clone <your-repo-url>
   cd RJC-school
   npm run setup
   ```
   `npm run setup` installs dependencies, creates `.env` from `.env.example`, initializes `school.db` and `admin-credentials.txt`, and checks PDF readiness.
3. Launch the portal:
   - **Windows 11 / 10**: Double-click `Start_RJC.bat` (auto-runs setup on first launch if needed).
   - **macOS**: Double-click `Start_RJC.command` (or run `./start.sh` in Terminal).
   - **Linux / Terminal**: Run `./start.sh` or `npm start` and open `http://localhost:3000`.
4. Sign in through **Admin** or `http://localhost:3000/admin` using the username/password in `admin-credentials.txt`. Fresh databases use `admin / school1234`; an existing password is preserved. Change it under **Security & Backup** before entering real records. The updated password is stored only as a scrypt hash.

The server detects a LAN IPv4 address and prints the phone portal URL on startup. Parents must connect to the **same school Wi-Fi**. If your OS firewall asks, permit Node.js on the school's private network. Do not expose the whole portal to the public internet. Router client isolation or a firewall can block access between devices. With multiple network adapters, set `LAN_IP` in `.env` to the address your phones can reach. Restart after changing networks or configuration. A phone's localhost refers to the phone, not this PC.

## Test records

| GR   | Student                | Birth year | Demo Aadhaar last four | Registered mobile |
| ---- | ---------------------- | ---------- | ---------------------- | ----------------- |
| 4501 | Aarav Sunil Patil      | 2013       | 1234                   | 9822011111        |
| 4502 | Ananya Rajesh Deshmukh | 2011       | 2345                   | 9822022222        |
| 4503 | Sai Mahesh Shinde      | 2012       | 3456                   | 9822033333        |
| 4504 | Swarali Sandeep Jadhav | 2014       | 4567                   | 9822044444        |
| 4505 | Vedant Nitin Pawar     | 2015       | 5678                   | 9822055555        |
| 4506 | Vedant Vivek Deoda     | 2013       | —                      | 9423128313        |

These are synthetic demonstration records, not actual Aadhaar information. Migration preserves existing student records, school settings, passwords, templates and issued logs. It fills demo Aadhaar suffixes only for matching demo names. Replace demo records before issuing official documents. GR 4506 (from the school identity card) has no demo Aadhaar suffix; the parent portal's detailed check uses date of birth and registered mobile instead.

## Parent and counter flows

Choose Marathi, Hindi or English; search by student or father name, registered mobile, GR number, class, or division. Fuzzy search handles partial queries and common letter or digit mistakes. GR means General Register, the school’s student record number; parents can search by name without knowing it. Verify with the child’s birth year, or use the detailed check with full date of birth and the last four digits of the registered parent mobile. Visiting guardians also provide a contact number, which is recorded in the audit log.

The kiosk is designed for a desktop monitor at 100% zoom. The header and workspace use `width: 94%; max-width: 1380px`, so the portal fills a 1080p or 1440p screen without a narrow boxed card. Steps 2 and 3 provide a unified search box and a verification form. Step 4 shows a wide A4 preview beside large Print / Download PDF / WhatsApp / Done buttons. Every admin tab uses the same wide multi-column grids. Below 860 px the layout collapses to a single column so a phone scanning the QR code still stacks cleanly.

Three incorrect family-verification attempts lock the student record for 15 minutes, including across server restarts. The backup route does not bypass the lock. A localhost/127.0.0.1 front-panel connection can bypass the campus code; a LAN request cannot obtain that bypass by setting the client flag. Campus codes rotate every 60 seconds and after each issuance. Only the Front Panel PC (localhost) can retrieve the live code and QR; the panel polls once a second and uses Data URLs.

### Phones on any internet (Cloudflare quick tunnel)
The Front Panel shows **one** QR. By default it encodes `http://<LAN_IP>:3000/?code=####` (offline, school Wi-Fi only). To let parents connect on any internet (4G/5G or Wi-Fi) without any LAN connection:
1. Install Cloudflare Tunnel (`winget install Cloudflare.cloudflared` or place `cloudflared.exe` in this folder).
2. Double-click `tools/Start_Public_Tunnel.bat`. It starts a free quick tunnel and writes the live `https://<name>.trycloudflare.com` URL to `public-url`, which the server automatically uses for the single QR (and prints as "Portal link" on startup). `public-url` is deleted when the tunnel stops.
3. Alternatively set `PUBLIC_PORTAL_URL` in `.env`, or **Admin → Branding & Portal → Public tunnel URL** (admin override wins; leave blank for .env, tunnel auto-detection, or LAN fallback).

On the tunnel host, only the parent portal is reachable (`/`, `/fonts/*`, `/api/public-config`, `/api/search-student`, `/api/generate-document`, `/api/documents/:serial/pdf`, `/verify/:serial`). `/admin`, `/api/admin/*` and `/api/campus-code` remain available on localhost/school office only. Verification needs no SMS or WhatsApp OTP: parents use the 60-second campus code plus the child's birth year, or the detailed check with full date of birth and the registered parent mobile's last four digits. Search results do not return GR numbers or phone suffixes; selections use short-lived opaque references. The tunnel is a public doorway — it is free ("quick" tunnels), changes URL on each restart, and requires no account; do not expose student data beyond the parent portal.

The browser clears student information on Done, after printing, after 45 seconds on the completed document, or after 45 seconds of inactivity during earlier steps. The official audit log remains in the database. Download access uses a random token valid for five minutes; the browser discards its copy when the session clears. Certificate QR verification is available on the school network and displays only the reference, document title and issue date. It confirms an existing reference, not the authenticity of altered printed details.

Speaker buttons **prefer installed local (offline) speechSynthesis voices** for the chosen language. If no offline Windows voice pack is installed for it, the app falls back to any available voice for the same language (which may use the network) and only reports a missing voice when none exists at all. Install Marathi/Hindi speech voices through Windows language settings while online for the full offline experience.

PDF generation uses installed Chrome/Edge through Puppeteer Core, with external network requests blocked. Set `CHROME_PATH` if the executable is elsewhere. Printing uses A4 margins and the normal system printer configuration; `--kiosk-printing` uses the browser's default printer without the normal print dialog. Test your physical printer and signature/stamp placement before official use. Long certificates can span more than one page. The browser's WhatsApp button shares details and a verification link, not the PDF attachment; Meta integration below sends the actual PDF.

## Admin

- **Students Manager:** Search, add/edit, deactivate, CSV import and sample CSV download. Deactivation preserves audit history; edit a record to reactivate it. Store only the last four Aadhaar digits. CSV columns: `gr_number,full_name,father_name,class_name,division,dob,aadhaar_last4,parent_phone`. Dates are DD/MM/YYYY; mobile numbers have ten digits. Imports validate every row before a transaction; matching GR numbers are updated.
- **Templates Builder:** Create/edit all three titles and localized bodies, insert placeholders, set signature/stamp positions, toggle availability or delete. The live A4 preview uses sample details. Only basic safe HTML is retained. Issued certificates keep a snapshot, so later edits do not rewrite their content. The seeded Fee Clearance template assumes the office has confirmed fees; this app does not contain a fee ledger. Disable that template if parents must obtain separate fee approval.
- **Branding & Portal:** School header, UDISE, WhatsApp contact, optional Public tunnel URL override (blank = auto-detect tunnel, else LAN), and logo/signature/stamp PNG upload, preview and removal. PNGs must be at most 1.5 MB and 6000 × 6000 pixels.
- **Issued Logs:** Search the complete register and open verification pages.
- **Security & Backup:** Change the password with current-password confirmation and create a consistent SQLite backup without stopping the app. Admin sessions expire after 30 minutes and lock after 15 minutes of inactivity.

## WhatsApp Business Cloud API

The kiosk does not need this integration to operate offline. **WhatsApp requires internet, a Meta business phone number, an access token and a public HTTPS webhook.** No Meta account was configured or live message sent during setup.

1. Copy `.env.example` to `.env`. Set `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, and a supported `WHATSAPP_API_VERSION` (the example uses v25.0). Set `PUBLIC_WEBHOOK_URL` to the public HTTPS webhook URL and restart.
2. Configure a reverse proxy/tunnel to forward **only `/webhook`** to the PC. The app also rejects other paths requested using the configured public webhook hostname. Never forward the admin or parent portal publicly.
3. In Meta, configure that callback URL and the same verify token, then subscribe to incoming messages. Follow [Meta's webhook setup](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/) and [WhatsApp messaging documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/).
4. Send Hi to the registered business number. Choose language, enter the registered mobile number, choose the student, enter birth year and the current campus code, and choose a certificate. The WhatsApp sender must match the registered parent number. On success the service renders and uploads a PDF, sends it as a document, and clears the in-memory session immediately. Chat sessions otherwise expire after five minutes. Family verification shares the same lockout as the web portal.

GET `/webhook` validates the configured verify token. POST validates the raw request's HMAC SHA-256 signature. Message IDs are recorded for seven days for retry deduplication. A failed delivery can retry the same issued certificate instead of issuing another one. Per-sender processing is serialized. Tests exercise the complete conversation with a simulated Meta transport; a real delivery test still requires your credentials and Meta configuration.

## Data, backups and source control

SQLite uses WAL, synchronous FULL and a busy timeout. These improve power-loss durability but cannot guarantee safety against storage or hardware failure. Security & Backup creates timestamped snapshots in `RJC/backups/` through SQLite's backup API. In addition, the server creates an automatic backup in `backups/` named `auto-YYYY-MM-DD.db` (10 seconds after startup when today's is missing, then every 24 hours), keeping the 14 most recent automatic backups. Keep secure copies on separate storage. Restore only with the server stopped; never copy a live database without its WAL files. The pre-upgrade backup is kept under `backups/`.

`.gitignore` excludes dependencies, `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite`, `*.sqlite3`, `*.csv`, `.env`, `admin-credentials.txt`, logs, backups and test artifacts. `.env.example` contains no credentials. Do not add student exports or screenshots of real records to source control. Restrict access to this Windows account and school Wi-Fi; LAN traffic currently uses HTTP. The primary birth-year check is limited proof of identity; the detailed check uses a full date of birth and an undisclosed registered-phone suffix. No independent security audit or physical-printer certification is implied.

## Development and verification

`npm run check` checks server/module syntax and runs only `test/*.test.js` (the archived project's tests are excluded). Integration tests cover fuzzy search ranking, privacy-safe student references, both verification methods, authorization, code rotation after issuance, persisted lockouts, data migration/restart, CSV transactions, QR decoding, localized documents, PDF bytes, backups, host/origin restrictions and browser interaction with external requests blocked. WhatsApp tests use signed callbacks, multilingual flows, delivery retries and session clearing. With Chrome/Edge installed, UI checks cover the parent journey, mobile search results, auto-wipe, responsive layout and all five admin tabs. Set `KIOSK_QA_DIR` to an ignored path such as `backups/qa` to save test screenshots.

GitHub CI runs checks on Windows/Linux with Node 22/24. Dependabot checks npm dependencies and Actions weekly. Production use still needs a check on your intended phones, speech voices, Wi-Fi and physical printer, plus live Meta verification if using WhatsApp automation.


Current Windows entry point: double-click `C:\RJC\Start_RJC.bat` (or the desktop shortcut). It verifies the running app belongs to this folder before reusing port 3000. The obsolete BAT/VBS launchers and automatic-start shortcut are archived in ignored `backups/old-launchers/`. Utility BATs are under `tools/`. Browser opens in a normal window; no kiosk profile is reused.
