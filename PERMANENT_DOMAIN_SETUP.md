# RJC School — Permanent Public Domain & Cloudflare Named Tunnel Setup Guide

This guide details the complete production architecture, manual setup instructions, automated scripts, security policies, and disaster recovery procedures for running **R. J. Chaware Convent** with a permanent public domain (`https://rjcschool.in` and `https://verify.rjcschool.in`).

---

## 1. System Architecture

```
                       [ Public Internet / Parent Smartphone ]
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
         https://rjcschool.in                      https://verify.rjcschool.in
     (Parent Document Portal)                   (Certificate Verification Portal)
                    │                                         │
                    └────────────────────┬────────────────────┘
                                         ▼
                            [ Cloudflare Edge DNS & SSL ]
                                         │
                        (Encrypted Cloudflare Named Tunnel)
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │     RJC Windows 11 School PC          │
                     │  (cloudflared Windows Service / Auto) │
                     │                   │                   │
                     │                   ▼                   │
                     │      http://localhost:3000            │
                     │    Node.js Express Application        │
                     │                   │                   │
                     │                   ▼                   │
                     │       SQLite WAL Database             │
                     │       (C:\RJC\data\school.db)         │
                     └───────────────────────────────────────┘
```

### Core Architecture Principles
1. **Local-First Data Sovereignity:** All student records, issued certificates, and SQLite WAL database files remain **strictly local** on the school PC (`localhost:3000`). No student data, SQLite files, or application processes are hosted on the cloud.
2. **Dual-Domain Separation:**
   - **`https://rjcschool.in/`**: Primary public parent and student portal for searching student records, completing 2FA, capturing face proof, and submitting certificate requests.
   - **`https://verify.rjcschool.in/`**: Dedicated verification portal. Resolves clean URLs (`/:serial` and `/verify/:serial`) and features a public certificate lookup search box and digital seal verification.
3. **Public Route Isolation & Lockdown:**
   - Public traffic arriving from Cloudflare or Quick Tunnels is strictly restricted.
   - **BLOCKED from Public Access:** `/admin`, `/staff-host`, `/kiosk`, `/parent-screen`, `/api/admin/*`, `/api/campus-code`, `/api/kiosk/*`, `/api/counter/*`, `/api/backup/*`, student data exports.
   - **Teacher Panel (`/teacher`):** Private by default. Public access is allowed only when `ALLOW_PUBLIC_TEACHER=true` or enabled via Admin School Branding settings.
   - **Local Counter / Staff Room:** Full access to all administration features, campus code rotation, daily approval desk, and dual-monitor controls is preserved when accessing from `localhost` or LAN.
4. **Offline / LAN Fallback:** The application operates 100% offline on the local school network (`http://localhost:3000` or `http://<LAN_IP>:3000`) even if the internet connection or Cloudflare goes down.

---

## 2. Prerequisites & Domain Registration

> [!NOTE]
> Domain registration itself is **not free**. The school must purchase and register the domain name (`rjcschool.in` or similar) through an accredited registrar. The Cloudflare Tunnel software and basic DNS/proxy services are **free**.

### Recommended Registrars
- **Cloudflare Registrar:** (At-cost pricing, automatic nameserver configuration)
- **Namecheap / GoDaddy / BigRock / Porkbun:** Any standard registrar that allows setting custom nameservers.

---

## 3. Step-by-Step Setup Instructions

### Step 1: Add Domain to Cloudflare
1. Sign in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Click **Add a Site** and enter your registered domain (e.g., `rjcschool.in`).
3. Select the **Free Plan** and click **Continue**.
4. Cloudflare will scan existing DNS records and provide two Cloudflare nameservers (e.g., `aria.ns.cloudflare.com` and `dane.ns.cloudflare.com`).
5. Log in to your domain registrar (where you bought `rjcschool.in`) and replace the default nameservers with the Cloudflare nameservers provided.
6. Wait 5–30 minutes for DNS propagation until Cloudflare shows **Status: Active**.

---

### Step 2: Install and Authenticate `cloudflared`
The project bundles the `cloudflared.exe` binary in `C:\RJC\tools\cloudflared.exe`.

1. Open PowerShell or Command Prompt as **Administrator**:
   ```cmd
   cd C:\RJC
   ```
2. Authenticate the CLI with your Cloudflare account:
   ```cmd
   tools\cloudflared.exe tunnel login
   ```
3. A web browser will open automatically. Sign in and select your domain (`rjcschool.in`) to grant authorization.
4. Cloudflare will write an authentication certificate to `%USERPROFILE%\.cloudflared\cert.pem`.

---

### Step 3: Create the Named Tunnel
Run the following command to create a named tunnel named `rjc-school`:
```cmd
tools\cloudflared.exe tunnel create rjc-school
```
This output displays your unique Tunnel UUID:
```
Tunnel credentials written to C:\Users\LaNcer\.cloudflared\<TUNNEL-UUID>.json.
Created tunnel rjc-school with id <TUNNEL-UUID>
```

---

### Step 4: Configure Multi-Host Ingress Routing
Create or edit `%USERPROFILE%\.cloudflared\config.yml` (replace `<TUNNEL-UUID>` with your actual Tunnel UUID):

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\Users\LaNcer\.cloudflared\<TUNNEL-UUID>.json

ingress:
  # Primary Parent / Student Document Portal
  - hostname: rjcschool.in
    service: http://localhost:3000

  # Dedicated Certificate Verification Portal
  - hostname: verify.rjcschool.in
    service: http://localhost:3000

  # Catch-all rule (required)
  - service: http_status:404
