# Deepfake Record

This project keeps your approved design and wires it to live data.

## What is automated
- Poll GDELT every 15 minutes via `api/ingest`
- Pull direct RSS feeds from fact-check, media, cyber, government, and platform-policy sources
- Auto-categorize incidents (`political`, `fraud`, `celeb`, `synthetic`, `audio`) using keyword heuristics
- Use article image when available; fallback to free Pollinations image placeholders
- Normalize all sources into one incidents table (`source_type`: `news`, `factcheck`, `social_report`)
- Tag incidents with `reported_on` platform hints (X, TikTok, Instagram, etc.) when found in title/body/url
- Store `claim_url` when an original social post URL is discoverable from source feeds
- Upsert incidents into Supabase and publish immediately
- Frontend loads live incidents + stats from API

## Setup
1. Create a Supabase project.
2. Run [`schema.sql`](./schema.sql) in Supabase SQL editor.
3. Create `.env` from `.env.example` and fill keys.
   Required server env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` (or alias `SUPABASE_SERVICE_KEY`).
4. Install deps: `npm install`
5. Run local server: `npm run dev`
6. Open `http://localhost:3000`

## Endpoints
- `/api/ingest`: fetch and store latest incidents
- `/api/incidents?limit=80`: latest incidents for gallery
- `/api/verified?limit=300`: verified historical archive incidents
- `/api/context?limit=24`: related context coverage (policy, elections, youth, platform impact)
- `/api/stats`: counter and ticker stats

## Verified Archive
- Use `historical_verified_incidents` for curated, defensible incidents.
- CSV template: [`data/verified_archive_template.csv`](./data/verified_archive_template.csv)
- Recommended fields include `source_url`, `published_at`, `debunked`, and `reach_estimate`.

## Notes
- Feed is intentionally `reported_as_synthetic`, not a legal verdict.
- No manual review queue is used.
