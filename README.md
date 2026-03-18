# Deepfake Record

This project keeps your approved design and wires it to live data.

## What is automated
- Poll GDELT every 15 minutes via `api/ingest`
- Auto-categorize incidents (`political`, `fraud`, `celeb`, `synthetic`, `audio`) using keyword heuristics
- Use article image when available; fallback to free Pollinations image placeholders
- Upsert incidents into Supabase and publish immediately
- Frontend loads live incidents + stats from API

## Setup
1. Create a Supabase project.
2. Run [`schema.sql`](./schema.sql) in Supabase SQL editor.
3. Create `.env` from `.env.example` and fill keys.
4. Install deps: `npm install`
5. Run local server: `npm run dev`
6. Open `http://localhost:3000`

## Endpoints
- `/api/ingest`: fetch and store latest incidents
- `/api/incidents?limit=80`: latest incidents for gallery
- `/api/stats`: counter and ticker stats

## Notes
- Feed is intentionally `reported_as_synthetic`, not a legal verdict.
- No manual review queue is used.
