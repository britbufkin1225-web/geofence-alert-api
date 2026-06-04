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

## Geofence Endpoints

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| POST | `/geofences` | Create a new geofence | Complete |
| GET | `/geofences` | Retrieve geofences with pagination and filtering support | Complete |
| GET | `/geofences/summary` | Retrieve aggregate geofence summary counts | Complete |
| GET | `/geofences/:id` | Retrieve one geofence by ID | Complete |
| PATCH | `/geofences/:id` | Update one geofence by ID | Complete |
| DELETE | `/geofences/:id` | Delete one geofence by ID | Complete |

---

## Query Parameters

The `GET /geofences` endpoint supports query-based pagination and filtering.

| Query Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | number | No | Page number for paginated results. Defaults to `1`. |
| `limit` | number | No | Number of records returned per page. |
| `status` | string | No | Filters geofences by status. |

Example request:

```http
GET /geofences?page=1&limit=10&status=active