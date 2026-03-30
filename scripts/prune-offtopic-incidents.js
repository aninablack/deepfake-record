#!/usr/bin/env node
const { getServiceClient } = require("../lib/supabase");

function hasDeepfakeSignal(text) {
  return /(deepfake|deep fake|voice clone|cloned voice|vocal clone|synthetic voice|voice deepfake|audio deepfake|fake audio|fake video|face swap|synthetic media|ai impersonation|ai song|ai[- ]generated song|soundalike|mimic(?:ked|ry)? voice|ai porn|non-consensual|digital forgery|manipulated media)/i.test(
    String(text || "")
  );
}

function isRoundupSummary(text) {
  return /\b(press review|papers discuss|next:|finally,|staying with ai|what we heard)\b/i.test(String(text || ""));
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
  const hay = `${row.title || ""} ${row.summary || ""} ${row.article_url || ""} ${row.claim_url || ""}`;
  const titleUrlHay = `${row.title || ""} ${row.article_url || ""} ${row.claim_url || ""}`;
  if (sourceType === "news" && !hasDeepfakeSignal(titleUrlHay) && isRoundupSummary(row.summary)) return true;
  return !hasDeepfakeSignal(hay);
}

async function fetchAllIncidents(client) {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await client
      .from("incidents")
      .select("id,title,summary,category,category_label,source_type,article_url,claim_url,published_at")
      .order("published_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    const batch = Array.isArray(data) ? data : [];
    all = all.concat(batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function deleteByIds(client, ids) {
  const chunkSize = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { error } = await client.from("incidents").delete().in("id", chunk);
    if (error) throw error;
    deleted += chunk.length;
  }
  return deleted;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const client = getServiceClient();
  const rows = await fetchAllIncidents(client);
  const offTopic = rows.filter(shouldDelete);
  const ids = offTopic.map((r) => r.id).filter(Boolean);

  console.log(`mode=${apply ? "apply" : "dry-run"}`);
  console.log(`total_rows=${rows.length}`);
  console.log(`offtopic_candidates=${offTopic.length}`);
  console.log(`offtopic_ids=${ids.length}`);

  const sample = offTopic.slice(0, 12).map((r) => ({
    id: r.id,
    source_type: r.source_type,
    title: r.title,
    article_url: r.article_url,
  }));
  if (sample.length) {
    console.log("sample_candidates=");
    console.log(JSON.stringify(sample, null, 2));
  }

  if (!apply) return;
  if (!ids.length) {
    console.log("deleted=0");
    return;
  }

  const deleted = await deleteByIds(client, ids);
  console.log(`deleted=${deleted}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
