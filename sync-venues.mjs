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
// Optional env vars:
//   SYNC_MAX_RUN_MINUTES       -- safety cap per invocation (default 25)
//   SYNC_FRESHNESS_HOURS       -- how long a cell is considered "already
//                                 done" before it's fetched again (default 20,
//                                 so a daily cron naturally re-covers
//                                 everything for freshness, but re-running
//                                 the same day after a timeout just resumes
//                                 the cells that weren't finished yet)
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NPS_API_KEY=... GEOAPIFY_API_KEY=... node sync-venues.mjs
//
// ---------------------------------------------------------------------
// WHY THIS VERSION IS DIFFERENT FROM THE FIRST DRAFT
// ---------------------------------------------------------------------
// The original script split the continental US into a 5x8 grid -- 40 cells,
// each roughly 345 x 350 miles. Each cell was fetched with a single
// `limit=500` call and no pagination. That's fine for sparse rural cells,
// but a cell that big can easily contain several major metro areas at once
// (e.g. one cell covered Chicago *and* Detroit *and* Indianapolis *and*
// Milwaukee). Geoapify doesn't sort results by relevance to any particular
// city inside that rectangle, so whichever venues happened to come back
// first in the 500-row cap could exhaust the limit before a given city's
// venues were ever returned -- silently dropping them, with no error and
// no warning. That's what was happening to Chicago: the sync "succeeded"
// and logged a healthy total count, but Chicago-area rows never made it
// into Supabase at all.
//
// Two changes fix this:
//   1. A much finer grid (20 x 12 = 240 cells instead of 40), so a single
//      cell is small enough that even a dense metro area is unlikely to
//      blow through 500 results.
//   2. Pagination within each cell as a safety net: if a cell's first page
//      comes back completely full (exactly `limit` rows), that's a sign
//      there may be more, so the script keeps paging with `offset` until a
//      page comes back under the limit, up to a sane cap.
//
// Because 240 cells takes much longer than 40, this version is also
// resumable: it records each completed cell (with a timestamp) in a small
// `sync_progress` table in Supabase. If a run gets cut off by the time
// budget, the next run skips cells that were completed recently and picks
// up where it left off, instead of restarting from cell 1 every time.
// Cells older than SYNC_FRESHNESS_HOURS are treated as needing a refresh,
// so a daily/weekly cron naturally keeps recycling through the whole
// country rather than syncing once and never updating stale entries.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NPS_API_KEY = process.env.NPS_API_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NPS_API_KEY || !GEOAPIFY_API_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NPS_API_KEY, GEOAPIFY_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MAX_RUN_MS = (Number(process.env.SYNC_MAX_RUN_MINUTES) || 25) * 60 * 1000;
const FRESHNESS_MS = (Number(process.env.SYNC_FRESHNESS_HOURS) || 20) * 60 * 60 * 1000;

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
--------------------------------------------------------------------- */
const US_BOUNDS = { minLat: 24.5, maxLat: 49.5, minLng: -125, maxLng: -66.9 };
const GRID_COLS = 20; // was 8 -- finer grid so a cell can't span several metros
const GRID_ROWS = 12; // was 5
const PAUSE_MS = 600; // shorter pause between requests -- 240 cells at 1500ms
                       // would burn 6 minutes just pausing before any fetches
const PAGE_LIMIT = 500;       // Geoapify's max per request
const MAX_PAGES_PER_CELL = 4; // safety cap -- 4 x 500 = 2000 venues per cell,
                               // far more than a well-sized cell should ever
                               // legitimately have; hitting this cap is a
                               // sign the grid needs to be even finer there

const GEOAPIFY_CATEGORIES = [
  "entertainment.museum",
  "entertainment.culture.gallery",
  "entertainment.culture.arts_centre",
  "tourism.sights.memorial",
  "tourism.attraction.artwork",
  "natural.protected_area",
].join(",");

