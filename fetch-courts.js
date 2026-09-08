/**
 * Pulls outdoor public basketball courts from OpenStreetMap via the
 * Overpass API and upserts them into the local SQLite database.
 *
 * Usage:
 *   node scripts/fetch-courts.js --city "Nashville" --state "Tennessee"
 *
 * Run it again for another city to add more coverage; existing courts
 * are updated in place (matched by OSM id), not duplicated.
 */

const { upsertCourts } = require('../db');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      out[key] = args[i + 1];
      i++;
    }
  }
  if (!out.city) {
    console.error('Missing required --city argument.\nExample: node scripts/fetch-courts.js --city "Nashville" --state "Tennessee"');
    process.exit(1);
  }
  return out;
}

// Builds an Overpass QL query scoped to a named area (city), pulling any
// node/way tagged as an outdoor basketball pitch. We don't hard-filter on
// access=public because most courts in city parks simply omit the access
// tag (absence generally means open/public); we instead EXCLUDE anything
// explicitly tagged private/school-only.
function buildQuery(city) {
  const escaped = city.replace(/"/g, '\\"');
  return `
    [out:json][timeout:60];
    area["name"="${escaped}"]["boundary"="administrative"]->.searchArea;
    (
      node["leisure"="pitch"]["sport"="basketball"](area.searchArea);
      way["leisure"="pitch"]["sport"="basketball"](area.searchArea);
    );
    out center tags;
  `;
}

async function fetchOverpass(query) {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  });
  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function normalize(elements, city, state) {
  const EXCLUDED_ACCESS = new Set(['private', 'no', 'customers']);

  return elements
    .map((el) => {
      const tags = el.tags || {};
      const access = (tags.access || 'unknown').toLowerCase();
      if (EXCLUDED_ACCESS.has(access)) return null;

      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) return null;

      const addressParts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean);

      return {
        osm_id: `${el.type}/${el.id}`,
        name: tags.name || 'Unnamed Court',
        city,
        state: state || tags['addr:state'] || null,
        address: addressParts.length ? addressParts.join(' ') : (tags['addr:full'] || null),
        lat,
        lng,
        surface: tags.surface || null,
        hoops: tags.hoops ? parseInt(tags.hoops, 10) : null,
        lit: tags.lit || 'unknown',
        access,
        source: 'openstreetmap',
      };
    })
    .filter(Boolean);
}

async function main() {
  const { city, state } = parseArgs();
  console.log(`Querying Overpass API for outdoor basketball courts in "${city}"...`);

  const data = await fetchOverpass(buildQuery(city));
  const elements = data.elements || [];
  console.log(`Overpass returned ${elements.length} raw element(s).`);

  const courts = normalize(elements, city, state);
  console.log(`${courts.length} court(s) after filtering out private/no-access.`);

  if (courts.length === 0) {
    console.log('No courts found. Try checking the city name matches an OSM administrative boundary exactly.');
    return;
  }

  upsertCourts(courts);
  console.log(`Saved ${courts.length} court(s) to courts.sqlite.`);
}

main().catch((err) => {
  console.error('Failed to fetch courts:', err.message);
  process.exit(1);
});
