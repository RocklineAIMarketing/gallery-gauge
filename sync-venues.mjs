
// sync-venues.mjs
// Populates the `venues` table from official U.S. government sources only:
//   - NPS (National Park Service)         -- parks, monuments, historic sites
//   - NRHP (National Register of Historic Places, via NPS's public
//     ArcGIS map service) -- ~98,000 listed historic buildings, districts,
//     sites, structures, and objects nationwide
//   - Smithsonian -- hybrid live/maintained. Smithsonian's Open Access API
//     is a COLLECTION/ARTIFACT search (object records: title, unit code,
//     images) -- there is no address or coordinate field for the physical
//     museum buildings anywhere in it, confirmed against the live API
//     schema. What IS live is the /terms/unit_code endpoint, which returns
//     Smithsonian's current real roster of museum units. This script fetches
//     that roster fresh every run and cross-references it against a small
//     maintained coordinate lookup (SMITHSONIAN_COORDS below, sourced from
//     si.edu's own visitor pages -- there's no API to pull coordinates from,
//     so this part has to be maintained by hand). Any unit code Smithsonian
//     reports that isn't in the lookup yet gets logged as a warning instead
//     of silently dropped.
//   - Wikidata -- every entity classified as a museum (Q33506 or a subclass)
//     located in the US, with name, coordinates, website, Wikipedia link,
//     and image where Wikidata has one. Coverage depends entirely on what's
//     been documented on Wikidata -- comprehensive for well-known museums,
//     thin for small/obscure ones. No API key needed, but Wikidata's usage
//     policy requires a real identifying User-Agent -- see WIKIDATA_USER_AGENT
//     further down in this file and fill in your actual contact info there.
//
// Run this once to seed the table, then on a schedule (cron / GitHub Action /
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
//   NPS_API_KEY               -- your existing NPS key, used server-side only
//                                 (get one at https://www.nps.gov/subjects/developer/get-started.htm)
//   SMITHSONIAN_API_KEY       -- free, instant approval, at https://api.data.gov/signup/
//                                 If this isn't set, the Smithsonian step is
//                                 skipped (with a warning) -- NPS and NRHP
//                                 still run fine without it.
//
// NRHP needs NO API key -- it's a fully public ArcGIS REST service:
//   https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0
//
// Optional env vars:
//   SYNC_MAX_RUN_MINUTES  -- safety cap per invocation (default 25)
//   SYNC_FRESHNESS_HOURS  -- how long a completed Wikidata sync cycle is
//                            considered fresh before it's re-run (default 20)
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NPS_API_KEY=... SMITHSONIAN_API_KEY=... node sync-venues.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NPS_API_KEY = process.env.NPS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NPS_API_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NPS_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const MAX_RUN_MS = (Number(process.env.SYNC_MAX_RUN_MINUTES) || 25) * 60 * 1000;
const FRESHNESS_MS = (Number(process.env.SYNC_FRESHNESS_HOURS) || 20) * 60 * 60 * 1000; // used by the Wikidata cycle check below
const PAUSE_MS = 400;

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
   NRHP -- National Register of Historic Places, via NPS's public ArcGIS
   REST service. No API key required. ~98,000 listed properties nationwide.
   Docs / explorer: https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0

   The service caps each request at 2000 records (MaxRecordCount), so this
   pages through the whole table with resultOffset. STATUS is filtered to
   'Listed' only, excluding properties that were later removed from the
   register.

   Field reference used below (confirmed against the live service):
     RESNAME      -- property name
     Address, City, County, State
     ResType      -- Building / District / Object / Site / Structure
     Is_NHL       -- "X" if also a National Historic Landmark
     STATUS       -- 'Listed' or 'Removed'
     NRIS_Refnum  -- unique reference number, used as our venue id

   NOTE: this dataset has no photo field -- these listings show up with a
   placeholder card in the UI, same as any other source with no photo_url.
--------------------------------------------------------------------- */
const NRHP_QUERY_URL = "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0/query";
const NRHP_PAGE_SIZE = 2000; // the service's own MaxRecordCount
const NRHP_OUT_FIELDS = ["RESNAME", "Address", "City", "County", "State", "ResType", "Is_NHL", "STATUS", "NRIS_Refnum"].join(",");
const NRHP_MAX_PAGES = 80; // safety cap -- 80 x 2000 = 160,000, comfortably above the ~98k total

