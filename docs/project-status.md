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

**GF-4 — authenticated location-event ingestion — is merged.** It adds
tenant-owned tracked devices, an authenticated ingestion endpoint with
database-enforced idempotency, and the same generated spatial point
representation for observations.

**GF-5 — deterministic point-in-circle geofence evaluation — is merged.** It adds
one authenticated, read-only endpoint that answers which active geofences of the
caller's tenant contain one already-stored location event. Containment is decided
by PostgreSQL/PostGIS over `geography` values, so it is boundary-inclusive and
measured in meters, and matches are ordered deterministically by distance then
geofence id.

**GF-6 — deterministic geofence transition detection — is merged.** It classifies every accepted observation against every active
geofence of its tenant as `BASELINE_INSIDE`, `BASELINE_OUTSIDE`, `ENTER`, `EXIT`,
`STAY_INSIDE` or `STAY_OUTSIDE`, and persists one current-state row per tenant,
device and geofence so the next comparison is deterministic. Comparison and
advancement are a single atomic `INSERT ... ON CONFLICT DO UPDATE`, ordered by the
source's own `observedAt` with the event id as tie-break, so out-of-order and
replayed events can neither regress state nor fabricate a crossing. The
classification is returned as an additive array on the existing ingestion
response; GF-5's evaluation endpoint is unchanged and still read-only.

**GF-7 — deterministic alert-event creation and deduplication — is implemented
locally on the `phase-gf-7-deterministic-alert-event-creation-deduplication`
feature branch and is awaiting independent audit; it is not merged.** It converts
only authoritative accepted `ENTER` and `EXIT` crossings into durable, tenant-scoped
alert events. Baselines, stays, stale observations, replay-only requests,
deactivation and failure paths create no new alert. Deduplication is a database
unique key on
`(tenantId, trackedDeviceId, geofenceId, sourceLocationEventId, transition)`
combined with a conflict-safe insert, so one crossing is one alert across retries,
replays and concurrent duplicates; a uniqueness conflict is idempotent success,
not an error. The alert commits in the same transaction as the transition
advancement it describes, so an accepted crossing and its alert become durable
together or neither does. Location-event creation remains outside that
transaction, exactly as in GF-6: a failure there leaves the event stored, and an
identical retry converges to exactly one alert unless a newer observation has
superseded it. Alert ownership and source provenance are tenant-scoped and
enforced by composite foreign keys, so a cross-tenant alert cannot be stored even
by a direct database write. The alert is exposed as one additive optional `alert`
field on each transition entry of the existing ingestion response.

Dwell detection, notification delivery (email, SMS, push, webhooks), asynchronous
processing, and alert querying, acknowledgement and resolution remain planned
future work. GF-7 creates no notification or delivery record and sends nothing.

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
- Added deterministic, read-only point-in-circle geofence evaluation for a stored
  location event, decided by PostGIS geography semantics (GF-5)
- Added deterministic geofence transition detection with atomic, tenant-isolated
  per-device transition state and documented baseline, stale-event, replay and
  reactivation policies (GF-6)
- Added deterministic, deduplicated alert-event creation for accepted enter/exit
  crossings, committed in the same transaction as the transition state it
  describes and enforced by a database unique key and tenant-consistent composite
  foreign keys (GF-7, feature branch)

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
- Evaluating one stored observation against the caller tenant's active geofences,
  boundary-inclusive and in meters, with deterministic ordering
- Running Jest-based unit tests and real-database integration tests

## Current Testing State

Verified test state after GF-6 hardening:

```text
Unit + HTTP     Test Suites: 16 passed   Tests: 387 passed
Integration     Test Suites: 8 passed    Tests: 263 passed
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

- Alert delivery: notification channels and providers
- Alert querying, acknowledgement and resolution endpoints
- Dwell detection and polygon geofences
- Location-event history and query endpoints
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
| Location events (GF-4) | Complete |
| Spatial evaluation (GF-5) | Complete |
| Transition detection (GF-6) | Complete |
| Alert-event creation (GF-7) | Implemented on feature branch |
| Alert delivery and management | Planned |
| Documentation polish | In Progress |
| Portfolio polish | Planned |

## Next Planned Phase

**GF-8 — Alert delivery.**

GF-6 is merged. GF-7 alert-event creation is implemented on its feature branch and
awaiting independent audit: crossings are now recorded durably and exactly once.
Delivering those records — notification channels, providers, retry and the
asynchronous processing they need — remains unimplemented future work, as do dwell
detection and the alert-management workflows (querying, acknowledgement,
resolution).
