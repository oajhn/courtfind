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
      day_of_week INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      busy_level INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_checkins_court ON checkins(court_id);

    CREATE TABLE IF NOT EXISTS ratings (
      id SERIAL PRIMARY KEY,
      court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
      hoop_quality INTEGER,
      court_size TEXT,
      competition_level INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_court ON ratings(court_id);

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token);

    CREATE TABLE IF NOT EXISTS challenges (
      id SERIAL PRIMARY KEY,
      court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
      challenger_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opponent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_challenges_opponent ON challenges(opponent_id);
    CREATE INDEX IF NOT EXISTS idx_challenges_challenger ON challenges(challenger_id);

    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
      challenge_id INTEGER REFERENCES challenges(id) ON DELETE SET NULL,
      played_at TIMESTAMP DEFAULT NOW(),
      created_by INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_games_court ON games(court_id);

    CREATE TABLE IF NOT EXISTS game_players (
      id SERIAL PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      is_winner BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
    CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
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

async function addCheckin(courtId, { dayOfWeek, hour, busyLevel }) {
  await ready;
  const { rows } = await pool.query(
    `INSERT INTO checkins (court_id, day_of_week, hour, busy_level) VALUES ($1,$2,$3,$4) RETURNING *`,
    [courtId, dayOfWeek, hour, busyLevel]
  );
  return rows[0];
}

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

async function createUser({ username, email, passwordHash }) {
  await ready;
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, email, email_verified, created_at`,
    [username, email, passwordHash]
  );
  return rows[0];
}

async function getUserByEmail(email) {
  await ready;
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] || null;
}

async function getUserByUsername(username) {
  await ready;
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  return rows[0] || null;
}

async function getUserById(id) {
  await ready;
  const { rows } = await pool.query(
    `SELECT id, username, email, email_verified, created_at FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function markEmailVerified(userId) {
  await ready;
  await pool.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [userId]);
}

async function updatePassword(userId, passwordHash) {
  await ready;
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
}

async function createAuthToken(userId, token, type, expiresAt) {
  await ready;
  await pool.query(
    `INSERT INTO auth_tokens (user_id, token, type, expires_at) VALUES ($1,$2,$3,$4)`,
    [userId, token, type, expiresAt]
  );
}

async function consumeAuthToken(token, type) {
  await ready;
  const { rows } = await pool.query(
    `SELECT * FROM auth_tokens WHERE token = $1 AND type = $2 AND expires_at > NOW()`,
    [token, type]
  );
  if (rows.length === 0) return null;
  await pool.query(`DELETE FROM auth_tokens WHERE id = $1`, [rows[0].id]);
  return rows[0].user_id;
}

async function createChallenge({ courtId, challengerId, opponentId, message }) {
  await ready;
  const { rows } = await pool.query(
    `INSERT INTO challenges (court_id, challenger_id, opponent_id, message) VALUES ($1,$2,$3,$4) RETURNING *`,
    [courtId, challengerId, opponentId, message || null]
  );
  return rows[0];
}

async function respondToChallenge(challengeId, userId, accept) {
  await ready;
  const { rows } = await pool.query(
    `UPDATE challenges SET status = $1 WHERE id = $2 AND opponent_id = $3 AND status = 'pending' RETURNING *`,
    [accept ? 'accepted' : 'declined', challengeId, userId]
  );
  return rows[0] || null;
}

async function getUserChallenges(userId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT c.*, court.name as court_name,
            challenger.username as challenger_username,
            opponent.username as opponent_username
     FROM challenges c
     JOIN courts court ON court.id = c.court_id
     JOIN users challenger ON challenger.id = c.challenger_id
     JOIN users opponent ON opponent.id = c.opponent_id
     WHERE c.challenger_id = $1 OR c.opponent_id = $1
     ORDER BY c.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return rows;
}

async function getChallenge(id) {
  await ready;
  const { rows } = await pool.query(`SELECT * FROM challenges WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function markChallengeCompleted(id) {
  await ready;
  await pool.query(`UPDATE challenges SET status = 'completed' WHERE id = $1`, [id]);
}

async function recordGame({ courtId, challengeId, createdBy, players }) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: gameRows } = await client.query(
      `INSERT INTO games (court_id, challenge_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [courtId, challengeId || null, createdBy]
    );
    const game = gameRows[0];

    const teamTotals = {};
    for (const p of players) teamTotals[p.team] = (teamTotals[p.team] || 0) + Number(p.points);
    const teams = Object.keys(teamTotals);
    let winningTeam = null;
    if (teams.length === 2 && teamTotals[teams[0]] !== teamTotals[teams[1]]) {
      winningTeam = teamTotals[teams[0]] > teamTotals[teams[1]] ? teams[0] : teams[1];
    }

    for (const p of players) {
      await client.query(
        `INSERT INTO game_players (game_id, user_id, team, points, is_winner) VALUES ($1,$2,$3,$4,$5)`,
        [game.id, p.userId, p.team, p.points, p.team === winningTeam]
      );
    }
    await client.query('COMMIT');
    return game;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getLeaderboard(courtId, limit = 20) {
  await ready;
  const { rows } = await pool.query(
    `SELECT u.id, u.username,
            COUNT(*) as games_played,
            COUNT(*) FILTER (WHERE gp.is_winner) as wins,
            SUM(gp.points) as total_points
     FROM game_players gp
     JOIN games g ON g.id = gp.game_id
     JOIN users u ON u.id = gp.user_id
     WHERE g.court_id = $1
     GROUP BY u.id, u.username
     ORDER BY wins DESC, total_points DESC
     LIMIT $2`,
    [courtId, limit]
  );
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    gamesPlayed: Number(r.games_played),
    wins: Number(r.wins),
    totalPoints: Number(r.total_points),
  }));
}

module.exports = {
  upsertCourts, getCities, getNeighborhoods, searchCourts, updateCourt,
  addCheckin, getBusyTimes, addRating, getRatingSummary,
  createUser, getUserByEmail, getUserByUsername, getUserById,
  markEmailVerified, updatePassword, createAuthToken, consumeAuthToken,
  createChallenge, respondToChallenge, getUserChallenges, getChallenge, markChallengeCompleted,
  recordGame, getLeaderboard,
};
