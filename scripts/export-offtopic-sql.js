#!/usr/bin/env node
const fs = require("fs");
const { getAnonClient } = require("../lib/supabase");

function hasDeepfakeSignal(text) {
  return /(deepfake|deep fake|voice clone|cloned voice|vocal clone|synthetic voice|voice deepfake|audio deepfake|fake audio|fake video|face swap|synthetic media|ai impersonation|ai song|ai[- ]generated song|soundalike|mimic(?:ked|ry)? voice|ai porn|non-consensual|digital forgery|manipulated media)/i.test(
    String(text || "")
  );
}

function isLowValueGuideRow(row) {
  const t = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
  const guidePattern =
    /(deepfakemaker|deepfake maker|face swap|how to|practical guide|guide to|tutorial|choosing the perfect|turn any clip|viral ai video|free unlimited|reaction gif)/i;
  const strongIncidentPattern =
    /(victim|victimized|lawsuit|sued|arrest|charged|jailed|banned|ban|removed|takedown|scam|fraud|impersonation|child porn|non-consensual|court|acquitted)/i;
  return guidePattern.test(t) && !strongIncidentPattern.test(t);
}

function isAudioTagged(row) {
  return (
    String(row.category || "").toLowerCase() === "audio" ||
    /voice clone|audio deepfake|synthetic voice/i.test(String(row.category_label || ""))
  );
}

function shouldDelete(row) {
  if (isLowValueGuideRow(row)) return true;
  const sourceType = String(row.source_type || "").toLowerCase();
  if (sourceType === "factcheck") return false;
  if (isAudioTagged(row)) return false;
  const titleUrlHay = `${row.title || ""} ${row.article_url || ""} ${row.claim_url || ""}`;
  if (sourceType === "news" && !hasDeepfakeSignal(titleUrlHay)) return true;
  const hay = `${row.title || ""} ${row.summary || ""} ${row.article_url || ""} ${row.claim_url || ""}`;
  return !hasDeepfakeSignal(hay);
}

async function main() {
  const client = getAnonClient();
  const { data, error } = await client
    .from("incidents")
    .select("id,title,summary,category,category_label,source_type,article_url,claim_url,published_at")
    .order("published_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  const ids = (data || []).filter(shouldDelete).map((r) => r.id).filter(Boolean);
  const sql = ids.length
    ? `delete from public.incidents where id in (\n${ids.map((id) => `  '${id}'`).join(",\n")}\n);\n`
    : "-- no off-topic ids found\n";
  fs.mkdirSync("tmp", { recursive: true });
  fs.writeFileSync("tmp/offtopic-delete.sql", sql);
  console.log(`wrote tmp/offtopic-delete.sql ids=${ids.length}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