function categorizeNrhp(resType, isNhl) {
  if (isNhl === "X") return "National Historic Landmark";
  switch ((resType || "").toLowerCase()) {
    case "district": return "Historic district";
    case "object": return "Historic object";
    case "structure": return "Historic structure";
    case "building": return "Historic building";
    default: return "Historic site";
  }
}

async function fetchNrhpPage(offset) {
  const params = new URLSearchParams({
    where: "STATUS='Listed'",
    outFields: NRHP_OUT_FIELDS,
    f: "geojson",
    resultOffset: String(offset),
    resultRecordCount: String(NRHP_PAGE_SIZE),
    returnGeometry: "true",
    orderByFields: "OBJECTID",
  });
  const url = `${NRHP_QUERY_URL}?${params.toString()}`;

  const doFetch = () => fetch(url);
  let res = await doFetch();
  if (res.status === 429 || res.status === 503) {
    console.warn(`    NRHP throttled (${res.status}) at offset ${offset}, waiting 5s and retrying once...`);
    await new Promise(r => setTimeout(r, 5000));
    res = await doFetch();
  }
  if (!res.ok) {
    console.warn(`    NRHP request failed at offset ${offset} (${res.status})`);
    return [];
  }

  const json = await res.json();
  return (json.features || [])
    .filter(f => f.geometry?.coordinates?.length === 2 && f.properties?.RESNAME)
    .map(f => {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      return {
        id: `nrhp:${p.NRIS_Refnum || f.id}`,
        name: p.RESNAME,
        category: categorizeNrhp(p.ResType, p.Is_NHL),
        city: p.City || null,
        state: p.State || null,
        lat,
        lng,
        description: null,
        photo_url: null,
        source: "nrhp",
      };
    });
}

// Resumable via a small progress table, same pattern as before, keyed by
// page number instead of grid cell / state code.
async function loadCompletedNrhpPages() {
  const { data, error } = await supabase.from("nrhp_progress").select("page");
  if (error) {
    console.warn("Couldn't load nrhp_progress (does the table exist yet?) -- treating all pages as pending:", error.message);
    return new Set();
  }
  return new Set((data || []).map(row => row.page));
}

async function markNrhpPageComplete(page) {
  const { error } = await supabase
    .from("nrhp_progress")
    .upsert({ page, completed_at: new Date().toISOString() }, { onConflict: "page" });
  if (error) console.warn(`Couldn't record NRHP progress for page ${page}:`, error.message);
}

