# CCTV GIS WebRTC Starter Kit

This starter kit implements the backend, database schema, metrics instrumentation and reference diagrams for building a map‑based CCTV viewer.  The goal of the project is to display thousands of CCTV cameras on a map, allow users to click markers to watch live streams via WebRTC, and collect usage analytics without re‑encoding the video.

## Project Structure

```
starter-kit/
├── README.md            – this file
├── package.json         – NPM metadata and dependencies
├── index.js             – Express backend exposing REST endpoints and Prometheus metrics
├── schema.sql           – SQL schema for the `cameras` table with PostGIS geometry
├── diagrams.mmd         – Mermaid diagrams of the system architecture and flows
└── .gitignore           – ignore rules for development artifacts
```

## Features

* **PostgreSQL + PostGIS**: Defines a `cameras` table to store camera metadata including id, name, role, stream URL, video settings and a geographical point.  Indexes are added to support efficient spatial queries and filtering by role.
* **Express API**: Provides endpoints to list cameras by bounding box and role, retrieve individual camera details, and collect viewer metrics.  A WebSocket or Server‑Sent Event (SSE) channel can be added to push status updates.
* **Metrics**: Uses [`prom-client`](https://github.com/siimon/prom-client) to export counters and gauges for view starts, concurrent viewers and watched seconds.  These can be scraped by Prometheus and visualised with Grafana.
* **GeoIP & User‑Agent Parsing**: Optionally resolves the viewer’s country code via MaxMind GeoIP and classifies browser/OS via User‑Agent.  These labels are exposed on the metrics to provide aggregated statistics per camera.
* **Mermaid Diagrams**: The `diagrams.mmd` file contains Mermaid definitions for the logical architecture, sequence diagram, health & metrics flows and deployment topology.  Paste it into a Mermaid viewer to render the diagrams.

## Prerequisites

* **Node.js** v18 or later
* **PostgreSQL** with the PostGIS extension enabled
* **Prometheus** and **Grafana** (optional, for metrics visualisation)
* **Media streaming layer** (e.g. [MediaMTX](https://github.com/bluenviron/mediamtx) or [go2rtc](https://github.com/AlexxIT/go2rtc)) and a [Janus Gateway](https://janus.conf.meetecho.com/) with STUN/TURN (e.g. coturn) for WebRTC.

## Installation

Clone this repository and install dependencies:

```sh
cd starter-kit
npm install
```

Create a `.env` file in the root of `starter-kit` with your database connection string and optional GeoIP configuration:

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/cctv
GEOIP_DB_PATH=/usr/share/GeoIP/GeoLite2-Country.mmdb
```

Create the `cameras` table in PostgreSQL and enable PostGIS by running the schema:

```sh
psql -d cctv -f schema.sql
```

## Running the Server

Start the backend:

```sh
node index.js
```

The server exposes:

* `GET /api/cameras?bbox=<minLng,minLat,maxLng,maxLat>&role=<role>` – Returns cameras within the bounding box and optional role.
* `GET /api/cameras/:id` – Returns a specific camera by ID.
* `POST /view-start` – Registers the start of a viewing session and increments the viewer counters.
* `POST /view-end` – Decrements the viewer counters when a session ends.
* `POST /heartbeat` – Adds to the watched seconds counter every few seconds.
* `GET /metrics` – Prometheus metrics endpoint.

You can point your map frontend to `/api/cameras` to fetch markers.  When a user clicks a camera, call `/view-start` to increment the metrics, open the WebRTC connection via Janus, and call `/view-end` when the connection is closed.

## Metrics & Monitoring

The starter kit exports three metrics:

* `webrtc_view_start_total{camera_id,country,browser,os}` – Counter of view starts.
* `webrtc_viewers_gauge{camera_id,country}` – Gauge of concurrent viewers.
* `webrtc_view_seconds_total{camera_id,country}` – Counter of watched seconds.

Scrape `/metrics` with Prometheus, then use Grafana to create dashboards such as:

* Top N cameras by views in the last 30 days:

  ```promql
  topk(10, sum by (camera_id) (increase(webrtc_view_start_total[30d])))
  ```

* Watched hours per camera in the last 30 days:

  ```promql
  sum by (camera_id) (increase(webrtc_view_seconds_total[30d])) / 3600
  ```

* Viewer distribution by country:

  ```promql
  sum by (country) (increase(webrtc_view_start_total[30d]))
  ```

For long‑term business reporting, consider streaming the session events to a time‑series database like ClickHouse.

## Notes

* The system assumes that CCTV cameras provide a secondary stream (`sub-stream`) with **H.264 Main** profile at **640×480** resolution and **no audio**.  This allows the video to be passed directly to the browser via WebRTC without re‑encoding.
* The API does not include any credentials; ensure that you store camera passwords in a secure secret manager outside of source control.
* Modify `index.js` to suit your authentication/authorisation requirements and to integrate with Janus or other media gateways.

Enjoy building your GIS + WebRTC CCTV application!