```

---

### Step 5: Route Cloudflare DNS Records
Associate both domains with your named tunnel:
```cmd
tools\cloudflared.exe tunnel route dns rjc-school rjcschool.in
tools\cloudflared.exe tunnel route dns rjc-school verify.rjcschool.in
```
This automatically creates `CNAME` records in your Cloudflare DNS dashboard pointing both hostnames to `<TUNNEL-UUID>.cfargotunnel.com`.

---

### Step 6: Install `cloudflared` as an Automatic Windows Service
To ensure the tunnel starts automatically when Windows 11 boots (even after a reboot or power outage):
```cmd
tools\cloudflared.exe service install
sc.exe config cloudflared start= auto
sc.exe start cloudflared
```
To verify the service is running:
```cmd
sc.exe query cloudflared
```

---

### Step 7: Update Application Configuration
Update the `.env` file in `C:\RJC`:
```env
PUBLIC_PORTAL_URL=https://rjcschool.in
PUBLIC_VERIFY_URL=https://verify.rjcschool.in
ALLOW_PUBLIC_TEACHER=false
```
Or open the Admin Panel at `http://localhost:3000/admin`, navigate to the **School Branding** tab, enter the **Public Portal URL** and **Public Verify URL**, and click **Save Settings**.

---

## 4. Automated Setup Script

For convenience, you can run the one-click interactive setup wizard:
```cmd
C:\RJC\tools\setup-cloudflare-tunnel.bat
```
This script handles:
- Locating `cloudflared.exe`.
- Prompting for your domain name (defaults to `rjcschool.in`).
- Launching Cloudflare browser login.
- Creating the `rjc-school` tunnel.
- Generating `%USERPROFILE%\.cloudflared\config.yml` with dual-domain ingress rules.
- Creating DNS route records for `rjcschool.in` and `verify.rjcschool.in`.
- Installing and configuring the Windows service (`sc.exe config cloudflared start= auto`).
- Updating `.env` with the permanent URLs.

---

## 5. System Status & Verification

### Built-in CLI Diagnostics Tool
Run the status checker anytime to verify local and public health:
```cmd
C:\RJC\tools\check-status.bat
```
Or with Node.js directly:
```cmd
node tools/check-status.js
```
The tool validates:
- [x] Local Node.js server health on port 3000.
- [x] SQLite database WAL mode and student count.
- [x] Local LAN IP address.
- [x] Internet connectivity and ping latency (1.1.1.1 probe).
- [x] Public portal reachability (`https://rjcschool.in`).
- [x] Public verification portal reachability (`https://verify.rjcschool.in`).
- [x] Cloudflare process (`cloudflared.exe`) and Windows Service status.

### Admin Dashboard Diagnostics
1. Sign in to `http://localhost:3000/admin`.
2. Go to the **School Branding** tab.
3. Open the **Cloudflare Named Tunnel & Security Diagnostics** panel.
4. Click **Test Status** for real-time diagnostic indicators:
   - `Server: Port 3000 (PID xxxx)`
   - `DB: HEALTHY (xxx Students)`
   - `Cloudflare: Service Running`
   - `Internet: Online (xx ms)`
   - `Public Portal: Reachable`
   - `Verify Portal: Reachable`

---

## 6. Backward Compatibility & Fallback Options

### LAN & Offline Mode
If internet service is interrupted:
- School staff can access the portal locally at `http://localhost:3000` or `http://<LAN_IP>:3000`.
- Dual-monitor kiosk and counter operations continue uninterrupted.
- Certificates can still be approved, generated, printed, and exported to USB.

### Cloudflare Quick Tunnel Fallback
For testing or emergency temporary access without a custom domain:
```cmd
C:\RJC\tools\Start_Public_Tunnel.bat
```
This generates a temporary `*.trycloudflare.com` URL that automatically binds to the front panel QR code.

---

## 7. Disaster Recovery & PC Replacement

In the event of hardware failure:
1. **Restore Code & Database:**
   - Clone or copy the project to `C:\RJC` on the new Windows 11 PC.
   - Restore the SQLite database from your latest encrypted backup using:
     ```cmd
     node tools/restore.js <path-to-encrypted-backup.rjcbackup>
     ```
2. **Re-link Cloudflare Tunnel:**
   - Re-run `tools\cloudflared.exe tunnel login`.
   - Copy or recreate `%USERPROFILE%\.cloudflared\config.yml`.
   - Reinstall the service:
     ```cmd
     tools\cloudflared.exe service install
     sc.exe config cloudflared start= auto
     sc.exe start cloudflared
     ```
3. **Verify:** Run `tools\check-status.bat` to confirm everything is operational.

---

## 8. Swapping or Updating the Domain Name

If the school chooses a different domain (e.g., `rjchawareconvent.edu.in`):
1. Add the new domain to Cloudflare.
2. Route the DNS for the new domain:
   ```cmd
   tools\cloudflared.exe tunnel route dns rjc-school rjchawareconvent.edu.in
   tools\cloudflared.exe tunnel route dns rjc-school verify.rjchawareconvent.edu.in
   ```
3. Update `config.yml` hostnames to match the new domains.
4. Update `.env` with the new `PUBLIC_PORTAL_URL` and `PUBLIC_VERIFY_URL`.
5. Restart the cloudflared service:
   ```cmd
   sc.exe stop cloudflared
   sc.exe start cloudflared
   ```