async function fetchAllNrhp() {
  const completed = await loadCompletedNrhpPages();
  const deadline = Date.now() + MAX_RUN_MS;
  // A Map instead of a plain array -- NRHP districts are nominated as one
  // submission covering many contributing buildings, and each contributing
  // building can come back as its own point but sharing the district's
  // NRIS_Refnum. That produces duplicate `id`s, which made a single upsert
  // batch try to update the same row twice ("ON CONFLICT DO UPDATE command
  // cannot affect row a second time"). Deduping by id here fixes it.
  const byId = new Map();
  let stoppedEarly = false;

  for (let page = 0; page < NRHP_MAX_PAGES; page++) {
    if (completed.has(page)) continue; // already fetched in a prior run

    if (Date.now() > deadline) {
      console.warn(`  Time budget reached -- stopping NRHP at page ${page}. Run again to continue -- completed pages are skipped automatically.`);
      stoppedEarly = true;
      break;
    }

    const offset = page * NRHP_PAGE_SIZE;
    console.log(`  NRHP page ${page} (offset ${offset})...`);
    const records = await fetchNrhpPage(offset);
    for (const r of records) byId.set(r.id, r);
    await markNrhpPageComplete(page);

    if (records.length < NRHP_PAGE_SIZE) {
      console.log(`  Reached the end of NRHP at page ${page} (${records.length} records, under the ${NRHP_PAGE_SIZE} page size -- that's the last page).`);
      break;
    }
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  return { venues: [...byId.values()], stoppedEarly };
}

/* ---------------------------------------------------------------------
   SMITHSONIAN -- hybrid live/maintained, because a fully live version is
   not possible. Smithsonian's Open Access API is a COLLECTION/ARTIFACT
   search (object records: title, unit code, images) -- I checked its
   response schema directly, and there is no address or coordinate field
   anywhere in it for the physical museum buildings themselves. That data
   simply isn't published by any Smithsonian API.

   What IS live: the /terms/unit_code endpoint returns Smithsonian's
   current, real roster of museum unit codes. So this fetches that list
   fresh every run, and cross-references it against a small maintained
   lookup table of unit_code -> address/coordinates (sourced from si.edu's
   visitor pages). If Smithsonian's live roster includes a unit_code this
   script doesn't have coordinates for yet (a new museum, a renamed one),
   it's skipped and logged as a warning instead of silently vanishing --
   that's your signal to add it to SMITHSONIAN_COORDS below.

   Needs a free key: https://api.data.gov/signup/ (instant approval) --
   set as SMITHSONIAN_API_KEY. If that env var isn't set, this step is
   skipped entirely and a warning is logged (NPS + NRHP still run fine).
--------------------------------------------------------------------- */
const SMITHSONIAN_API_KEY = process.env.SMITHSONIAN_API_KEY;

// Maintained by hand -- Smithsonian's API has no coordinate data to pull
// this from. Keyed by the unit_code values the live /terms endpoint returns.
const SMITHSONIAN_COORDS = {
  NMAAHC: { name: "National Museum of African American History and Culture", city: "Washington", state: "DC", lat: 38.8912, lng: -77.0300 },
  NMAFA:  { name: "National Museum of African Art", city: "Washington", state: "DC", lat: 38.8885, lng: -77.0271 },
  NASM:   { name: "National Air and Space Museum", city: "Washington", state: "DC", lat: 38.8882, lng: -77.0199 },
  SAAM:   { name: "Smithsonian American Art Museum", city: "Washington", state: "DC", lat: 38.8975, lng: -77.0231 },
  NMAH:   { name: "National Museum of American History", city: "Washington", state: "DC", lat: 38.8913, lng: -77.0300 },
  NMAI:   { name: "National Museum of the American Indian", city: "Washington", state: "DC", lat: 38.8893, lng: -77.0164 },
  ACM:    { name: "Anacostia Community Museum", city: "Washington", state: "DC", lat: 38.8617, lng: -76.9781 },
  CHNDM:  { name: "Cooper Hewitt, Smithsonian Design Museum", city: "New York", state: "NY", lat: 40.7827, lng: -73.9589 },
  FSG:    { name: "National Museum of Asian Art (Freer|Sackler)", city: "Washington", state: "DC", lat: 38.8890, lng: -77.0257 },
  HMSG:   { name: "Hirshhorn Museum and Sculpture Garden", city: "Washington", state: "DC", lat: 38.8880, lng: -77.0227 },
  NMNH:   { name: "National Museum of Natural History", city: "Washington", state: "DC", lat: 38.8913, lng: -77.0261 },
  NPG:    { name: "National Portrait Gallery", city: "Washington", state: "DC", lat: 38.8981, lng: -77.0231 },
  NPM:    { name: "National Postal Museum", city: "Washington", state: "DC", lat: 38.8974, lng: -77.0067 },
  SAAM_R: { name: "Renwick Gallery", city: "Washington", state: "DC", lat: 38.8985, lng: -77.0388 },
  NZP:    { name: "Smithsonian National Zoo", city: "Washington", state: "DC", lat: 38.9296, lng: -77.0497 },
};

async function fetchSmithsonianUnitCodes() {
  const url = `https://api.si.edu/openaccess/api/v1.0/terms/unit_code?api_key=${SMITHSONIAN_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Smithsonian unit_code lookup failed (${res.status}) -- skipping Smithsonian this run.`);
    return [];
  }
  const json = await res.json();
  return json.response?.terms || [];
}

async function fetchSmithsonian() {
  if (!SMITHSONIAN_API_KEY) {
    console.warn("  SMITHSONIAN_API_KEY not set -- skipping Smithsonian this run.");
    return [];
  }

  const liveUnitCodes = await fetchSmithsonianUnitCodes();
  const known = [];
  const unknown = [];

  for (const code of liveUnitCodes) {
    const coords = SMITHSONIAN_COORDS[code];
    if (coords) {
      known.push({
        id: `si:${code}`,
        name: coords.name,
        category: "Smithsonian museum",
        city: coords.city,
        state: coords.state,
        lat: coords.lat,
        lng: coords.lng,
        description: null,
        photo_url: null,
        source: "si",
      });
    } else {
      unknown.push(code);
    }
  }

  if (unknown.length) {
    console.warn(`  Smithsonian's live roster includes unit codes with no coordinates on file yet -- add these to SMITHSONIAN_COORDS if they're physical museums: ${unknown.join(", ")}`);
  }

  return known;
}

