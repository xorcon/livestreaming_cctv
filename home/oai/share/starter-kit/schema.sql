-- PostGIS-enabled schema for CCTV GIS application

-- Enable PostGIS extension (run as superuser)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Cameras table stores metadata about each CCTV camera
CREATE TABLE IF NOT EXISTS cameras (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  stream_url    TEXT NOT NULL,
  is_active     BOOLEAN DEFAULT TRUE,
  video_profile TEXT DEFAULT 'H264 Main',
  width         INT DEFAULT 640,
  height        INT DEFAULT 480,
  fps           INT DEFAULT 15,
  audio_enabled BOOLEAN DEFAULT FALSE,
  last_status   TEXT,
  last_checked  TIMESTAMPTZ,
  geom          GEOGRAPHY(POINT) NOT NULL
);

-- Spatial index to accelerate bounding box queries
CREATE INDEX IF NOT EXISTS idx_cameras_geom ON cameras USING GIST (geom);
-- Role index to accelerate filtering by role
CREATE INDEX IF NOT EXISTS idx_cameras_role ON cameras (role);