# GeoFence Alert API

A backend API for managing geofence records, built with NestJS and Prisma.

> **Implementation status:** This repository is an early-stage CRUD baseline.
> It currently implements geofence create/read/update/delete with request
> validation, pagination, filtering, and a summary endpoint, backed by
> **SQLite** via Prisma. Location-event ingestion, spatial evaluation, alerting,
> authentication, and PostgreSQL/PostGIS are **planned roadmap items and are not
> implemented**. See [Currently Implemented vs Planned](#currently-implemented-vs-planned).

## Project Summary

GeoFence Alert API is a backend-focused portfolio project whose long-term vision
combines API development, geospatial logic, database design, and alert workflow
management.

The eventual goal is to manage geofence regions, process location events, and
prepare alert records when a tracked device enters or exits a defined area. Today
the codebase provides the geofence-management foundation for that vision.

## Currently Implemented vs Planned

**Currently implemented (verified in code):**

- NestJS application with a `/api/v1` route prefix
- Unversioned `/health` and `/status` operational endpoints
- Geofence CRUD (create, list, get-by-id, update, delete) via Prisma + SQLite
- DTO-based request validation with bounded, deterministic limits
- Pagination and name/active filtering for the list endpoint
- Geofence summary (counts and radius aggregates)
- A consistent, non-leaky JSON error contract
- Unit and HTTP-level regression tests (no external database required)

**Planned but not yet implemented:**

- Authentication and authorization
- Users, tenants, or ownership isolation
- PostgreSQL / PostGIS
- Location-event ingestion and history
- Spatial containment, enter/exit/dwell evaluation
- Alert creation and dispatch
- Production deployment readiness
- Location-data retention / deletion controls

## Problem It Solves

Many applications rely on location-aware workflows, including delivery tracking, asset monitoring, safety alerts, field operations, and location-based automation.

This project demonstrates how a backend system can organize geofence data, receive location events, evaluate them against defined regions, and prepare structured alert responses.

## Core Features

**Implemented:**

- REST API for geofence management (`/api/v1/geofences`)
- Health and status endpoints (`/health`, `/status`)
- Environment-based configuration
- SQLite-backed geofence records via Prisma
- DTO-based request validation with bounded limits
- Query-based pagination and filtering (active status, name search, sorting)
- Geofence summary reporting
- Unit- and HTTP-tested geofence behavior
- Stable, non-leaky JSON error contract

**Planned:**

- Location event tracking
- Alert workflow support
- Authentication and user-owned resources
- PostgreSQL / PostGIS spatial features

## Tech Stack

| Area | Tools |
| --- | --- |
| Backend | NestJS, TypeScript, Node.js (>=20) |
| Database (current) | SQLite via Prisma (`@prisma/adapter-better-sqlite3`) |
| Database (planned) | PostgreSQL, PostGIS |
| Validation | class-validator, class-transformer |
| Testing | Jest, Supertest |
| Project Management | GitHub Projects, Issues, Labels |
| Documentation | Markdown, GitHub README |
| Version Control | Git, GitHub |

## Project Architecture

Planned architecture:

```text
Client / Location Source
        |
        v
GeoFence Alert API
        |
        |-- Health / Status Endpoints
        |-- Geofence Management
        |-- Location Event Processing
        |-- Alert Workflow
        |
        v
PostgreSQL + PostGIS
```

Architecture diagrams and screenshots will be added as the project develops.

## API Endpoints

Detailed endpoint documentation is available in [API Documentation](docs/api.md).

Application API routes are served under the `/api/v1` prefix. The `/health` and
`/status` operational endpoints are intentionally left unversioned at the root.

Current implemented endpoints:

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| GET | `/health` | Liveness check (unversioned) | Complete |
| GET | `/status` | Service metadata (unversioned) | Complete |
| GET | `/api/v1` | Root greeting string | Complete |
| GET | `/api/v1/db/status` | Database connectivity check | Complete |
| POST | `/api/v1/geofences` | Create a geofence | Complete |
| GET | `/api/v1/geofences` | List geofences with pagination and filtering | Complete |
| GET | `/api/v1/geofences/summary` | Return aggregate geofence summary counts | Complete |
| GET | `/api/v1/geofences/:id` | Retrieve a geofence by ID | Complete |
| PATCH | `/api/v1/geofences/:id` | Update a geofence by ID | Complete |
| DELETE | `/api/v1/geofences/:id` | Delete a geofence by ID | Complete |

Planned future endpoints (not implemented):

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| GET | `/api/v1/alert-events` | List alert events | Planned |
| POST | `/api/v1/location-events` | Submit a location event | Planned |

### Geofence Query Parameters

The `GET /api/v1/geofences` endpoint supports pagination, filtering, and sorting.

| Query Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | integer | No | Page number. Default `1`, minimum `1`. |
| `limit` | integer | No | Records per page. Default `10`, minimum `1`, maximum `100`. |
| `active` | boolean | No | Filters by active status (`true` or `false`). |
| `search` | string | No | Case-sensitive name substring filter (max 100 characters). |
| `sortBy` | string | No | One of `name`, `createdAt`, `updatedAt`, `radiusMeters`, `isActive`. Default `createdAt`. |
| `sortOrder` | string | No | `asc` or `desc`. Default `desc`. |

### Validation Limits

Request bodies are validated with the following bounds (unknown properties are
rejected):

| Field | Rule |
| --- | --- |
| `name` | Required string, trimmed, 1–120 characters, not blank |
| `description` | Optional string, trimmed, max 1000 characters |
| `latitude` | Number in `-90`…`90` (inclusive) |
| `longitude` | Number in `-180`…`180` (inclusive) |
| `radiusMeters` | Number in `1`…`5000` meters (inclusive) |
| Route `:id` | Must be a valid cuid; malformed ids return `400` |

Update requests reject empty bodies and bodies containing only unknown fields.

### Error Contract

All errors return a stable JSON shape and never leak stack traces, Prisma
internals, SQL, or filesystem paths:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["radiusMeters must not be greater than 5000"],
  "path": "/api/v1/geofences",
  "timestamp": "2026-08-05T00:00:00.000Z"
}
```

## Database Design

The current Prisma schema (SQLite) defines two models with string `cuid`
primary keys:

| Entity | Status | Purpose |
| --- | --- | --- |
| Geofence | Implemented | Named circular geofence areas (lat/long/radius, active flag) |
| AlertEvent | Defined (schema only) | Alert records related to a geofence; no runtime logic yet |

Planned future entities (not in the schema):

| Entity | Purpose |
| --- | --- |
| User | Account ownership and isolation |
| Tracked Device | Device or location source details |
| Location Event | Submitted latitude/longitude events |

There is no `users` table and no ownership relationship in the current schema.

Detailed schema documentation is available in [Database Schema](docs/database-schema.md).

The schema documentation explains planned tables, relationships, foreign keys, example data flow, backend value, and future database improvements.

## Project Management
Session history is tracked in [Session Log](docs/session-log.md).

Development for the GeoFence Alert API is tracked using GitHub Projects.

The project board organizes work across backend API development, geospatial logic, database design, environment configuration, security, testing, documentation, and portfolio polish.

### Workflow

| Status | Purpose |
| --- | --- |
| Backlog | Future features, ideas, and planned improvements |
| Ready | Defined tasks ready for development |
| In Progress | Work currently being built |
| In Review | Completed work awaiting testing, cleanup, or documentation |
| Done | Fully completed, tested, committed, and documented |

This workflow shows the full development process from planning through implementation, review, and completion.

## Security Considerations

Planned security practices include:

- No committed secrets
- Environment-based configuration
- Input validation
- Clear error handling
- Safe database configuration
- API request validation
- Security documentation through `SECURITY.md`

## Local Development

Setup flow:

```bash
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

