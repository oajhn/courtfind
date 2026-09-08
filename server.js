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

app.listen(PORT, () => {
  console.log(`CourtFinder running at http://localhost:${PORT}`);
  console.log(`If the database is empty, run: npm run fetch-courts -- --city "Nashville"`);
});
