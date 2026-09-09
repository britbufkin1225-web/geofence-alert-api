# API Documentation

This document tracks the current and planned API endpoints for the GeoFence Alert API.

## Current API State

The current backend includes a functional geofence domain module with support for:

- Creating geofences
- Retrieving geofences
- Retrieving one geofence by ID
- Updating geofences
- Deleting geofences
- Pagination
- Status filtering
- Summary reporting
- DTO-based validation

---

Application routes are served under the `/api/v1` prefix. The `/health` and
`/status` operational endpoints remain unversioned at the root.

## Authentication

All routes are authenticated by default. Public routes: `/health`, `/status`,
the `/api/v1` root banner, `POST /api/v1/auth/register`, and
`POST /api/v1/auth/login`. Every other route requires an
`Authorization: Bearer <token>` header carrying a JWT issued by register/login.

The tenant context is derived from the verified token — never from the request
body, query, params, or a client-supplied header. See
[security.md](security.md) for the full model.

| Method | Endpoint | Purpose | Auth | Status |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | Create a user + tenant + membership atomically; returns a token | Public | Complete |
| POST | `/api/v1/auth/login` | Authenticate by email + password; returns a token | Public | Complete |
| GET | `/api/v1/auth/me` | Return the authenticated identity (never a password hash) | Bearer | Complete |

Auth errors: malformed body → `400`; duplicate registration → `409`; invalid
credentials → `401` (generic, no user enumeration); missing / malformed /
expired / bad-signature / wrong-algorithm token → `401`.

## Operational Endpoints

| Method | Endpoint | Purpose | Auth | Status |
| --- | --- | --- | --- | --- |
| GET | `/health` | Liveness check | Public | Complete |
| GET | `/status` | Service metadata and runtime status | Public | Complete |
| GET | `/api/v1/db/status` | Database connectivity check | Bearer | Complete |

## Geofence Endpoints

All geofence routes require a Bearer token and operate only within the caller's
tenant.

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| POST | `/api/v1/geofences` | Create a geofence owned by the caller's tenant | Complete |
| GET | `/api/v1/geofences` | Retrieve the caller tenant's geofences (pagination/filtering) | Complete |
| GET | `/api/v1/geofences/summary` | Aggregate summary for the caller's tenant | Complete |
| GET | `/api/v1/geofences/:id` | Retrieve one geofence by ID (own tenant only) | Complete |
| PATCH | `/api/v1/geofences/:id` | Update one geofence by ID (own tenant only) | Complete |
| DELETE | `/api/v1/geofences/:id` | Delete one geofence by ID (own tenant only) | Complete |

Route identifiers (`:id`) must be valid `cuid` values; malformed identifiers
return `400`. A valid-but-unknown id returns `404`, **as does a valid id that
belongs to another tenant** — the API does not disclose the existence of
resources outside the caller's tenant.

## Tracked Device and Location Event Endpoints (GF-4)

Both require a Bearer token and operate only within the caller's tenant. Full
contract in [gf4-location-event-ingestion.md](gf4-location-event-ingestion.md).

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| POST | `/api/v1/tracked-devices` | Register a location source owned by the caller's tenant | Complete |
| POST | `/api/v1/location-events` | Ingest one observation from one of those devices | Complete |

`POST /api/v1/tracked-devices` is registration only — the minimum needed to make
ingestion reachable. There is no list, read, update, deactivate or delete route.

Ingestion returns `201` when the event was stored and `200` when an identical
event with the same `eventKey` already existed (`"replayed": true`). Reusing an
`eventKey` with different observation data returns `409` and never overwrites the
stored event. A `deviceKey` the caller's tenant does not own returns the same
`404` as one that exists nowhere. An inactive device returns `409`.

GF-4 records observations only. Evaluating a stored observation against the
tenant's geofences is GF-5, below.

### Tracked device request body limits

| Field | Rule |
| --- | --- |
| `deviceKey` | Required string, trimmed, 1–128 chars, `[A-Za-z0-9._:-]+`, unique per tenant |
| `name` | Required string, trimmed, 1–120 chars, not blank |
| `isActive` | Optional boolean, default `true` |

### Location event request body limits

| Field | Rule |
| --- | --- |
| `deviceKey` | Required; must name a device the caller's tenant owns and has not deactivated |
| `eventKey` | Required string, trimmed, 1–200 chars, `[A-Za-z0-9._:-]+`; idempotency key |
| `observedAt` | Required ISO-8601 instant with explicit `Z` or `±HH:MM` offset; at most 5 minutes ahead of the server clock; no lower bound |
| `latitude` | Number in `-90`…`90` (inclusive) |
| `longitude` | Number in `-180`…`180` (inclusive) |
| `accuracyMeters` | Number in `0`…`100000` meters (inclusive) |

