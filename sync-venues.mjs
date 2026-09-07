// sync-venues.mjs
//
// Populates the `venues` table from:
//   - NPS (National Park Service)   -- parks, monuments, historic sites
//   - Wikidata                      -- every entity classified as a museum
//     (Q33506 or a subclass) located in the US that also has a photo on
//     file (P18 is a required part of the query, not optional). Also pulls
//     coordinates, website, and Wikipedia link where available. Coverage
//     depends entirely on what's been documented on Wikidata -- comprehensive
//     for well-known museums, thin to nonexistent for small/obscure ones,
//     and requiring a photo trims the set further in exchange for every
//     result having a real image instead of a placeholder card.
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
//
// Wikidata needs NO API key, but its usage policy requires a real
// identifying User-Agent on requests -- see WIKIDATA_USER_AGENT further
// down in this file and fill in your actual contact info there.
//
// Optional env vars:
//   SYNC_MAX_RUN_MINUTES  -- safety cap per invocation (default 25)
//   SYNC_FRESHNESS_HOURS  -- how long a completed Wikidata sync cycle is
//                            considered fresh before it's re-run (default 20)
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

// Resumable via a single-row cursor table (page numbers don't apply here,
// since keyset pagination doesn't have fixed pages). If a run gets cut off
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

  console.log("Fetching museums from Wikidata...");
  const { venues: wikidataVenues, stoppedEarly } = await fetchAllWikidata();
  console.log(`  Got ${wikidataVenues.length} Wikidata venues this run.`);

  const all = [...npsVenues, ...wikidataVenues];
  console.log(`Upserting ${all.length} venues into Supabase...`);
  const count = await upsertVenues(all);
  console.log(`Done. Upserted ${count} venues.`);

  if (stoppedEarly) {
    console.log("This run hit its time budget before finishing Wikidata -- run the script again (or wait for the next scheduled run) to pick up the rest.");
  }
}


main().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});