/* ---------------------------------------------------------------------
   WIKIDATA -- every entity Wikidata classifies as a museum (Q33506, plus
   its subclasses -- art museums, history museums, etc.) located in the US,
   with name, coordinates, website, Wikipedia article, and image where
   available. Free, no API key. Query service:
   https://query.wikidata.org/sparql

   Coverage note, honestly: this now REQUIRES a photo (P18) to be present on
   Wikidata, at your request -- entries without one are excluded entirely by
   the query itself, not filtered afterward. That trades away a meaningful
   chunk of coverage (plenty of real, legitimate small museums are
   documented on Wikidata with no photo on file) in exchange for every
   result being guaranteed to have a real image instead of a placeholder
   card. If you ever want the fuller (photo-optional) set back, this is the
   one line to revert: search this file for "must have a photo".

   Wikidata's usage policy requires a real, identifying User-Agent on
   requests to their query service -- anonymous-looking traffic gets
   throttled or blocked. WIKIDATA_USER_AGENT below has a placeholder; put
   your actual contact info in it (an email or a URL to this project) before
   running this at any real frequency.

   Pagination note: SPARQL's OFFSET gets slow/unreliable on large result
   sets (the engine still has to walk past every skipped row). This uses
   "keyset" pagination instead -- each page asks for entities with an ID
   greater than the last one seen, which stays fast regardless of how deep
   you page.
--------------------------------------------------------------------- */
const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
const WIKIDATA_USER_AGENT = "GalleryGauge/1.0 (contact: YOUR_EMAIL_OR_SITE_URL_HERE)"; // <-- fill this in
const WIKIDATA_PAGE_SIZE = 500;
const WIKIDATA_MAX_PAGES = 60; // safety cap -- 60 x 500 = 30,000, comfortably
                                // above the likely count of US museums on Wikidata

function wikidataQuery(afterQid) {
  const cursor = afterQid ? `FILTER(?item > wd:${afterQid})` : "";
  return `
    SELECT ?item ?itemLabel ?coord ?website ?image ?article ?adminLabel WHERE {
      ?item wdt:P31/wdt:P279* wd:Q33506.  # instance of (a subclass of) museum
      ?item wdt:P17 wd:Q30.               # country: United States
      ?item wdt:P625 ?coord.              # must have coordinates
      ${cursor}
      OPTIONAL { ?item wdt:P856 ?website. }
      ?item wdt:P18 ?image.               # must have a photo -- see comment above
      OPTIONAL { ?item wdt:P131 ?admin. }
      OPTIONAL {
        ?article schema:about ?item ;
                 schema:isPartOf <https://en.wikipedia.org/> .
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    ORDER BY ?item
    LIMIT ${WIKIDATA_PAGE_SIZE}
  `;
}