The application uses a local SQLite database file (`DATABASE_URL="file:./dev.db"`
by default). Real `.env` files should not be committed.

Common scripts:

```bash
npm run build      # compile
npm test           # run the Jest test suite
npm run lint       # non-mutating lint (CI/audit safe)
npm run lint:fix   # lint with autofix
```

## Testing
Detailed testing notes are available in [Testing Documentation](docs/testing.md).

This project uses Jest for unit tests and Supertest for HTTP-level tests. The
HTTP tests boot a real Nest application with a mocked Prisma layer, so **no
database is required to run the suite**.

Current test coverage includes:

- Geofence service CRUD and summary behavior
- Controller route behavior and not-found handling
- DTO validation boundaries (name, coordinates, radius, pagination, search)
- Route-identifier (cuid) validation
- `/api/v1` routing and unversioned `/health` and `/status`
- Unknown-field rejection and the stable error contract
- No internal error-detail leakage on failure paths

Current verified test state:

```text
Test Suites: 7 passed
Tests: 73 passed
```

Additional planned testing includes:

- Alert workflow behavior
- Location-event processing
- Real database integration tests

## Roadmap

| Phase | Focus | Status |
| --- | --- | --- |
| Phase 1 | Project foundation | Complete |
| Phase 2 | Core API endpoints | Complete |
| Phase 3 | Database schema | Complete |
| Phase 4 | Geofence CRUD logic | Complete |
| Phase 5 | DTO validation | Complete |
| Phase 6 | Pagination and filtering | Complete |
| Phase 7 | Geofence summary endpoint | Complete |
| Phase 8 | Unit testing foundation | In Progress |
| Phase 9 | Alert workflow | Planned |
| Phase 10 | Documentation polish | In Progress |
| Phase 11 | Portfolio polish | Planned |

## Portfolio Value

This project is designed to demonstrate:

- Backend API architecture
- TypeScript/NestJS development
- GIS-aware backend design
- Database schema planning
- PostgreSQL/PostGIS concepts
- Secure configuration handling
- API testing and documentation
- Professional GitHub project workflow
