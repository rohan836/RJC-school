#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = __dirname;
const majorNode = Number(process.versions.node.split(".")[0]);

console.log("\nRJC — School Document Portal · Cross-Platform Setup\n");

if (majorNode < 22) {
  console.error(
    `Node.js 22 or newer is required (detected ${process.version}).\nDownload Node.js LTS from https://nodejs.org/`,
  );
  process.exit(1);
}
console.log(`✓ Node.js ${process.version} (${process.platform}/${process.arch})`);

const nodeModulesDir = path.join(root, "node_modules");
let depsReady = fs.existsSync(path.join(nodeModulesDir, "express"));
if (depsReady) {
  try {
    require("better-sqlite3");
  } catch {
    depsReady = false;
  }
}

if (!depsReady) {
  console.log("Installing npm dependencies...");
  const cmd = fs.existsSync(path.join(root, "package-lock.json"))
    ? "npm ci --no-audit --no-fund"
    : "npm install --no-audit --no-fund";
  execSync(cmd, { cwd: root, stdio: "inherit" });
} else {
  console.log("✓ Dependencies already installed");
}

const envPath = path.join(root, ".env");
const envExamplePath = path.join(root, ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  fs.copyFileSync(envExamplePath, envPath);
  console.log("✓ Created .env from .env.example");
} else if (fs.existsSync(envPath)) {
  console.log("✓ .env file present");
}

const dataDir = process.env.KIOSK_DATA_DIR || root;
const { openDatabase } = require("./db");
const db = openDatabase(dataDir);
db.close();
console.log(`✓ SQLite database ready at ${path.join(dataDir, "school.db")}`);

const credPath = path.join(dataDir, "admin-credentials.txt");
if (fs.existsSync(credPath)) {
  console.log(`✓ Admin credentials file: ${credPath}`);
}

const { browserPath } = require("./certificate");
const browser = browserPath();
if (browser) {
  console.log(`✓ Browser PDF engine detected: ${browser}`);
} else {
  console.log(
    "ℹ Chrome/Edge not detected — built-in PDF generator will be used automatically.",
  );
}

console.log(`
Setup complete! Next steps:
  • Start portal & open browser:  node tools/launch.js
  • Start server only:            npm start
  • Windows double-click:         Start_RJC.bat
  • macOS double-click:           Start_RJC.command
  • Linux / macOS terminal:       ./start.sh
`);
