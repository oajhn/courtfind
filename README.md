# CourtFinder

An index of public outdoor basketball courts, mapped and searchable. Court
data comes from [OpenStreetMap](https://www.openstreetmap.org) via the
Overpass API — free, no API key required.

## Setup

```bash
npm install
```

## 1. Pull court data for a city

The database starts empty. Import real courts by city:

```bash
npm run fetch-courts -- --city "Nashville" --state "Tennessee"
```

Run it again for any other city — courts are matched by their OSM id, so
re-running the same city updates existing entries instead of duplicating
them.

```bash
npm run fetch-courts -- --city "Chicago" --state "Illinois"
npm run fetch-courts -- --city "Austin" --state "Texas"
```

**Note on city names:** the script matches against OSM's administrative
boundary for that name, so use the name as OSM knows it (usually just the
city name is enough — check openstreetmap.org if a city returns 0 results).

## 2. Start the app

```bash
npm start
```

Then open **http://localhost:3000**. You'll see an interactive map with
every court you've imported, a sidebar list, and filters for city, name/
address search, and whether the court is lit at night.

## How the data is filtered

OSM tags courts with `leisure=pitch` + `sport=basketball`. The import script:

- Pulls every court inside the named city's boundary
- **Excludes** anything explicitly tagged `access=private`, `no`, or
  `customers` (school-only courts, gated communities, etc.)
- Keeps everything else, since most public park courts simply don't set an
  access tag at all (absence of the tag generally means open access)

This is a reasonable default, not a guarantee — OSM data is
crowd-sourced, so spot-check a new city's results before publishing them,
and consider cross-referencing your city's parks-department open-data
portal (many publish an official amenities layer) for anything Overpass
misses or mis-tags.

## Project structure

```
courtfinder/
├── server.js              # Express API + serves the frontend
├── db.js                  # SQLite schema and query helpers
├── scripts/
│   └── fetch-courts.js    # OpenStreetMap import script
└── public/
    └── index.html          # Map + search UI (Leaflet, vanilla JS)
```

## API

- `GET /api/cities` — list of cities in the database with court counts
- `GET /api/courts?city=&q=&lit=&minHoops=` — filtered court list

## Deploying

This is a plain Node/Express app with a local SQLite file — it runs on
Render, Railway, Fly.io, or a VPS with no changes. For serverless hosts
(Vercel, Netlify) you'd want to swap SQLite for a hosted database (e.g.
Postgres via Neon/Supabase), since serverless functions don't persist a
local file between requests.

## Extending it

- **More cities:** just run `fetch-courts` again with a new `--city`
- **Photos:** the Google Places API can enrich a court with a photo once
  you have its address — search by name + address, take the top match
- **Indoor courts, tennis, etc.:** change the Overpass query's `sport=` tag
  and adjust `leisure=` as needed
- **User submissions:** add a `POST /api/courts` endpoint with basic
  validation if you want to accept community-submitted courts
