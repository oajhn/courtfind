const path = require('path');
const express = require('express');
const {
  getCities, getNeighborhoods, searchCourts, upsertCourts, updateCourt,
  addCheckin, getBusyTimes, addRating, getRatingSummary,
} = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/cities -> list of cities currently in the database + court counts
app.get('/api/cities', async (req, res) => {
  try {
    res.json(await getCities());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load cities' });
  }
});

// GET /api/neighborhoods?city=Nashville -> list of neighborhoods + counts for that city
app.get('/api/neighborhoods', async (req, res) => {
  try {
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: 'Missing ?city=' });
    res.json(await getNeighborhoods(city));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load neighborhoods' });
  }
});

// GET /api/courts?city=Nashville&neighborhood=East%20Nashville&q=park&lit=yes&minHoops=2
// or, for viewport-based loading: &north=&south=&east=&west=
app.get('/api/courts', async (req, res) => {
  try {
    const { city, neighborhood, q, lit, minHoops, north, south, east, west } = req.query;
    const bounds = (north && south && east && west)
      ? { north: Number(north), south: Number(south), east: Number(east), west: Number(west) }
      : null;
    const courts = await searchCourts({
      city: city || null,
      neighborhood: neighborhood || null,
      q: q || null,
      lit: lit || null,
      minHoops: minHoops ? Number(minHoops) : null,
      bounds,
    });
    res.json(courts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load courts' });
  }
});

// POST /api/courts/:id/checkin  { dayOfWeek: 0-6, hour: 0-23, busyLevel: 1-5 }
app.post('/api/courts/:id/checkin', express.json(), async (req, res) => {
  try {
    const { dayOfWeek, hour, busyLevel } = req.body;
    if (
      !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 ||
      !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(busyLevel) || busyLevel < 1 || busyLevel > 5
    ) {
      return res.status(400).json({ error: 'dayOfWeek (0-6), hour (0-23), and busyLevel (1-5) are required' });
    }
    const checkin = await addCheckin(req.params.id, { dayOfWeek, hour, busyLevel });
    res.json({ saved: true, checkin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save check-in' });
  }
});

// GET /api/courts/:id/busy-times -> array of {dayOfWeek, hour, avgBusy, count}
app.get('/api/courts/:id/busy-times', async (req, res) => {
  try {
    res.json(await getBusyTimes(req.params.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load busy times' });
  }
});

// POST /api/courts/:id/rating  { hoopQuality: 1-5, courtSize: 'small'|'medium'|'large', competitionLevel: 1-5 }
// All three fields are optional individually, but at least one is required.
app.post('/api/courts/:id/rating', express.json(), async (req, res) => {
  try {
    const { hoopQuality, courtSize, competitionLevel } = req.body;
    const validSizes = new Set(['small', 'medium', 'large']);
    if (hoopQuality != null && (!Number.isInteger(hoopQuality) || hoopQuality < 1 || hoopQuality > 5)) {
      return res.status(400).json({ error: 'hoopQuality must be an integer 1-5' });
    }
    if (competitionLevel != null && (!Number.isInteger(competitionLevel) || competitionLevel < 1 || competitionLevel > 5)) {
      return res.status(400).json({ error: 'competitionLevel must be an integer 1-5' });
    }
    if (courtSize != null && !validSizes.has(courtSize)) {
      return res.status(400).json({ error: 'courtSize must be small, medium, or large' });
    }
    if (hoopQuality == null && courtSize == null && competitionLevel == null) {
      return res.status(400).json({ error: 'Provide at least one of hoopQuality, courtSize, competitionLevel' });
    }
    const rating = await addRating(req.params.id, { hoopQuality, courtSize, competitionLevel });
    res.json({ saved: true, rating });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save rating' });
  }
});

// GET /api/courts/:id/rating-summary -> {avgHoopQuality, avgCompetitionLevel, commonSize, count} or null
app.get('/api/courts/:id/rating-summary', async (req, res) => {
  try {
    res.json(await getRatingSummary(req.params.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load rating summary' });
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

// Straight-line distance in miles between two lat/lng points.
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

async function fetchOverpass(query, attempt = 0) {
  const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
  try {
    const res = await fetch(endpoint, {
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
      throw new Error(`non-JSON response: ${rawText.slice(0, 300)}`);
    }
  } catch (err) {
    // Covers both network-level failures (DNS, connection refused, timeout)
    // and non-JSON responses (busy/throttled server) — retry on the other
    // endpoint with a short backoff, up to 3 total attempts.
    const causeInfo = err.cause ? ` | cause: ${err.cause.code || err.cause.message || err.cause}` : '';
    console.error(`Overpass attempt ${attempt} on ${endpoint} failed: ${err.message}${causeInfo}`);
    if (attempt < OVERPASS_ENDPOINTS.length - 1) {
      await sleep(3000);
      return fetchOverpass(query, attempt + 1);
    }
    throw new Error(`Overpass request failed after retries on both endpoints: ${err.message}${causeInfo}`);
  }
}

// One-time (per city) data import endpoint — protected by a secret key.
// Two ways to scope the query area:
//   1. Radius mode (recommended, no external lookup needed):
//      ?lat=36.1627&lng=-86.7816&radiusKm=20
//   2. Admin-boundary mode (tighter fit to city limits, needs a known OSM
//      relation id — see openstreetmap.org, search the city, relation id is
//      in the URL): ?areaId=3600197472
app.get('/api/admin/import', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const city = req.query.city;
  const state = req.query.state || null;
  if (!city) return res.status(400).json({ error: 'Missing ?city=' });

  const areaId = req.query.areaId || null;
  const lat = req.query.lat ? Number(req.query.lat) : null;
  const lng = req.query.lng ? Number(req.query.lng) : null;
  const radiusKm = req.query.radiusKm ? Number(req.query.radiusKm) : 20;

  if (!areaId && (lat == null || lng == null)) {
    return res.status(400).json({ error: 'Provide either ?areaId= (admin boundary) or ?lat=&lng= (radius mode)' });
  }

  const radiusMeters = radiusKm * 1000;

  try {
    // 1. Fetch the courts themselves.
    const courtsQuery = areaId
      ? `
        [out:json][timeout:60];
        area(${areaId})->.searchArea;
        (
          node["leisure"="pitch"]["sport"="basketball"](area.searchArea);
          way["leisure"="pitch"]["sport"="basketball"](area.searchArea);
        );
        out center tags;
      `
      : `
        [out:json][timeout:60];
        (
          node["leisure"="pitch"]["sport"="basketball"](around:${radiusMeters},${lat},${lng});
          way["leisure"="pitch"]["sport"="basketball"](around:${radiusMeters},${lat},${lng});
        );
        out center tags;
      `;
    const courtsData = await fetchOverpass(courtsQuery);

    // 2. Fetch every named park in the same scope, with full boundary
    //    geometry (used to fill in a court's name when it has none of its own).
    const parksQuery = areaId
      ? `
        [out:json][timeout:60];
        area(${areaId})->.searchArea;
        way["leisure"="park"]["name"](area.searchArea);
        out geom;
      `
      : `
        [out:json][timeout:60];
        way["leisure"="park"]["name"](around:${radiusMeters},${lat},${lng});
        out geom;
      `;
    const parksData = await fetchOverpass(parksQuery);
    const parks = (parksData.elements || []).filter((el) => el.geometry && el.tags?.name);

    // 3. Fetch neighborhood/suburb points in the same scope (used to label
    //    which part of the city each court is in). Most OSM neighborhoods
    //    are tagged as single points, not boundary polygons, so we match
    //    each court to whichever neighborhood point is geographically closest.
    const neighborhoodsQuery = areaId
      ? `
        [out:json][timeout:60];
        area(${areaId})->.searchArea;
        node["place"~"^(suburb|neighbourhood|quarter)$"]["name"](area.searchArea);
        out;
      `
      : `
        [out:json][timeout:60];
        node["place"~"^(suburb|neighbourhood|quarter)$"]["name"](around:${radiusMeters},${lat},${lng});
        out;
      `;
    const neighborhoodsData = await fetchOverpass(neighborhoodsQuery);
    const neighborhoods = (neighborhoodsData.elements || [])
      .filter((el) => el.lat != null && el.lon != null && el.tags?.name)
      .map((el) => ({ name: el.tags.name, lat: el.lat, lng: el.lon }));

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

        let name = tags.name || null;
        if (!name) {
          const containingPark = parks.find((park) => pointInPolygon({ lat, lng }, park.geometry));
          name = containingPark ? `${containingPark.tags.name} Court` : 'Unnamed Court';
        }

        // Nearest neighborhood point, if any exist for this city.
        let neighborhood = null;
        if (neighborhoods.length > 0) {
          let closest = null;
          let closestDist = Infinity;
          for (const n of neighborhoods) {
            const d = haversineMiles(lat, lng, n.lat, n.lng);
            if (d < closestDist) {
              closestDist = d;
              closest = n;
            }
          }
          neighborhood = closest ? closest.name : null;
        }

        return {
          osm_id: `${el.type}/${el.id}`,
          name,
          city, state,
          neighborhood,
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

    await upsertCourts(courts);
    const stillUnnamed = courts.filter((c) => c.name === 'Unnamed Court').length;
    res.json({
      imported: courts.length,
      city,
      mode: areaId ? 'areaId' : 'radius',
      areaId: areaId || undefined,
      radiusKm: areaId ? undefined : radiusKm,
      stillUnnamed,
      parksFound: parks.length,
      neighborhoodsFound: neighborhoods.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Manually correct a court's name or neighborhood — no shell needed.
// Usage: /api/admin/edit-court?key=...&id=42&name=Shelby%20Park%20Court&neighborhood=East%20Nashville
// Omit either `name` or `neighborhood` to leave that field unchanged.
app.get('/api/admin/edit-court', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });
  const updates = {};
  if (req.query.name !== undefined) updates.name = req.query.name;
  if (req.query.neighborhood !== undefined) updates.neighborhood = req.query.neighborhood;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Provide ?name= and/or ?neighborhood= to update' });
  }
  try {
    const updated = await updateCourt(id, updates);
    if (!updated) return res.status(404).json({ error: 'No court found with that id' });
    res.json({ updated: true, court: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CourtFinder running at http://localhost:${PORT}`);
});
