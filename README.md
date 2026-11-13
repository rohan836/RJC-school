# RGC — School Document Portal

The active project lives in **RJC**. RGC is the application name. The old project remains archived under the ignored `backups/previous-project` directory.

## Permanent install at C:\RJC & USB portable package

The project lives at **C:\RJC**. On this PC, `Start_Server_Silent.vbs` starts the server hidden in the background (a shortcut sits in the Startup folder, pointing at `C:\RJC`), and `Start_RGC_Kiosk.bat` (also on the Desktop) starts the server if port 3000 is free and opens Chrome/Edge in `--kiosk --kiosk-printing` mode. `Start_RGC_Kiosk.bat` works from any drive — it uses `cd /d "%~dp0"` and prefers a bundled `portable-node\node.exe`, falling back to system Node.js.

For a **USB plug-and-play copy** (for a PC without Node.js): double-click `Export_To_USB.bat` on this PC and enter the USB drive letter. It creates `<USB>:\RJC_Portable\` with the app, `node_modules`, a matching portable `portable-node\node.exe` (same Node build, so the native better-sqlite3 module works), a clean `school.db` snapshot produced with SQLite's online backup API, and `admin-credentials.txt` if present. Plug the USB stick into any Windows PC and double-click `RJC_Portable\Start_RGC_Kiosk.bat` — no installation required. `portable-node/` and `*.db` are gitignored and never pushed to GitHub. The same helper is noted in **Admin → Security & Backup**.

## Start on this PC
1. Install Node.js 22 or 24 LTS and Chrome or Edge.
2. Run `npm ci` once while online. All application assets, QR generation, fonts and PDF rendering then work without internet.
3. Run `npm start` and open http://localhost:3000. For full-screen kiosk printing, double-click `Start_RGC_Kiosk.bat`. Close an existing server before launching a new one.
4. Sign in through **Admin** or http://localhost:3000/admin using the username/password in `admin-credentials.txt`. Fresh databases use `admin / school1234`; an existing password is preserved. Change it under Security & Backup before entering real records. The updated password is stored only as a scrypt hash.

The server detects a LAN IPv4 address and prints the phone portal URL on startup. Parents must connect to the **same school Wi-Fi**. If Windows asks, permit Node.js on the school's private network. Do not expose the whole portal to the public internet. Router client isolation or a firewall can block access between devices. With multiple network adapters, set `LAN_IP` in `.env` to the address your phones can reach. Restart after changing networks or configuration. A phone's localhost refers to the phone, not this PC.

## Test records

| GR   | Student                | Birth year | Demo Aadhaar last four | Registered mobile |
| ---- | ---------------------- | ---------- | ---------------------- | ----------------- |
| 4501 | Aarav Sunil Patil      | 2013       | 1234                   | 9822011111        |
| 4502 | Ananya Rajesh Deshmukh | 2011       | 2345                   | 9822022222        |
| 4503 | Sai Mahesh Shinde      | 2012       | 3456                   | 9822033333        |
| 4504 | Swarali Sandeep Jadhav | 2014       | 4567                   | 9822044444        |
| 4505 | Vedant Nitin Pawar     | 2015       | 5678                   | 9822055555        |

These are synthetic demonstration records, not actual Aadhaar information. Migration preserves existing student records, school settings, passwords, templates and issued logs. It fills demo Aadhaar suffixes only for matching demo names. Replace demo records and school branding before issuing official documents.

## Parent and counter flows

Choose Marathi, Hindi or English; search by registered mobile or class/division/name; verify with birth year or GR plus Aadhaar last four; select a document; print, download a real PDF or share its details through WhatsApp. The mouse numpad enters digits into the focused numeric field. Guardian collection requires a contact number, birth year and GR number and is flagged in the audit log.

Three incorrect family-verification attempts lock the student record for 15 minutes, including across server restarts. The backup route does not bypass the lock. A localhost/127.0.0.1 monitor connection can bypass the campus code; a LAN request cannot obtain that bypass by setting the client flag. Campus codes rotate every 60 seconds and after each issuance. Only the school monitor can retrieve the live code and Wi-Fi QR. The monitor polls once a second and uses Data URLs for both QR images.

The browser clears student information on Done, after printing, after 45 seconds on the completed document, or after 45 seconds of inactivity during earlier steps. The official audit log remains in the database. Download access uses a random token valid for five minutes; the browser discards its copy when the session clears. Certificate QR verification is available on the school network and displays only the reference, document title and issue date. It confirms an existing reference, not the authenticity of altered printed details.

Speaker buttons **prefer installed local (offline) speechSynthesis voices** for the chosen language. If no offline Windows voice pack is installed for it, the app falls back to any available voice for the same language (which may use the network) and only reports a missing voice when none exists at all. Install Marathi/Hindi speech voices through Windows language settings while online for the full offline experience.

PDF generation uses installed Chrome/Edge through Puppeteer Core, with external network requests blocked. Set `CHROME_PATH` if the executable is elsewhere. Printing uses A4 margins and the normal system printer configuration; `--kiosk-printing` uses the browser's default printer without the normal print dialog. Test your physical printer and signature/stamp placement before official use. Long certificates can span more than one page. The browser's WhatsApp button shares details and a verification link, not the PDF attachment; Meta integration below sends the actual PDF.

## Admin

- **Students Manager:** Search, add/edit, deactivate, CSV import and sample CSV download. Deactivation preserves audit history; edit a record to reactivate it. Store only the last four Aadhaar digits. CSV columns: `gr_number,full_name,father_name,class_name,division,dob,aadhaar_last4,parent_phone`. Dates are DD/MM/YYYY; mobile numbers have ten digits. Imports validate every row before a transaction; matching GR numbers are updated.
- **Templates Builder:** Create/edit all three titles and localized bodies, insert placeholders, set signature/stamp positions, toggle availability or delete. The live A4 preview uses sample details. Only basic safe HTML is retained. Issued certificates keep a snapshot, so later edits do not rewrite their content. The seeded Fee Clearance template assumes the office has confirmed fees; this app does not contain a fee ledger. Disable that template if parents must obtain separate fee approval.
- **Branding & Wi-Fi:** School header, UDISE, WhatsApp contact, Wi-Fi SSID/password and logo/signature/stamp PNG upload, preview and removal. PNGs must be at most 1.5 MB and 6000 × 6000 pixels. The Wi-Fi QR intentionally contains the configured Wi-Fi credentials.
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

`.gitignore` excludes dependencies, `*.db`, `*.db-wal`, `*.db-shm`, `.env`, `admin-credentials.txt`, logs, backups and test artifacts. `.env.example` contains no credentials. Do not add student exports or screenshots of real records to source control. Restrict access to this Windows account and school Wi-Fi; LAN traffic currently uses HTTP. Verification by birth year or Aadhaar suffix is limited proof of identity, so supervise sensitive issuance. No independent security audit or physical-printer certification is implied.

## Development and verification

`npm run check` checks server/module syntax and runs only `test/*.test.js` (the archived project's tests are excluded). Integration tests cover all application API routes, authorization, code rotation after issuance, persisted lockouts, data migration/restart, CSV transactions, QR decoding, localized documents, PDF bytes, backups, host/origin restrictions and browser interaction with external requests blocked. WhatsApp tests use signed callbacks, multilingual flows, delivery retries and session clearing. With Chrome/Edge installed, UI checks cover the parent journey, numpad, auto-wipe, responsive layout and all five admin tabs. Set `KIOSK_QA_DIR` to an ignored path such as `backups/qa` to save test screenshots.

GitHub CI runs checks on Windows/Linux with Node 22/24. Dependabot checks npm dependencies and Actions weekly. Production use still needs a check on your intended phones, speech voices, Wi-Fi and physical printer, plus live Meta verification if using WhatsApp automation.
