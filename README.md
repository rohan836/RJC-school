# Offline School Document Kiosk

Run `npm ci` once with internet access using Node.js 22 or 24 LTS. Then double-click `Start_School_Kiosk.bat` or run `npm start` and open http://localhost:3000. The application, QR renderer, font files, SQLite database, certificate preview and printing run locally without internet.

Initial administrator: **admin / school1234**. Change this in Admin before entering real student records. Admin tokens expire after 30 minutes; inactivity locks the panel after 45 seconds. Changing the password invalidates existing tokens. The initial password is seeded only on an empty database.

Sample records: GR **4501**, birth year **2013**, mobile **9822011111**; GR **4502**, birth year **2011**, mobile **9822022222**; GR **4503**, birth year **2012**, mobile **9822033333**.

## Features

Marathi/Hindi/English parent selection, phone or name search, masked phone numbers, birth-year verification, guardian contact logging, rotating campus display, A4 certificate preview, positioned signature/stamp images, school logo, offline verification QR, administrator student editing/archiving, quoted CSV imports, sanitized HTML templates, audit logs and online SQLite backups. The CSV header is `gr_number,full_name,father_name,class_name,division,dob,parent_phone`; dates use DD/MM/YYYY and mobile numbers use ten digits. Imports validate every row before applying an atomic transaction.

The server listens on 127.0.0.1 only. A local kiosk bypass requires both the client flag and a loopback connection. Campus codes and QR links are available only on this PC; scanning localhost links on a different phone will not reach this server. Remote access requires a separately designed authenticated LAN deployment. A short campus code and birth year are not strong identity proof. Staff should supervise sensitive issuance.

WhatsApp sharing requires internet and shares certificate details, not a PDF attachment. `window.print()` opens the normal print dialog; silent printing requires a separately configured browser kiosk policy. Long documents may span multiple A4 pages. Test the physical printer, logo and signature before issuing official certificates.

## Data and durability

`school.db` uses WAL, synchronous FULL and a busy timeout. These improve transaction durability but cannot guarantee safety against every hardware, filesystem or power failure. Use Admin → Create local database backup for a consistent SQLite backup in `backups/`, then copy backups to secure storage. Restore only with the server stopped. Do not copy a live database without its WAL files. The default browser does not protect against other users with access to this Windows account: lock down the PC and account appropriately.

`.gitignore` excludes dependencies, all *.db / *.db-wal / *.db-shm files, `.env`, logs and backups. Do not upload student exports, screenshots containing student details, or other private files. The `.env` file is ignored but is not automatically loaded. Optional environment variables: `PORT` and `KIOSK_DATA_DIR`.

## Checks

Run `npm run check` for syntax and integration tests covering authorization, validation, issuance, QR, imports, backup integrity, sanitization and password changes. GitHub CI runs on Windows/Linux and Node 22/24; Dependabot checks npm and Actions weekly. Test browser and printer behavior on the intended hardware before production operation. A passing test suite is not an independent security audit.