function buildGridCells() {
  const cells = [];
  const latStep = (US_BOUNDS.maxLat - US_BOUNDS.minLat) / GRID_ROWS;
  const lngStep = (US_BOUNDS.maxLng - US_BOUNDS.minLng) / GRID_COLS;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      cells.push({
        index: r * GRID_COLS + c,
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
  return "Museum";
}

async function fetchGeoapifyPage(bbox, offset) {
  const rect = `rect:${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  const url = `https://api.geoapify.com/v2/places?categories=${GEOAPIFY_CATEGORIES}&filter=${encodeURIComponent(rect)}&limit=${PAGE_LIMIT}&offset=${offset}&apiKey=${GEOAPIFY_API_KEY}`;

  const doFetch = () => fetch(url);
  let res = await doFetch();
  if (res.status === 429) {
    console.warn("    rate-limited (429), waiting 5s then trying once more...");
    await new Promise(r => setTimeout(r, 5000));
    res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.text();
    console.warn(`    request failed (${res.status}): ${body.slice(0, 200)}`);
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

// Fetches one grid cell, paginating with `offset` if the cell looks like it
// might have more than one page's worth of results. If a page comes back
// completely full (== PAGE_LIMIT), that's a signal there could be more, so
// we keep going. If a page comes back under the limit, we've seen everything
// in that cell and stop.
async function fetchGeoapifyCell(cell) {
  const bbox = { south: cell.south, north: cell.north, west: cell.west, east: cell.east };
  const results = [];
  let offset = 0;
  let page = 0;

  while (page < MAX_PAGES_PER_CELL) {
    const pageResults = await fetchGeoapifyPage(bbox, offset);
    results.push(...pageResults);
    page++;
    if (pageResults.length < PAGE_LIMIT) break; // last page
    offset += PAGE_LIMIT;
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  if (page === MAX_PAGES_PER_CELL) {
    console.warn(`    cell ${cell.index} hit the ${MAX_PAGES_PER_CELL}-page safety cap -- this cell may still be too big, consider a finer grid`);
  }

  return results;
}

/* ---------------------------------------------------------------------
   PROGRESS TRACKING -- lets a run resume instead of restarting at cell 0.
   Table (create once in Supabase SQL editor):
     create table if not exists sync_progress (
       cell_index int primary key,
       completed_at timestamptz not null
     );
--------------------------------------------------------------------- */
async function loadFreshCellIndexes() {
  const cutoff = new Date(Date.now() - FRESHNESS_MS).toISOString();
  const { data, error } = await supabase
    .from("sync_progress")
    .select("cell_index")
    .gte("completed_at", cutoff);

  if (error) {
    console.warn("Couldn't load sync_progress (does the table exist yet?) -- treating all cells as pending:", error.message);
    return new Set();
  }
  return new Set((data || []).map(row => row.cell_index));
}

async function markCellComplete(cellIndex) {
  const { error } = await supabase
    .from("sync_progress")
    .upsert({ cell_index: cellIndex, completed_at: new Date().toISOString() }, { onConflict: "cell_index" });
  if (error) console.warn(`Couldn't record progress for cell ${cellIndex}:`, error.message);
}

async function fetchAllOSM() {
  const cells = buildGridCells();
  const alreadyFresh = await loadFreshCellIndexes();
  const pending = cells.filter(c => !alreadyFresh.has(c.index));

  console.log(`  ${cells.length} total cells, ${alreadyFresh.size} still fresh from a recent run, ${pending.length} to fetch now.`);

  const byId = new Map(); // dedupe -- a venue near a cell boundary can appear twice
  const deadline = Date.now() + MAX_RUN_MS;
  let stoppedEarly = false;

  for (let i = 0; i < pending.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`  Time budget (${MAX_RUN_MS / 60000}min) reached -- stopping at ${i}/${pending.length} pending cells. Run again to continue -- already-completed cells will be skipped automatically.`);
      stoppedEarly = true;
      break;
    }
    const cell = pending[i];
    console.log(`  Geoapify cell ${cell.index} (${i + 1}/${pending.length} pending)...`);
    const results = await fetchGeoapifyCell(cell);
    for (const v of results) {
      if (v.lat != null && v.lng != null) byId.set(v.id, v);
    }
    await markCellComplete(cell.index);
    if (i < pending.length - 1) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  return { venues: [...byId.values()], stoppedEarly };
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
  const { venues: osmVenues, stoppedEarly } = await fetchAllOSM();
  console.log(`  Got ${osmVenues.length} OSM venues this run.`);

  const all = [...npsVenues, ...osmVenues];
  console.log(`Upserting ${all.length} venues into Supabase...`);
  const count = await upsertVenues(all);
  console.log(`Done. Upserted ${count} venues.`);

  if (stoppedEarly) {
    console.log("This run hit its time budget before covering every cell -- run the script again (or wait for the next scheduled run) to pick up the rest.");
  }
}

main().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});

