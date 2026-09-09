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

async function searchCourts({ city, neighborhood, q, lit, minHoops }) {
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
  sql += ` ORDER BY name`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = { upsertCourts, getCities, getNeighborhoods, searchCourts };