function parseWikidataPoint(wkt) {
  // Wikidata coordinates come back as WKT: "Point(lng lat)"
  const m = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(wkt || "");
  if (!m) return null;
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

async function fetchWikidataPage(afterQid) {
  const url = `${WIKIDATA_ENDPOINT}?format=json&query=${encodeURIComponent(wikidataQuery(afterQid))}`;
  const doFetch = () => fetch(url, {
    headers: { "User-Agent": WIKIDATA_USER_AGENT, accept: "application/sparql-results+json" },
  });

  let res = await doFetch();
  if (res.status === 429) {
    console.warn("    Wikidata rate-limited (429), waiting 5s and retrying once...");
    await new Promise(r => setTimeout(r, 5000));
    res = await doFetch();
  }
  if (!res.ok) {
    console.warn(`    Wikidata request failed (${res.status}) -- this page will be retried on the next run.`);
    return null; // distinct from an empty-but-successful page
  }

  const json = await res.json();
  const rows = json.results?.bindings || [];

  const venues = rows
    .map(row => {
      const qid = row.item?.value?.split("/").pop();
      const point = parseWikidataPoint(row.coord?.value);
      if (!qid || !point) return null;

      const websiteText = row.website?.value ? `Website: ${row.website.value}` : null;
      const articleText = row.article?.value ? `Wikipedia: ${row.article.value}` : null;
      const description = [websiteText, articleText].filter(Boolean).join(" | ") || null;

      return {
        id: `wikidata:${qid}`,
        qid, // kept off the record before insert -- used only for the cursor below
        name: row.itemLabel?.value || null,
        category: "Museum",
        city: row.adminLabel?.value || null,
        state: null, // Wikidata's admin-region chain doesn't reliably resolve
                     // to "state" in one hop -- left out rather than guessed
        lat: point.lat,
        lng: point.lng,
        description,
        photo_url: row.image.value, // guaranteed present -- P18 is now a required triple, not optional
        source: "wikidata",
      };
    })
    .filter(v => v && v.name);

  return venues;
}

// Resumable via a single-row cursor table (not per-page like NRHP, since
// keyset pagination doesn't have fixed page numbers). If a run gets cut off
// mid-cycle, the next run resumes from the last QID seen. Once a full cycle
// completes (a page comes back under WIKIDATA_PAGE_SIZE), the cursor resets
// so the next scheduled run starts a fresh pass and can pick up new/updated
// entries -- gated by the same freshness window as everything else.
async function loadWikidataProgress() {
  const { data, error } = await supabase.from("wikidata_progress").select("*").eq("id", 1).maybeSingle();
  if (error) {
    console.warn("Couldn't load wikidata_progress (does the table exist yet?) -- starting from scratch:", error.message);
    return { last_qid: null, cycle_completed_at: null };
  }
  return data || { last_qid: null, cycle_completed_at: null };
}

async function saveWikidataProgress(lastQid, cycleCompletedAt) {
  const { error } = await supabase
    .from("wikidata_progress")
    .upsert({ id: 1, last_qid: lastQid, cycle_completed_at: cycleCompletedAt }, { onConflict: "id" });
  if (error) console.warn("Couldn't save wikidata_progress:", error.message);
}

async function fetchAllWikidata() {
  const progress = await loadWikidataProgress();
  const cutoff = Date.now() - FRESHNESS_MS;
  if (progress.cycle_completed_at && new Date(progress.cycle_completed_at).getTime() > cutoff) {
    console.log("  Wikidata was fully synced recently -- skipping this run to stay within freshness window.");
    return { venues: [], stoppedEarly: false };
  }

  let afterQid = progress.cycle_completed_at ? null : progress.last_qid; // fresh cycle starts null
  const deadline = Date.now() + MAX_RUN_MS;
  const all = [];
  let stoppedEarly = false;

  for (let page = 0; page < WIKIDATA_MAX_PAGES; page++) {
    if (Date.now() > deadline) {
      console.warn(`  Time budget reached -- stopping Wikidata after ${page} pages this run. Run again to continue from the same cursor.`);
      stoppedEarly = true;
      break;
    }

    console.log(`  Wikidata page ${page} (after ${afterQid || "start"})...`);
    const pageVenues = await fetchWikidataPage(afterQid);
    if (pageVenues === null) { stoppedEarly = true; break; } // request failed -- resume here next time

    all.push(...pageVenues);

    if (pageVenues.length < WIKIDATA_PAGE_SIZE) {
      console.log(`  Reached the end of Wikidata's US museum results at page ${page}.`);
      await saveWikidataProgress(null, new Date().toISOString()); // cycle complete, reset cursor
      break;
    }

    afterQid = pageVenues[pageVenues.length - 1].qid;
    await saveWikidataProgress(afterQid, progress.cycle_completed_at || null);
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  return { venues: all.map(({ qid, ...v }) => v), stoppedEarly }; // strip the helper `qid` field before upsert
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

  console.log("Fetching National Register of Historic Places listings...");
  const { venues: nrhpVenues, stoppedEarly: nrhpStoppedEarly } = await fetchAllNrhp();
  console.log(`  Got ${nrhpVenues.length} NRHP venues this run.`);

  console.log("Fetching Smithsonian's live museum unit roster...");
  const smithsonianVenues = await fetchSmithsonian();
  console.log(`  Got ${smithsonianVenues.length} Smithsonian venues.`);

  console.log("Fetching museums from Wikidata...");
  const { venues: wikidataVenues, stoppedEarly: wikidataStoppedEarly } = await fetchAllWikidata();
  console.log(`  Got ${wikidataVenues.length} Wikidata venues this run.`);

  const stoppedEarly = nrhpStoppedEarly || wikidataStoppedEarly;
  const all = [...npsVenues, ...nrhpVenues, ...smithsonianVenues, ...wikidataVenues];
  console.log(`Upserting ${all.length} venues into Supabase...`);
  const count = await upsertVenues(all);
  console.log(`Done. Upserted ${count} venues.`);

  if (stoppedEarly) {
    console.log("This run hit its time budget before finishing NRHP and/or Wikidata -- run the script again (or wait for the next scheduled run) to pick up the rest.");
  }
}

main().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});

