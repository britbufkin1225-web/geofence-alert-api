# Project Status

This document tracks the current development state of the GeoFence Alert API.

## Current Status

The GeoFence Alert API is an authenticated, multi-tenant backend. It has a
functional geofence domain module (CRUD, DTO validation, pagination, status
filtering, summary reporting) plus user identity, bcrypt password
authentication, JWT sessions, and strict per-tenant isolation (GF-2).

Persistence is **PostgreSQL with PostGIS** (GF-3, merged). Circle geofences store
a canonical `geography(Point, 4326)` centre, maintained by a database generated
column and indexed with GiST, alongside database-enforced CHECK constraints.

**GF-4 — authenticated location-event ingestion — is implemented locally on the
`phase-gf-4-authenticated-location-event-ingestion` feature branch and is not
merged.** It adds tenant-owned tracked devices, an authenticated ingestion
endpoint with database-enforced idempotency, and the same generated spatial point
representation for observations.

Spatial evaluation and alerting remain planned future work. Neither GF-3 nor GF-4
issues a spatial query — GF-4 records observations only.

## Completed Work

- Created NestJS project foundation
- Added environment variable documentation
- Added Prisma database foundation (SQLite; replaced in GF-3)
- Added Prisma service integration
- Created geofence domain module
- Added geofence DTOs
- Added geofence controller routes
- Added geofence service CRUD logic
- Added DTO validation support
- Added query DTO support
- Added pagination support for geofence lists
- Added status filtering for geofence lists
- Added geofence summary endpoint
- Added unit tests for geofence summary behavior
- Verified passing summary test suite
- Synced README with current project state
- Added API endpoint documentation
- Migrated persistence from SQLite to PostgreSQL (GF-3)
- Enabled PostGIS through a committed migration
- Added a generated `geography(Point, 4326)` geofence centre and GiST index
- Added database CHECK constraints for coordinates, radius, and required names
- Aligned Docker Compose with a pinned PostGIS image and a health check
- Added a disposable PostgreSQL/PostGIS migration and integration test workflow
- Added tenant-owned tracked devices and persistent location events (GF-4)
- Added an authenticated location-event ingestion endpoint with database-enforced
  idempotency and a documented replay-versus-conflict contract (GF-4)
- Added strict ISO-8601 instant parsing with a bounded future-clock allowance (GF-4)

## Current Backend Capabilities

The backend currently supports:

- Creating geofences
- Listing geofences
- Retrieving geofences by ID
- Updating geofences
- Deleting geofences
- Paginating geofence results
- Filtering geofences by status
- Returning geofence summary counts
- Validating request bodies and query parameters
- Storing a canonical spatial centre for every circle geofence
- Enforcing coordinate, radius, ownership and name rules in the database
- Registering tenant-owned tracked devices
- Ingesting authenticated device location observations
- Replaying identical submissions and rejecting conflicting, cross-tenant and
  inactive-device submissions
- Running Jest-based unit tests and real-database integration tests

## Current Testing State

Current verified test status:

```text
Unit + HTTP     Test Suites: 13 passed   Tests: 297 passed
Integration     Test Suites: 6 passed    Tests: 170 passed
E2E             Test Suites: 1 passed    Tests: 1 passed
```

The unit/HTTP suite (`npm test`) boots a real Nest application with a mocked
Prisma layer and needs no database. The integration suite (`npm run test:db`)
runs against a disposable PostgreSQL/PostGIS container that is created,
migrated, and removed by the test run.

Current test coverage includes:

- Geofence service/controller CRUD, summary, and tenant scoping
- Auth registration/login validation matrix and token handling
- Password hashing behavior (no plaintext, salted, 72-byte UTF-8 bound)
- Real-database tenant-isolation matrix (IDOR/BOLA) on PostgreSQL
- Stale/deleted membership and inconsistent JWT-claim rejection
- Migration deployment, PostGIS extension, geography column type and SRID
- GiST index presence and target column
- Database CHECK constraints, foreign keys, and required tenant ownership
- Scalar/spatial synchronization (longitude as X, latitude as Y, SRID 4326)
- DTO validation boundaries and route-identifier (cuid) validation
- `/api/v1` routing, the auth guard, and unversioned `/health` and `/status`
- Unknown-field / mass-assignment rejection and the stable error contract
- No internal error-detail leakage on failure paths
- Location-event ingestion (GF-4): authentication matrix, server-derived tenant,
  cross-tenant device non-disclosure, inactive-device refusal, coordinate /
  timestamp / accuracy / identifier validation boundaries, and the idempotent
  replay-versus-conflict contract including concurrent duplicates
- GF-4 database layer: generated `observedPoint`, `timestamptz` instant
  preservation, CHECK constraints (including `NaN`), the composite foreign key
  binding event tenant to device tenant, cascade behavior, and the idempotency
  unique index

## Known Planned Work

Upcoming development work includes:

- Spatial evaluation and point-in-geofence logic
- Alert domain planning
- Location event workflow planning
- Request and response examples for API documentation
- Portfolio polish and screenshots

## Current Project Phase

| Area | Status |
| --- | --- |
| Project foundation | Complete |
| Database foundation | Complete |
| Geofence CRUD | Complete |
| DTO validation | Complete |
| Pagination | Complete |
| Status filtering | Complete |
| Summary endpoint | Complete |
| Unit testing | Complete |
| Authentication (GF-2) | Complete |
| Tenant isolation (GF-2) | Complete |
| PostgreSQL/PostGIS foundation (GF-3) | Complete |
| Location events (GF-4) | Implemented on feature branch |
| Spatial evaluation | Next |
| Alert workflow | Planned |
| Documentation polish | In Progress |
| Portfolio polish | Planned |

## Next Planned Phase

**GF-5 — Deterministic point-in-circle geofence evaluation.**

GF-5 is not started. It will build on the GF-4 ingestion path by computing
containment for a stored location event against the caller tenant's active
geofences with `ST_DWithin`, using the existing
`Geofence_centerPoint_gist_idx`, as a pure synchronous read. Enter/exit
transitions, alert records, and alert delivery remain deferred beyond it.
