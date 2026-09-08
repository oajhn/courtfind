const path = require('path');
const express = require('express');
const { getCities, searchCourts } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/cities -> list of cities currently in the database + court counts
app.get('/api/cities', (req, res) => {
  try {
    res.json(getCities());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load cities' });
  }
});

// GET /api/courts?city=Nashville&q=park&lit=yes&minHoops=2
app.get('/api/courts', (req, res) => {
  try {
    const { city, q, lit, minHoops } = req.query;
    const courts = searchCourts({
      city: city || null,
      q: q || null,
      lit: lit || null,
      minHoops: minHoops ? Number(minHoops) : null,
    });
    res.json(courts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load courts' });
  }
});

// Ray-casting point-in-polygon test. `point` is {lat, lng}, `polygon` is
// an array of {lat, lon} vertices from Overpass's "out geom" output.
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    const intersect =
      (yi > point.lat) !== (yj > point.lat) &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

async function fetchOverpass(query) {
  const res = await fetch('https://overpass.kumi.systems/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': 'CourtFinder/1.0 (contact: your-email@example.com)',
    },
    body: query,
  });
  const rawText = await res.text();
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`Overpass returned non-JSON: ${rawText.slice(0, 300)}`);
  }
}

// One-time data import endpoint — protected by a secret key.
app.get('/api/admin/import', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { upsertCourts } = require('./db');
  const city = req.query.city;
  const state = req.query.state || null;
  const areaId = req.query.areaId; // e.g. 3600197472 for Nashville's relation R197472
  if (!city) return res.status(400).json({ error: 'Missing ?city=' });
  if (!areaId) return res.status(400).json({ error: 'Missing ?areaId= (OSM relation id x 3600000000, e.g. 3600197472 for Nashville)' });

  try {
    // 1. Fetch the courts themselves.
    const courtsQuery = `
      [out:json][timeout:60];
      area(${areaId})->.searchArea;
      (
        node["leisure"="pitch"]["sport"="basketball"](area.searchArea);
        way["leisure"="pitch"]["sport"="basketball"](area.searchArea);
      );
      out center tags;
    `;
    const courtsData = await fetchOverpass(courtsQuery);

    // 2. Fetch every named park in the same area, with full boundary geometry.
    const parksQuery = `
      [out:json][timeout:60];
      area(${areaId})->.searchArea;
      way["leisure"="park"]["name"](area.searchArea);
      out geom;
    `;
    const parksData = await fetchOverpass(parksQuery);
    const parks = (parksData.elements || []).filter((el) => el.geometry && el.tags?.name);

    const excluded = new Set(['private', 'no', 'customers']);

    const courts = (courtsData.elements || [])
      .map((el) => {
        const tags = el.tags || {};
        const access = (tags.access || 'unknown').toLowerCase();
        if (excluded.has(access)) return null;
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) return null;
        const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');

        // If the court has no name of its own, check whether it falls
        // inside a named park's boundary and borrow that name instead.
        let name = tags.name || null;
        if (!name) {
          const containingPark = parks.find((park) => pointInPolygon({ lat, lng }, park.geometry));
          name = containingPark ? `${containingPark.tags.name} Court` : 'Unnamed Court';
        }

        return {
          osm_id: `${el.type}/${el.id}`,
          name,
          city, state,
          address: addr || null,
          lat, lng,
          surface: tags.surface || null,
          hoops: tags.hoops ? parseInt(tags.hoops, 10) : null,
          lit: tags.lit || 'unknown',
          access,
          source: 'openstreetmap',
        };
      })
      .filter(Boolean);

    upsertCourts(courts);
    const stillUnnamed = courts.filter((c) => c.name === 'Unnamed Court').length;
    res.json({ imported: courts.length, city, stillUnnamed, parksFound: parks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CourtFinder running at http://localhost:${PORT}`);
  console.log(`If the database is empty, run: npm run fetch-courts -- --city "Nashville"`);
});
