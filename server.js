const path = require('path');
const express = require('express');
const { getCities, getNeighborhoods, searchCourts, upsertCourts } = require('./db');
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
app.get('/api/courts', async (req, res) => {
  try {
    const { city, neighborhood, q, lit, minHoops } = req.query;
    const courts = await searchCourts({
      city: city || null,
      neighborhood: neighborhood || null,
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

// One-time (per city) data import endpoint — protected by a secret key.
app.get('/api/admin/import', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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

    // 2. Fetch every named park in the area, with full boundary geometry
    //    (used to fill in a court's name when it has none of its own).
    const parksQuery = `
      [out:json][timeout:60];
      area(${areaId})->.searchArea;
      way["leisure"="park"]["name"](area.searchArea);
      out geom;
    `;
    const parksData = await fetchOverpass(parksQuery);
    const parks = (parksData.elements || []).filter((el) => el.geometry && el.tags?.name);

    // 3. Fetch neighborhood/suburb points in the area (used to label which
    //    part of the city each court is in). Most OSM neighborhoods are
    //    tagged as single points, not boundary polygons, so we match each
    //    court to whichever neighborhood point is geographically closest.
    const neighborhoodsQuery = `
      [out:json][timeout:60];
      area(${areaId})->.searchArea;
      node["place"~"^(suburb|neighbourhood|quarter)$"]["name"](area.searchArea);
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
      stillUnnamed,
      parksFound: parks.length,
      neighborhoodsFound: neighborhoods.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CourtFinder running at http://localhost:${PORT}`);
});
