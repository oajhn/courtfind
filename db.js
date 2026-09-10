const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Run once at startup — creates the table if it doesn't exist yet,
// and adds the neighborhood column if it's missing from an older table.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courts (
      id SERIAL PRIMARY KEY,
      osm_id TEXT UNIQUE,
      name TEXT,
      city TEXT NOT NULL,
      neighborhood TEXT,
      state TEXT,
      address TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      surface TEXT,
      hoops INTEGER,
      lit TEXT,
      access TEXT,
      source TEXT DEFAULT 'openstreetmap',
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE courts ADD COLUMN IF NOT EXISTS neighborhood TEXT;
    CREATE INDEX IF NOT EXISTS idx_courts_city ON courts(city);
    CREATE INDEX IF NOT EXISTS idx_courts_neighborhood ON courts(neighborhood);
    CREATE INDEX IF NOT EXISTS idx_courts_lat_lng ON courts(lat, lng);

    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL, -- 0=Sunday .. 6=Saturday, submitter's local time
      hour INTEGER NOT NULL,        -- 0-23, submitter's local time
      busy_level INTEGER NOT NULL,  -- 1=empty .. 5=packed
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_checkins_court ON checkins(court_id);

    CREATE TABLE IF NOT EXISTS ratings (
      id SERIAL PRIMARY KEY,
      court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
      hoop_quality INTEGER,      -- 1-5
      court_size TEXT,           -- 'small' | 'medium' | 'large'
      competition_level INTEGER, -- 1-5, 1=casual .. 5=very competitive
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_court ON ratings(court_id);
  `);
}
const ready = init().catch((err) => {
  console.error('Failed to initialize database:', err.message);
});

async function upsertCourts(courts) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of courts) {
      await client.query(
        `INSERT INTO courts (osm_id, name, city, neighborhood, state, address, lat, lng, surface, hoops, lit, access, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (osm_id) DO UPDATE SET
           name = EXCLUDED.name,
           city = EXCLUDED.city,
           neighborhood = EXCLUDED.neighborhood,
           state = EXCLUDED.state,
           address = EXCLUDED.address,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           surface = EXCLUDED.surface,
           hoops = EXCLUDED.hoops,
           lit = EXCLUDED.lit,
           access = EXCLUDED.access`,
        [c.osm_id, c.name, c.city, c.neighborhood, c.state, c.address, c.lat, c.lng, c.surface, c.hoops, c.lit, c.access, c.source]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getCities() {
  await ready;
  const { rows } = await pool.query(
    `SELECT city, COUNT(*) as count FROM courts GROUP BY city ORDER BY city`
  );
  return rows.map((r) => ({ city: r.city, count: Number(r.count) }));
}

async function getNeighborhoods(city) {
  await ready;
  const { rows } = await pool.query(
    `SELECT neighborhood, COUNT(*) as count FROM courts
     WHERE city = $1 AND neighborhood IS NOT NULL
     GROUP BY neighborhood ORDER BY neighborhood`,
    [city]
  );
  return rows.map((r) => ({ neighborhood: r.neighborhood, count: Number(r.count) }));
}

async function searchCourts({ city, neighborhood, q, lit, minHoops, bounds, limit }) {
  await ready;
  let sql = `SELECT * FROM courts WHERE 1=1`;
  const params = [];

  if (city) {
    params.push(city);
    sql += ` AND city = $${params.length}`;
  }
  if (neighborhood) {
    params.push(neighborhood);
    sql += ` AND neighborhood = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (name ILIKE $${params.length} OR address ILIKE $${params.length})`;
  }
  if (lit) {
    params.push(lit);
    sql += ` AND lit = $${params.length}`;
  }
  if (minHoops) {
    params.push(minHoops);
    sql += ` AND hoops >= $${params.length}`;
  }
  // Map-viewport filtering: only courts currently visible on screen.
  // `bounds` is {north, south, east, west} in degrees.
  if (bounds) {
    params.push(bounds.south);
    sql += ` AND lat >= $${params.length}`;
    params.push(bounds.north);
    sql += ` AND lat <= $${params.length}`;
    params.push(bounds.west);
    sql += ` AND lng >= $${params.length}`;
    params.push(bounds.east);
    sql += ` AND lng <= $${params.length}`;
  }
  sql += ` ORDER BY name`;

  // Always cap results — protects the browser from trying to render
  // thousands of markers at once when zoomed out over many cities.
  const cap = Math.min(limit || 500, 1000);
  params.push(cap);
  sql += ` LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

async function updateCourt(id, { name, neighborhood }) {
  await ready;
  const fields = [];
  const params = [];
  if (name !== undefined) {
    params.push(name);
    fields.push(`name = $${params.length}`);
  }
  if (neighborhood !== undefined) {
    params.push(neighborhood);
    fields.push(`neighborhood = $${params.length}`);
  }
  if (fields.length === 0) return null;
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE courts SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] || null;
}

// --- Check-ins (busy-time reports) ---

async function addCheckin(courtId, { dayOfWeek, hour, busyLevel }) {
  await ready;
  const { rows } = await pool.query(
    `INSERT INTO checkins (court_id, day_of_week, hour, busy_level) VALUES ($1,$2,$3,$4) RETURNING *`,
    [courtId, dayOfWeek, hour, busyLevel]
  );
  return rows[0];
}

// Aggregates all check-ins for a court into a day-of-week x hour grid,
// averaging busy_level and counting reports per cell. Only cells with at
// least one report are returned — the frontend fills gaps as "no data".
async function getBusyTimes(courtId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT day_of_week, hour, AVG(busy_level) as avg_busy, COUNT(*) as count
     FROM checkins WHERE court_id = $1
     GROUP BY day_of_week, hour
     ORDER BY day_of_week, hour`,
    [courtId]
  );
  return rows.map((r) => ({
    dayOfWeek: r.day_of_week,
    hour: r.hour,
    avgBusy: Number(r.avg_busy),
    count: Number(r.count),
  }));
}

// --- Ratings (hoop quality / court size / competition level) ---

async function addRating(courtId, { hoopQuality, courtSize, competitionLevel }) {
  await ready;
  const { rows } = await pool.query(
    `INSERT INTO ratings (court_id, hoop_quality, court_size, competition_level) VALUES ($1,$2,$3,$4) RETURNING *`,
    [courtId, hoopQuality ?? null, courtSize ?? null, competitionLevel ?? null]
  );
  return rows[0];
}

async function getRatingSummary(courtId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT
       AVG(hoop_quality) as avg_hoop_quality,
       AVG(competition_level) as avg_competition_level,
       COUNT(*) as count,
       MODE() WITHIN GROUP (ORDER BY court_size) as common_size
     FROM ratings WHERE court_id = $1`,
    [courtId]
  );
  const r = rows[0];
  if (!r || Number(r.count) === 0) return null;
  return {
    avgHoopQuality: r.avg_hoop_quality ? Number(r.avg_hoop_quality) : null,
    avgCompetitionLevel: r.avg_competition_level ? Number(r.avg_competition_level) : null,
    commonSize: r.common_size || null,
    count: Number(r.count),
  };
}

module.exports = {
  upsertCourts, getCities, getNeighborhoods, searchCourts, updateCourt,
  addCheckin, getBusyTimes, addRating, getRatingSummary,
};
