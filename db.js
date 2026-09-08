const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'courts.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// Core schema. `osm_id` lets the import script upsert without creating
// duplicates when you re-run it for the same city.
db.exec(`
  CREATE TABLE IF NOT EXISTS courts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osm_id TEXT UNIQUE,
    name TEXT,
    city TEXT NOT NULL,
    state TEXT,
    address TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    surface TEXT,
    hoops INTEGER,
    lit TEXT,          -- 'yes' | 'no' | 'unknown'
    access TEXT,        -- 'public' | 'unknown' etc, as tagged in OSM
    source TEXT DEFAULT 'openstreetmap',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_courts_city ON courts(city);
  CREATE INDEX IF NOT EXISTS idx_courts_lat_lng ON courts(lat, lng);
`);

const upsertCourt = db.prepare(`
  INSERT INTO courts (osm_id, name, city, state, address, lat, lng, surface, hoops, lit, access, source)
  VALUES (@osm_id, @name, @city, @state, @address, @lat, @lng, @surface, @hoops, @lit, @access, @source)
  ON CONFLICT(osm_id) DO UPDATE SET
    name = excluded.name,
    city = excluded.city,
    state = excluded.state,
    address = excluded.address,
    lat = excluded.lat,
    lng = excluded.lng,
    surface = excluded.surface,
    hoops = excluded.hoops,
    lit = excluded.lit,
    access = excluded.access
`);

function upsertCourts(courts) {
  const insertMany = db.transaction((rows) => {
    for (const row of rows) upsertCourt.run(row);
  });
  insertMany(courts);
}

function getCities() {
  return db.prepare(`SELECT city, COUNT(*) as count FROM courts GROUP BY city ORDER BY city`).all();
}

function searchCourts({ city, q, lit, minHoops }) {
  let sql = `SELECT * FROM courts WHERE 1=1`;
  const params = {};

  if (city) {
    sql += ` AND city = @city`;
    params.city = city;
  }
  if (q) {
    sql += ` AND (name LIKE @q OR address LIKE @q)`;
    params.q = `%${q}%`;
  }
  if (lit) {
    sql += ` AND lit = @lit`;
    params.lit = lit;
  }
  if (minHoops) {
    sql += ` AND hoops >= @minHoops`;
    params.minHoops = minHoops;
  }
  sql += ` ORDER BY name`;

  return db.prepare(sql).all(params);
}

module.exports = { db, upsertCourts, getCities, searchCourts };
