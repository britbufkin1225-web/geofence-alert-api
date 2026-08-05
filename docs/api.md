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

## Operational Endpoints

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| GET | `/health` | Liveness check | Complete |
| GET | `/status` | Service metadata and runtime status | Complete |
| GET | `/api/v1/db/status` | Database connectivity check | Complete |

## Geofence Endpoints

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| POST | `/api/v1/geofences` | Create a new geofence | Complete |
| GET | `/api/v1/geofences` | Retrieve geofences with pagination and filtering support | Complete |
| GET | `/api/v1/geofences/summary` | Retrieve aggregate geofence summary counts | Complete |
| GET | `/api/v1/geofences/:id` | Retrieve one geofence by ID | Complete |
| PATCH | `/api/v1/geofences/:id` | Update one geofence by ID | Complete |
| DELETE | `/api/v1/geofences/:id` | Delete one geofence by ID | Complete |

Route identifiers (`:id`) must be valid `cuid` values; malformed identifiers
return `400`, while a valid-but-unknown id returns `404`.

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
containing only unknown fields.

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