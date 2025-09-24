/*
 * CCTV GIS WebRTC Backend
 *
 * This server exposes REST endpoints to query camera metadata from a PostgreSQL + PostGIS
 * database, records viewing statistics via Prometheus metrics, and optionally
 * annotates those metrics with country, browser and OS information derived from
 * the viewer's IP address and user agent.  It does not handle RTSP or
 * WebRTC itself – that is delegated to a streaming layer (MediaMTX/go2rtc + Janus).
 */

const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');
const UAParser = require('ua-parser-js');
const maxmind = require('@maxmind/geoip2-node');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Prometheus registry and default metrics
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// Define custom metrics
const viewStartCounter = new client.Counter({
  name: 'webrtc_view_start_total',
  help: 'Total number of view starts by camera, country, browser and OS',
  labelNames: ['camera_id', 'country', 'browser', 'os'],
});
const viewersGauge = new client.Gauge({
  name: 'webrtc_viewers_gauge',
  help: 'Current number of viewers by camera and country',
  labelNames: ['camera_id', 'country'],
});
const viewSecondsCounter = new client.Counter({
  name: 'webrtc_view_seconds_total',
  help: 'Total seconds watched by camera and country',
  labelNames: ['camera_id', 'country'],
});

registry.registerMetric(viewStartCounter);
registry.registerMetric(viewersGauge);
registry.registerMetric(viewSecondsCounter);

// Initialise GeoIP reader lazily; if GEOIP_DB_PATH is not set, country
// resolution falls back to 'ZZ' (unknown).
let geoReader = null;
if (process.env.GEOIP_DB_PATH) {
  maxmind
    .open(process.env.GEOIP_DB_PATH)
    .then((reader) => {
      geoReader = reader;
      console.log('GeoIP database loaded');
    })
    .catch((err) => {
      console.warn('GeoIP database could not be loaded:', err.message);
    });
}

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Helper: obtain client IP from request, respecting proxy headers
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    // may contain multiple IPs (client, proxies); take the first
    const ips = xff.split(',').map((ip) => ip.trim());
    return ips[0];
  }
  // fallback: direct connection
  return req.socket?.remoteAddress || '';
}

// Helper: resolve ISO country code using GeoIP (defaults to 'ZZ' if unavailable)
function getCountry(ip) {
  if (geoReader && ip) {
    try {
      const response = geoReader.country(ip);
      return response?.country?.isoCode || 'ZZ';
    } catch {
      return 'ZZ';
    }
  }
  return 'ZZ';
}

// Helper: parse and normalise browser/OS using UAParser
function parseUA(req) {
  const ua = new UAParser(req.headers['user-agent']).getResult();
  let browser = ua.browser.name || 'Other';
  let os = ua.os.name || 'Other';
  // normalise to a limited set to avoid high cardinality
  const knownBrowsers = ['Chrome', 'Firefox', 'Safari', 'Edge'];
  const knownOS = ['Windows', 'macOS', 'iOS', 'Android', 'Linux'];
  browser = knownBrowsers.includes(browser) ? browser : 'Other';
  os = knownOS.includes(os) ? os : 'Other';
  return { browser, os };
}

/**
 * GET /api/cameras
 *
 * Returns a list of cameras filtered by an optional bounding box and role.
 * The `bbox` query parameter should be a comma‑separated list of four numbers: minLng,minLat,maxLng,maxLat.
 * The `role` query parameter filters by camera role.
 */
app.get('/api/cameras', async (req, res) => {
  const { bbox, role } = req.query;
  try {
    const params = [];
    const whereClauses = [];
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
        return res
          .status(400)
          .json({ error: 'bbox must be four numeric values: minLng,minLat,maxLng,maxLat' });
      }
      const [minLng, minLat, maxLng, maxLat] = parts;
      params.push(minLng, minLat, maxLng, maxLat);
      // ST_MakeEnvelope expects minX, minY, maxX, maxY
      whereClauses.push(`ST_Contains(ST_MakeEnvelope($1, $2, $3, $4, 4326), geom)`);
    }
    if (role) {
      params.push(role);
      whereClauses.push(`role = $${params.length}`);
    }
    const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const query = `SELECT id, name, role, width, height, fps, video_profile, audio_enabled,
                          last_status, last_checked,
                          ST_X(geom::geometry) AS lng,
                          ST_Y(geom::geometry) AS lat
                   FROM cameras
                   ${where}`;
    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching cameras', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * GET /api/cameras/:id
 *
 * Returns a single camera by ID.
 */
app.get('/api/cameras/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, stream_url, width, height, fps, video_profile, audio_enabled,
              last_status, last_checked,
              ST_X(geom::geometry) AS lng,
              ST_Y(geom::geometry) AS lat
       FROM cameras
       WHERE id = $1`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'camera not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching camera', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /view-start
 *
 * Called when a viewer starts watching a camera.  Increments the view start counter
 * and the concurrent viewer gauge.  Expects a JSON body with `camera_id`.
 */
app.post('/view-start', (req, res) => {
  const { camera_id } = req.body;
  if (!camera_id) {
    return res.status(400).json({ error: 'camera_id is required' });
  }
  const ip = getClientIp(req);
  const country = getCountry(ip);
  const { browser, os } = parseUA(req);
  viewStartCounter.inc({ camera_id, country, browser, os });
  viewersGauge.inc({ camera_id, country });
  return res.status(204).send();
});

/**
 * POST /heartbeat
 *
 * Called periodically (e.g. every 10 seconds) while a viewer is watching.
 * Adds to the watched seconds counter.  Expects JSON body with `camera_id` and optional `seconds`.
 */
app.post('/heartbeat', (req, res) => {
  const { camera_id, seconds = 10 } = req.body;
  if (!camera_id) {
    return res.status(400).json({ error: 'camera_id is required' });
  }
  const ip = getClientIp(req);
  const country = getCountry(ip);
  viewSecondsCounter.inc({ camera_id, country }, seconds);
  return res.status(204).send();
});

/**
 * POST /view-end
 *
 * Called when a viewer stops watching a camera.  Decrements the concurrent viewer gauge.
 */
app.post('/view-end', (req, res) => {
  const { camera_id } = req.body;
  if (!camera_id) {
    return res.status(400).json({ error: 'camera_id is required' });
  }
  const ip = getClientIp(req);
  const country = getCountry(ip);
  viewersGauge.dec({ camera_id, country });
  return res.status(204).send();
});

/**
 * GET /metrics
 *
 * Prometheus scrape endpoint exposing default and custom metrics.
 */
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// Start the server
app.listen(port, () => {
  console.log(`CCTV backend listening on port ${port}`);
});