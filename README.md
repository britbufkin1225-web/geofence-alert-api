# GeoFence Alert API

A backend API for managing geofence records, built with NestJS and Prisma.

> **Implementation status:** This repository is an authenticated, multi-tenant
> CRUD baseline. It implements user identity, password authentication (bcrypt),
> Bearer/JWT sessions, per-tenant ownership of geofences with strict cross-tenant
> isolation, and geofence create/read/update/delete with request validation,
> pagination, filtering, and a summary endpoint, backed by **SQLite** via Prisma.
> Location-event ingestion, spatial evaluation, alerting, and PostgreSQL/PostGIS
> are **planned roadmap items and are not implemented**. See
> [Currently Implemented vs Planned](#currently-implemented-vs-planned).

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
- User identity with bcrypt password hashing
- Bearer/JWT authentication (`register`, `login`, `me`) with a fail-closed
  signing-secret requirement
- Explicit User ↔ Tenant membership model
- Per-tenant ownership of geofences with server-derived tenant context
- Strict cross-tenant isolation (IDOR/BOLA mitigation), verified against a real
  SQLite database
- Geofence CRUD (create, list, get-by-id, update, delete) via Prisma + SQLite
- DTO-based request validation with bounded, deterministic limits
- Pagination and name/active filtering for the list endpoint
- Geofence summary (counts and radius aggregates)
- A consistent, non-leaky JSON error contract
- Unit, HTTP-level, and real-database integration tests

**Planned but not yet implemented:**

- PostgreSQL / PostGIS
- Location-event ingestion and history
- Spatial containment, enter/exit/dwell evaluation
- Alert creation and dispatch
- Refresh tokens, password reset, MFA, RBAC, rate limiting, account lockout
- Production deployment readiness
- Location-data retention / deletion controls

## Problem It Solves

Many applications rely on location-aware workflows, including delivery tracking, asset monitoring, safety alerts, field operations, and location-based automation.

This project demonstrates how a backend system can organize geofence data, receive location events, evaluate them against defined regions, and prepare structured alert responses.

## Core Features

**Implemented:**

- Bearer/JWT authentication (`/api/v1/auth/register`, `login`, `me`)
- User identity, tenants, and membership with tenant-owned geofences
- Strict cross-tenant isolation on every geofence operation
- REST API for geofence management (`/api/v1/geofences`)
- Health and status endpoints (`/health`, `/status`)
- Environment-based configuration with fail-closed auth secret validation
- SQLite-backed records via Prisma
- DTO-based request validation with bounded limits
- Query-based pagination and filtering (active status, name search, sorting)
- Geofence summary reporting
- Unit-, HTTP-, and integration-tested behavior
- Stable, non-leaky JSON error contract

**Planned:**

- Location event tracking
- Alert workflow support
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

**Authentication:** all routes are authenticated by default. Public routes are
`/health`, `/status`, the `/api/v1` root banner, and the two auth entry points
(`register`, `login`). Every other route requires an
`Authorization: Bearer <token>` header. The tenant context is derived from the
verified token — never from the request body, query, params, or a client header.

Current implemented endpoints:

| Method | Endpoint | Purpose | Auth | Status |
| --- | --- | --- | --- | --- |
| GET | `/health` | Liveness check (unversioned) | Public | Complete |
| GET | `/status` | Service metadata (unversioned) | Public | Complete |
| GET | `/api/v1` | Root greeting string | Public | Complete |
| POST | `/api/v1/auth/register` | Create a user + tenant, return a token | Public | Complete |
| POST | `/api/v1/auth/login` | Authenticate, return a token | Public | Complete |
| GET | `/api/v1/auth/me` | Return the authenticated identity | Bearer | Complete |
| GET | `/api/v1/db/status` | Database connectivity check | Bearer | Complete |
| POST | `/api/v1/geofences` | Create a geofence (owned by caller's tenant) | Bearer | Complete |
| GET | `/api/v1/geofences` | List the caller tenant's geofences | Bearer | Complete |
| GET | `/api/v1/geofences/summary` | Aggregate summary for the caller's tenant | Bearer | Complete |
| GET | `/api/v1/geofences/:id` | Retrieve a geofence by ID (own tenant only) | Bearer | Complete |
| PATCH | `/api/v1/geofences/:id` | Update a geofence by ID (own tenant only) | Bearer | Complete |
| DELETE | `/api/v1/geofences/:id` | Delete a geofence by ID (own tenant only) | Bearer | Complete |

A geofence that exists but belongs to another tenant is reported as `404 Not
Found` — the API does not confirm the existence of resources outside the
caller's tenant.

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

Auth request bodies are validated with these bounds:

| Field | Rule |
| --- | --- |
| `email` | Required, structurally valid email, canonicalized (trimmed + lowercased), max 254 characters, unique |
| `password` | Required string, 8–72 characters and at most 72 UTF-8 bytes, **never trimmed or transformed**, never returned or logged |
| `tenantName` | Required string, trimmed, 1–120 characters, not blank |

Update requests reject empty bodies and bodies containing only unknown fields.
Ownership fields such as `tenantId` are never accepted on create or update — they
are rejected as unknown properties.

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

The current Prisma schema (SQLite) defines these models with string `cuid`
primary keys:

| Entity | Status | Purpose |
| --- | --- | --- |
| User | Implemented | Login identity (unique email) and bcrypt password hash |
| Tenant | Implemented | Unit of data ownership and isolation |
| Membership | Implemented | Explicit User ↔ Tenant relationship (unique per pair) |
| Geofence | Implemented | Named circular geofence areas, owned by exactly one tenant |
| AlertEvent | Defined (schema only) | Alert records related to a geofence; no runtime logic yet |

Every geofence carries a required `tenantId` foreign key. Ownership is set
server-side from the authenticated principal and cannot be supplied or changed by
a client.

Planned future entities (not in the schema):

| Entity | Purpose |
| --- | --- |
| Tracked Device | Device or location source details |
| Location Event | Submitted latitude/longitude events |

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

See [docs/security.md](docs/security.md) for the full security architecture note.

Implemented security practices (enforced in code and regression-tested):

- Bcrypt password hashing; plaintext passwords are never stored, returned, or logged
- Bearer/JWT auth with pinned `HS256`, required expiry, and signature verification
- No insecure fallback secret; startup fails closed when `JWT_SECRET` is absent
- Server-derived tenant context and tenant-scoped database queries (IDOR/BOLA mitigation)
- Cross-tenant resources reported as `404` (no existence disclosure)
- Mass-assignment protection: ownership fields cannot be set or reassigned by clients
- Generic authentication failures that avoid user enumeration
- Input validation with bounded, deterministic limits
- A non-leaky JSON error contract (no stack traces, SQL, Prisma internals, or paths)
- No committed secrets; environment-based configuration

Planned/deferred controls: refresh-token rotation, password reset, MFA, RBAC,
rate limiting, and account lockout.

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

Authentication requires a signing secret. Set `JWT_SECRET` (minimum 32
characters) in your `.env`; the application **fails to start** without it. Never
commit a real secret — `.env.example` ships a placeholder only. Optionally set
`JWT_EXPIRES_IN` (default `1h`).

Common scripts:

```bash
npm run build      # compile
npm test           # run the Jest test suite
npm run lint       # non-mutating lint (CI/audit safe)
npm run lint:fix   # lint with autofix
```

## Testing
Detailed testing notes are available in [Testing Documentation](docs/testing.md).

This project uses Jest for unit tests and Supertest for HTTP-level tests. Most
tests boot a real Nest application with a mocked Prisma layer (no database
required). Tenant isolation is additionally proven by a **real database
integration test** that provisions an isolated, temporary SQLite database, applies
the project's actual migrations, and drives the API end-to-end before cleaning
itself up — it never touches your `dev.db`.

Current test coverage includes:

- Geofence service/controller CRUD, summary, and tenant scoping
- Registration and login validation matrix (email, password, tenant name bounds)
- Token handling (missing, malformed, altered, expired, `alg: none`)
- Password hashing (no plaintext, per-hash salt, bcrypt 72-byte bound)
- Tenant-isolation matrix against a real SQLite database (IDOR/BOLA)
- DTO validation boundaries and route-identifier (cuid) validation
- `/api/v1` routing, the auth guard, and unversioned `/health` and `/status`
- Unknown-field / mass-assignment rejection and the stable error contract
- No internal error-detail leakage on failure paths

Current verified test state:

```text
Test Suites: 10 passed
Tests: 116 passed
```

Additional planned testing includes:

- Alert workflow behavior
- Location-event processing

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
| Phase 8 | Unit testing foundation | Complete |
| GF-1 | Defensive validation baseline hardening | Complete |
| GF-2 | Identity, authentication + tenant isolation | Complete |
| GF-3+ | Spatial evaluation, location events, alerts | Planned |
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
