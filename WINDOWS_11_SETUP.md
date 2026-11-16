# RJC School Document Portal — Windows 11 Setup & 1-Click Integration Guide

This guide explains how to run the **R. J. Chaware Convent (RJC) Document Portal** on **Windows 11** and configure all integrations (Worldwide QR Verification, Physical Printer 2FA, Unlimited Top Teachers & Staff, Telegram Bot + Group Topics, Gmail SMTP Email, and WhatsApp) in minutes.

---

## 1. Quick Start on Windows 11 (2 Minutes)

### Option A — Standard Windows 11 Setup
1. Install **Node.js 22 LTS** from [https://nodejs.org](https://nodejs.org) (keep default options).
2. Open the project folder (e.g. `C:\RJC`) and double-click **`Start_RJC.bat`** (or open PowerShell / Command Prompt in the folder and run):
   ```powershell
   npm run setup
   npm start
   ```
3. The portal automatically opens at **`http://localhost:3000`**.
4. Open **`admin-credentials.txt`** in the project folder to see your initial Admin username and password (default on fresh install: `admin` / `school1234`).

### Option B — Zero-Install USB Portable Mode (Any Windows 11 PC)
- Double-click **`tools\Export_To_USB.bat`** and enter your USB drive letter.
- Plug the USB into any Windows 11 computer and double-click **`RJC_Portable\Start_RJC.bat`**. It includes a portable Node.js binary and a live snapshot of `school.db`.

---

## 2. Making QR Codes Open Anywhere in the World (Permanent Domain Setup)

Every printed certificate has a **Tamper-Proof School Verification QR** inside the bottom bordered box (`/verify/RJC-YYYY-XXXXX?v=...`).

### Method 1 — Production Permanent Domain (Cloudflare Named Tunnel) [RECOMMENDED]
Run your school on permanent branded domains (`https://rjcschool.in` and `https://verify.rjcschool.in`):
1. Run the interactive setup wizard:
   ```cmd
   tools\setup-cloudflare-tunnel.bat
   ```
2. The wizard authenticates Cloudflare, creates the `rjc-school` tunnel, routes both domains, and installs `cloudflared` as an automatic Windows Service (`sc.exe config cloudflared start= auto`) that starts automatically on boot.
3. Strict security controls ensure `/admin`, `/staff-host`, `/kiosk`, and private APIs are strictly blocked from the public internet.
4. Verify anytime with `tools\check-status.bat`.
5. For complete architecture diagrams, DNS settings, and recovery steps, see **[`PERMANENT_DOMAIN_SETUP.md`](./PERMANENT_DOMAIN_SETUP.md)**.

### Method 2 — Temporary Cloudflare Quick Tunnel (Testing / Fallback)
For quick testing without owning a domain:
1. Double-click **`tools\Start_Public_Tunnel.bat`**.
2. It creates a temporary URL (`https://xxxx.trycloudflare.com`) and updates `public-url`. Temporary tunnels regenerate a new URL whenever restarted.

### Method 3 — Manual Domain Configuration
1. Sign in to **Admin → School Branding**.
2. Enter your **Public Portal URL** (`https://rjcschool.in`) and **Public Verify URL** (`https://verify.rjcschool.in`) and click **Save Settings**.
3. Every newly printed and previously issued certificate QR code immediately resolves to the dedicated verification domain.

---

## 3. Physical Printer & 2FA Sheet Cross-Check (`PRT-01-...`)

Every time a certificate is printed or reprinted at the school counter:
- **Clean Certificate Body**: The center of the certificate contains only the official school letterhead and certificate text. No random text or watermarks clutter the middle of the page.
- **Bottom Bordered Verification Box**: All security details are neatly locked inside the bottom bordered box:
  - **Tamper-Proof School Verification QR**
  - **Page & Sheet Number**: `Page 1 of 1 (Sheet #01)` for the 1st print, `Page 1 of 1 (Sheet #02)` for the 2nd print, etc.
  - **Copy Status**: `ORIGINAL COPY · PRINT #1` for the first sheet; `DUPLICATE COPY · PRINT #2`, `#3`, etc. for any subsequent reprint.
  - **Unique Print 2FA Code**: e.g., `PRT-01-9F4A-2C1B` (each physical sheet of paper gets its own cryptographic 2FA code).
  - **Cryptographic Document Seal**: e.g., `RJC-AFZI-HUPI`.
- **Cross-Checking Any Physical Paper**:
  - Scan the QR code on the bottom of the paper (or open `/verify/RJC-YYYY-XXXXX`).
  - Under **2FA Printer & Page Cross-Check (School Database)**, scroll through the complete list of printed copies (`#1 ORIGINAL` through `#N DUPLICATE #N`) or type the `PRT-...` code from the paper to verify which exact copy number, printer, and timestamp produced that sheet.

### Connecting Your Windows 11 Printer
1. In **Admin → Teachers & Printing**, set **Auto-Print Mode**:
   - **Connected PC Browser Auto-Print**: Prints automatically through the open kiosk browser tab (`Start_RJC.bat` launches Chrome/Edge with `--kiosk-printing` for silent counter printing).
   - **Direct OS Printer Spooler**: Sends a generated A4 PDF directly to your Windows 11 printer queue.
2. Enter your **School Printer Name** (e.g., `HP LaserJet Counter` or leave blank for the default Windows printer) and click **Save Bot, Printer & Alerts**.

---

## 4. Adding Unlimited Top Teachers & Staff (1-Click Presets)

You can predefine Top Teachers and Staff from **Admin → Teachers & Printing** or directly from the Telegram Bot:

1. Open **Admin → Teachers & Printing**.
2. Click any of the 5 quick-select slot cards at the top:
   - **Top Slot 1** (defaults to *Principal*)
   - **Top Slot 2** (defaults to *Vice Principal*)
   - **Top Slot 3** (defaults to *Headmaster*)
   - **+ Top Teacher** (*Additional Unlimited Top Teachers* — add as many senior/top teachers as you want)
   - **+ Staff** (*Unlimited Staff* — add as many office clerks/staff as you want)
3. Enter the Teacher/Staff **Name**, choose a **Predefined Title** (or type a custom title), and optionally set a **4–8 Digit PIN** so they can unlock the **Front Panel → Daily Queue** popup on the school computer or sign in at `/teacher` on their phone.
4. Click **Save Teacher / Staff**.

---

## 5. Telegram Bot & Organized Group/Channel Setup

### Step 1 — Create Your School Bot (1 Minute)
1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`, choose a name (e.g., `RJC School Approval Bot`), and copy the **Bot Token** (`123456789:ABC...`).
3. Paste the token into **Admin → Teachers & Printing → Telegram Bot Token**, set a **Staff Join Code** (e.g., `RJC2026`), and click **Save Bot, Printer & Alerts**.
4. Click **Test Bot** to confirm connection.

### Step 2 — Link Teachers & Staff in 1 Tap
- Teachers open your bot in Telegram and send:
  ```text
  /join RJC2026
  ```
- The bot displays **1-tap buttons** showing all predefined names from Admin (plus buttons to join as Top Slot 1–3, Additional Top Teacher, or Staff). One tap links their Telegram account!

### Step 3 — Link a School Archive Group or Channel (with Optional Topic Subfolders)
- Add the bot as an **Admin** to your school's private Telegram Group or Channel.
- Send `/setgroup RJC2026` inside the group (or `/setchannel RJC2026` inside the channel).
- **Privacy Guarantee**: The certificate wording/PDF is **never** sent to Telegram; certificates live strictly on the school computer. Telegram receives only the collector's live face photo, collector role, student/request metadata, supporting notebook/application upload (if any), and the Verification QR card.
- **Optional Topic Subfolders**: If you enable **Topics** in your Telegram Supergroup, you can paste the Topic IDs into **1-Click Setup → Pending Topic ID / Approved & QR Topic ID / QR Scan Alerts Topic ID** so requests, approvals, and live QR scan alerts are sorted into separate folders automatically.

---

## 6. 1-Click Parent Notifications (Gmail SMTP Email & WhatsApp)

When a teacher or staff member approves a certificate, the parent is notified to collect the stamped paper copy from the school office counter (no online PDF is sent).

### A. 1-Click School Gmail SMTP Setup
1. Open **Admin → Teachers & Printing** and expand **1-Click Setup: Global QR Domain, Gmail SMTP, WhatsApp & Telegram Topics**.
2. Click **Use Gmail Preset (587)** — this automatically fills `smtp.gmail.com` and port `587`.
3. Enter your school Gmail address in **SMTP Email / Username** and your 16-character [Google App Password](https://myaccount.google.com/apppasswords) in **SMTP App Password**.
4. Click **Save Bot, Printer & Alerts**, then click **Test Email** to verify.

### B. WhatsApp Ready Notifications (2 Ways)
1. **Instant 1-Click WhatsApp Web (`wa.me`) — Zero API Keys Needed**:
   - In **Admin → Teachers & Printing** (Print Queue table), every approved request has a **WhatsApp Ready ↗** link that opens WhatsApp with a pre-filled ready message to the parent's phone number.
2. **Automatic WhatsApp Cloud API (Optional)**:
   - Open **1-Click Setup** in **Admin → Teachers & Printing**, enter your **WhatsApp Phone Number ID** and **WhatsApp Cloud Access Token**, and click **Save**. Parents will automatically receive a WhatsApp message the moment their certificate is approved.

---

## 8. Dual-Monitor Setup on One Windows 11 PC (Staff Room Monitor + Parent Counter Monitor)

You can connect **two monitors** to a single Windows 11 school PC so that staff and parents each have their own dedicated, isolated screen:

- **Monitor 1 (Inside Staff Room — `/staff-host` or `/?screen=admin`)**:
  - Shows **only** the **Admin Panel** and **Daily Applications Queue** (`#front-desk-btn`).
  - Handles silent automatic printing (`--kiosk-printing`) on the connected school counter printer.
- **Monitor 2 (Parent Counter Window — `/kiosk` or `/?screen=parent`)**:
  - Shows **only** the **Phone QR Code** and the **Parent Front Panel** wizard.
  - **Strict Isolation**: The Admin Panel, Daily Applications Queue, and navigation buttons are completely hidden and blocked on Monitor 2.
  - **Per-Parent Privacy Lock**:
    - Each parent sees **only their own application** and live 3-stage approval/print status (`1. Request Sent` → `2. Teacher / Staff Review` → `3. School Counter Print` + `Print & 2FA Sheet` status) bound to their own private session token.
    - `Recent entries (quick fill)` is disabled and wiped on Monitor 2 so the next person in line can **never** see a previous parent's GR number, birth month, birth year, or application.
    - Includes a **Clear / New Parent** button in the top bar and an automatic session reset (`25s` after print completion) so the screen is always clean for the next parent.

### Step-by-Step Windows 11 Dual-Monitor Setup:
1. Connect both monitors to your Windows 11 PC (e.g. HDMI + DisplayPort / VGA).
2. Press **Windows + P** and select **Extend** so Monitor 1 is in the staff room (left/primary display at `0,0`) and Monitor 2 is at the parent counter (extended display to the right at `1920,0`).
3. Double-click **`Start_Dual_Monitor_Windows11.bat`** in the project folder.
   - It automatically starts the local school server and opens two isolated Chrome/Edge windows with separate browser profiles:
     - **Monitor 1 (`0,0`)**: `http://localhost:3000/staff-host` with `--kiosk-printing`
     - **Monitor 2 (`1920,0`)**: `http://localhost:3000/kiosk` in frameless `--app` mode
   - *(Tip: If your primary monitor resolution is `1366x768` instead of `1920x1080`, you can pass `--parent-monitor-x=1366` or drag the Parent Counter window onto Monitor 2 and press **F11** for full-screen.)*

