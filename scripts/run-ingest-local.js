#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  loadEnvFile(path.join(projectRoot, ".env"));
  loadEnvFile(path.join(projectRoot, ".env.local"));

  const ingestHandler = require(path.join(projectRoot, "api", "ingest.js"));
  const key = String(process.env.INGEST_SECRET || "").trim();

  const req = {
    method: "GET",
    headers: key ? { "x-ingest-key": key } : {},
    query: key ? { key } : {},
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(payload) {
      this.body = payload;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return this;
    },
    send(payload) {
      this.body = payload;
      process.stdout.write(`${String(payload)}\n`);
      return this;
    },
  };

  await ingestHandler(req, res);
  if (res.statusCode >= 400) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Local ingest failed:", err?.stack || err?.message || err);
  process.exit(1);
});

