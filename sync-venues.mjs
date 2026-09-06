// sync-venues.mjs
//
// Populates the `venues` table from NPS + OpenStreetMap. Run this once to
// seed the table, then on a schedule (cron / GitHub Action / Supabase
// scheduled Edge Function) to keep it fresh.
//
// Requires Node 18+ (built-in fetch) and the supabase-js package:
//   npm install @supabase/supabase-js
//
// Requires environment variables (never hardcode these):
//   SUPABASE_URL              -- same URL as in index.html
//   SUPABASE_SERVICE_ROLE_KEY -- from Supabase dashboard > Project Settings > API
//                                (NOT the anon key -- this one bypasses RLS,
//                                 keep it out of any client-side code/repo)
//   NPS_API_KEY               -- your existing NPS key, now used server-side only
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NPS_API_KEY=... node sync-venues.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NPS_API_KEY = process.env.NPS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NPS_API_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NPS_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ---------------------------------------------------------------------
   NPS -- small dataset (~470 parks/monuments), one call covers all of it
--------------------------------------------------------------------- */
async function fetchNPS() {
  const url = `https://developer.nps.gov/api/v1/parks?limit=600&api_key=${NPS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NPS API error: ${res.status}`);
  const json = await res.json();

  return (json.data || [])
    .filter(p => p.latitude && p.longitude)
    .map(p => ({
      id: `nps:${p.parkCode}`,
      name: p.fullName,
      category: /monument|historic/i.test(p.designation || "") ? "National monument" : "National park",
      city: p.addresses?.[0]?.city || null,
      state: p.states?.split(",")[0] || null,
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      description: p.description || null,
      photo_url: p.images?.[0]?.url || null,
      source: "nps",
    }));
}

/* ---------------------------------------------------------------------
   OSM via Overpass -- too much data for one nationwide query, so the
   continental US is split into a grid and queried cell by cell, with a
   short pause between calls to stay polite to the free Overpass instance.
--------------------------------------------------------------------- */
const US_BOUNDS = { minLat: 24.5, maxLat: 49.5, minLng: -125, maxLng: -66.9 };
const GRID_COLS = 8;
const GRID_ROWS = 5;
const PAUSE_MS = 8000;       // base pause between cells -- Overpass free mirrors rate-limit hard

function buildGridCells() {
  const cells = [];
  const latStep = (US_BOUNDS.maxLat - US_BOUNDS.minLat) / GRID_ROWS;
  const lngStep = (US_BOUNDS.maxLng - US_BOUNDS.minLng) / GRID_COLS;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      cells.push({
        south: US_BOUNDS.minLat + r * latStep,
        north: US_BOUNDS.minLat + (r + 1) * latStep,
        west: US_BOUNDS.minLng + c * lngStep,
        east: US_BOUNDS.minLng + (c + 1) * lngStep,
      });
    }
  }
  return cells;
}

function categorizeOsmTags(tags) {
  if (tags.tourism === "gallery") return "Gallery";
  if (tags.tourism === "artwork") return "Public art";
  if (tags.amenity === "arts_centre") return "Arts center";
  if (tags.protection_title || tags.protect_class === "24") return "State park";
  if (tags.historic === "memorial") return "Memorial";
  if (tags.historic === "archaeological_site") return "Archaeological site";
  if (tags.historic === "monument") return "Monument";
  return "Museum";
}

const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

async function fetchWithRetry(endpoint, query, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    });

    if (res.status === 429) {
      if (attempt === maxRetries) return { res, body: await res.text() };
      // Respect Retry-After if the server sent one, else back off exponentially
      // (10s, 20s, 40s...) plus a little jitter.
      const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 10000 * 2 ** (attempt - 1) + Math.random() * 1000;
      console.warn(`  ${endpoint} rate-limited (429), waiting ${Math.round(waitMs / 1000)}s (retry ${attempt}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    return { res, body: res.ok ? null : await res.text() };
  }
}

async function fetchOverpassCell(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `
    [out:json][timeout:60];
    (
      nwr["tourism"~"^(museum|gallery|artwork)$"](${bboxStr});
      nwr["historic"~"^(monument|memorial|archaeological_site)$"](${bboxStr});
      nwr["amenity"="arts_centre"](${bboxStr});
      nwr["leisure"="park"]["protection_title"~"State Park",i](${bboxStr});
      nwr["boundary"="protected_area"]["protect_class"="24"](${bboxStr});
    );
    out center tags 500;
  `;

  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const { res, body } = await fetchWithRetry(endpoint, query);
      if (!res.ok) {
        lastError = `${res.status} ${res.statusText} -- ${(body || "").slice(0, 200)}`;
        console.warn(`  ${endpoint} failed: ${lastError}`);
        continue; // try the next endpoint
      }
      const json = await res.json();
      return (json.elements || [])
        .filter(el => el.tags?.name)
        .map(el => ({
          id: `osm:${el.type}/${el.id}`,
          name: el.tags.name,
          category: categorizeOsmTags(el.tags),
          city: el.tags["addr:city"] || null,
          state: el.tags["addr:state"] || null,
          lat: el.lat ?? el.center?.lat,
          lng: el.lon ?? el.center?.lon,
          description: null,
          photo_url: null,
          source: "osm",
        }));
    } catch (err) {
      lastError = err.message;
      console.warn(`  ${endpoint} threw: ${err.message}`);
    }
  }

  console.warn(`  All Overpass endpoints failed for this cell. Last error: ${lastError}`);
  return [];
}

async function fetchAllOSM() {
  const cells = buildGridCells();
  const byId = new Map(); // dedupe -- a venue near a cell boundary can appear twice

  for (let i = 0; i < cells.length; i++) {
    console.log(`  Overpass cell ${i + 1}/${cells.length}...`);
    const results = await fetchOverpassCell(cells[i]);
    for (const v of results) {
      if (v.lat != null && v.lng != null) byId.set(v.id, v);
    }
    if (i < cells.length - 1) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  return [...byId.values()];
}

/* ---------------------------------------------------------------------
   UPSERT -- batched so we don't send one giant request
--------------------------------------------------------------------- */
async function upsertVenues(venues) {
  const BATCH_SIZE = 500;
  let upserted = 0;

  for (let i = 0; i < venues.length; i += BATCH_SIZE) {
    const batch = venues.slice(i, i + BATCH_SIZE).map(v => ({ ...v, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from("venues").upsert(batch, { onConflict: "id" });
    if (error) {
      console.error(`Batch ${i / BATCH_SIZE} failed:`, error.message);
      continue;
    }
    upserted += batch.length;
  }
  return upserted;
}

/* ---------------------------------------------------------------------
   MAIN
--------------------------------------------------------------------- */
async function main() {
  console.log("Fetching NPS parks...");
  const npsVenues = await fetchNPS();
  console.log(`  Got ${npsVenues.length} NPS venues.`);

  console.log("Fetching OSM venues (this takes a few minutes)...");
  const osmVenues = await fetchAllOSM();
  console.log(`  Got ${osmVenues.length} OSM venues.`);

  const all = [...npsVenues, ...osmVenues];
  console.log(`Upserting ${all.length} venues into Supabase...`);
  const count = await upsertVenues(all);
  console.log(`Done. Upserted ${count} venues.`);
}

main().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});
