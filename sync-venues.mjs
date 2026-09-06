// sync-venues.mjs
//
// Populates the `venues` table from NPS + Geoapify (museums, galleries,
// monuments, sourced from OpenStreetMap via Geoapify's Places API). Run
// this once to seed the table, then on a schedule (cron / GitHub Action /
// Supabase scheduled Edge Function) to keep it fresh.
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
//   GEOAPIFY_API_KEY          -- free at https://myprojects.geoapify.com/
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NPS_API_KEY=... GEOAPIFY_API_KEY=... node sync-venues.mjs

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
   MUSEUMS/GALLERIES/MONUMENTS via Geoapify Places API
   Geoapify wraps OSM data behind a real, paid-tier-grade API -- reliable
   from CI/datacenter IPs, unlike the free public Overpass mirrors, which
   either rate-limit hard or outright block shared GitHub Actions IPs.
   Free tier: https://www.geoapify.com/pricing (generous daily quota).
--------------------------------------------------------------------- */
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
if (!GEOAPIFY_API_KEY) {
  console.error("Missing required env var: GEOAPIFY_API_KEY");
  process.exit(1);
}

const US_BOUNDS = { minLat: 24.5, maxLat: 49.5, minLng: -125, maxLng: -66.9 };
const GRID_COLS = 8;
const GRID_ROWS = 5;
const PAUSE_MS = 1500;
const MAX_RUN_MS = 8 * 60 * 1000; // safety cap -- should finish well under this

// Verified against Geoapify's published category enum
// (https://apidocs.geoapify.com/docs/places/#categories):
const GEOAPIFY_CATEGORIES = [
  "entertainment.museum",
  "entertainment.culture.gallery",
  "entertainment.culture.arts_centre",
  "tourism.sights.memorial",
  "tourism.attraction.artwork",
  "natural.protected_area", // closest match to "state park" -- OSM has no
                            // dedicated state-park tag Geoapify exposes
].join(",");

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

function categorizeGeoapify(categories) {
  const cats = categories || [];
  if (cats.includes("entertainment.culture.gallery")) return "Gallery";
  if (cats.includes("entertainment.culture.arts_centre")) return "Arts center";
  if (cats.some(c => c.startsWith("tourism.attraction.artwork"))) return "Public art";
  if (cats.some(c => c.startsWith("tourism.sights.memorial.monument"))) return "Monument";
  if (cats.some(c => c.startsWith("tourism.sights.memorial"))) return "Memorial";
  if (cats.includes("natural.protected_area")) return "State park";
  return "Museum"; // entertainment.museum, and sane default
}

async function fetchGeoapifyCell(bbox) {
  const rect = `rect:${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  const url = `https://api.geoapify.com/v2/places?categories=${GEOAPIFY_CATEGORIES}&filter=${encodeURIComponent(rect)}&limit=500`;

  const doFetch = () => fetch(url, { headers: { "x-api-key": GEOAPIFY_API_KEY } });

  let res = await doFetch();
  if (res.status === 429) {
    console.warn("  Geoapify rate-limited (429), waiting 5s then trying once more...");
    await new Promise(r => setTimeout(r, 5000));
    res = await doFetch();
  }

  if (!res.ok) {
    const body = await res.text();
    console.warn(`  Geoapify request failed (${res.status}): ${body.slice(0, 200)}`);
    return [];
  }

  const json = await res.json();
  return (json.features || [])
    .filter(f => f.properties?.name && f.properties?.place_id)
    .map(f => ({
      id: `geoapify:${f.properties.place_id}`,
      name: f.properties.name,
      category: categorizeGeoapify(f.properties.categories),
      city: f.properties.city || null,
      state: f.properties.state_code || f.properties.state || null,
      lat: f.properties.lat,
      lng: f.properties.lon,
      description: null,
      photo_url: null,
      source: "osm",
    }));
}

async function fetchAllOSM() {
  const cells = buildGridCells();
  const byId = new Map(); // dedupe -- a venue near a cell boundary can appear twice
  const deadline = Date.now() + MAX_RUN_MS;

  for (let i = 0; i < cells.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`  Time budget (${MAX_RUN_MS / 60000}min) reached -- stopping at cell ${i + 1}/${cells.length}. Next run will cover the rest.`);
      break;
    }
    console.log(`  Geoapify cell ${i + 1}/${cells.length}...`);
    const results = await fetchGeoapifyCell(cells[i]);
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

  console.log("Fetching museums/galleries/monuments from Geoapify...");
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
