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
// One-time data import endpoint — protected by a secret key.
app.get('/api/admin/import', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { upsertCourts } = require('./db');
  const city = req.query.city;
  const state = req.query.state || null;
  if (!city) return res.status(400).json({ error: 'Missing ?city=' });
  try {
    const query = `
      [out:json][timeout:60];
      area["name"="${city.replace(/"/g, '\\"')}"]["boundary"="administrative"]->.searchArea;
      (
        node["leisure"="pitch"]["sport"="basketball"](area.searchArea);
        way["leisure"="pitch"]["sport"="basketball"](area.searchArea);
      );
      out center tags;
    `;
    const overpassRes = await fetch('https://overpass.kumi.systems/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': 'CourtFinder/1.0 (contact: your-email@example.com)',
      },
      body: query,
    });
    const rawText = await overpassRes.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Overpass returned non-JSON', detail: rawText.slice(0, 500) });
    }
    const excluded = new Set(['private', 'no', 'customers']);
    const courts = (data.elements || [])
      .map((el) => {
        const tags = el.tags || {};
        const access = (tags.access || 'unknown').toLowerCase();
        if (excluded.has(access)) return null;
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) return null;
        const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
        return {
          osm_id: `${el.type}/${el.id}`,
          name: tags.name || 'Unnamed Court',
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
    res.json({ imported: courts.length, city });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  console.log(`CourtFinder running at http://localhost:${PORT}`);
  console.log(`If the database is empty, run: npm run fetch-courts -- --city "Nashville"`);
});
