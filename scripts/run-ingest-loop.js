#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");

const HOURS = Number(process.env.INGEST_LOOP_HOURS || process.argv[2] || 6);
const intervalMs = Math.max(1, HOURS) * 60 * 60 * 1000;
const projectRoot = path.resolve(__dirname, "..");
const ingestScript = path.join(projectRoot, "scripts", "run-ingest-local.js");

function ts() {
  return new Date().toISOString();
}

function runOnce() {
  return new Promise((resolve) => {
    console.log(`[${ts()}] Starting local ingest run...`);
    const child = spawn(process.execPath, [ingestScript], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.on("close", (code) => {
      console.log(`[${ts()}] Ingest run finished with exit code ${code}`);
      resolve(code);
    });
  });
}

async function main() {
  console.log(`[${ts()}] Ingest loop started. Interval: every ${HOURS} hour(s).`);
  await runOnce();
  setInterval(async () => {
    await runOnce();
  }, intervalMs);
}

main().catch((err) => {
  console.error(`[${ts()}] Ingest loop failed:`, err?.stack || err?.message || err);
  process.exit(1);
});