Timezone-free timestamps, impossible calendar dates, numeric strings, `NaN`,
`Infinity`, and unknown or server-owned properties (`tenantId`, `id`,
`trackedDeviceId`, `receivedAt`, `createdAt`, `observedPoint`) are rejected with
`400`.

## Geofence Evaluation Endpoint (GF-5, local only)

Implemented locally on the `phase-gf-5-deterministic-point-in-circle-evaluation`
branch; **not merged**.

| Method | Endpoint                                                       | Purpose                                                                      | Status           |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| GET    | `/api/v1/location-events/:locationEventId/geofence-evaluation` | Which active geofences of the caller's tenant contain one stored observation | Complete (local) |

Requires a Bearer token. The tenant comes from the verified principal; the only
input is the path identifier, which must be a valid `cuid` (`400` otherwise). The
endpoint accepts no coordinate, radius, tenant, device, active-status, ordering
or pagination parameter — it evaluates the point already stored on the named
event, never coordinates supplied with the request.

Semantics:

- Only **active** geofences belonging to the caller's own tenant are considered.
- Containment is evaluated by PostgreSQL/PostGIS over `geography` values, so the
  radius and the returned distance are in **meters** on the WGS 84 spheroid, not
  degrees.
- Containment is **boundary-inclusive**: `distance <= radiusMeters` is inside.
- `matches` is ordered by ascending distance before output rounding, then by
  ascending `geofenceId` for exact distance ties. Distinct distances that round
  to the same displayed number retain their original distance order.
- `distanceMeters` is rounded to three decimal places (millimeters) for output
  only; the containment decision uses the unrounded PostGIS value. JSON numbers
  omit trailing zeros. A rounded distance may exceed an unrounded radius by up
  to half a millimeter; this does not mean the observation is outside.
- The evaluation is **synchronous and read-only**. It stores no result and has no
  downstream effect.

An event that falls outside every geofence is a success, not an error: `200` with
`"matches": []` and `"matchCount": 0`. A `locationEventId` belonging to another
tenant returns the same `404` as one that exists nowhere.

```json
{
  "locationEventId": "clx1a2b3c4d5e6f7g8h9i0j1k",
  "trackedDeviceId": "clx9z8y7x6w5v4u3t2s1r0q9p",
  "observedAt": "2026-09-09T06:00:00.000Z",
  "latitude": 30.2672,
  "longitude": -97.7431,
  "matches": [
    {
      "geofenceId": "clx0000000000000000000001",
      "name": "Warehouse Zone",
      "latitude": 30.2672,
      "longitude": -97.743,
      "radiusMeters": 500,
      "distanceMeters": 9.652
    }
  ],
  "matchCount": 1
}
```

Enter/exit/dwell transitions, persisted evaluation results, alerts and
notification delivery are **not** part of GF-5 and remain future work.

---

## Query Parameters

The `GET /api/v1/geofences` endpoint supports query-based pagination, filtering,
and sorting.

| Query Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | integer | No | Page number. Default `1`, minimum `1`. |
| `limit` | integer | No | Records per page. Default `10`, minimum `1`, maximum `100`. |
| `active` | boolean | No | Filters geofences by active status (`true`/`false`). |
| `search` | string | No | Case-sensitive name substring filter (max 100 characters). |
| `sortBy` | string | No | `name`, `createdAt`, `updatedAt`, `radiusMeters`, or `isActive`. Default `createdAt`. |
| `sortOrder` | string | No | `asc` or `desc`. Default `desc`. |

## Request Body Limits

| Field | Rule |
| --- | --- |
| `name` | Required string, trimmed, 1–120 characters, not blank |
| `description` | Optional string, trimmed, max 1000 characters |
| `latitude` | Number in `-90`…`90` (inclusive) |
| `longitude` | Number in `-180`…`180` (inclusive) |
| `radiusMeters` | Number in `1`…`5000` meters (inclusive) |

Unknown properties are rejected. Update requests reject empty bodies and bodies
containing only unknown fields. Ownership fields such as `tenantId` are never
accepted on create or update (rejected as unknown properties), so ownership
cannot be forged or reassigned by a client.

### Auth request body limits

| Field | Rule |
| --- | --- |
| `email` | Required, valid email, canonicalized (trim + lowercase), max 254 chars, unique |
| `password` | Required string, 8–72 chars, never trimmed/transformed, never returned or logged |
| `tenantName` | Required string, trimmed, 1–120 chars, not blank |

## Error Contract

All error responses use a stable, non-leaky JSON shape:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["radiusMeters must not be greater than 5000"],
  "path": "/api/v1/geofences",
  "timestamp": "2026-08-05T00:00:00.000Z"
}
```

Example request:

```http
GET /api/v1/geofences?page=1&limit=10&active=true