# Testing

This document tracks the current testing state for the GeoFence Alert API.

## Test Framework

This project uses Jest for backend unit testing.

Unit and HTTP tests live alongside the source files using the `.spec.ts`
pattern. Database integration tests live under `test/integration/` using the
`.integration-spec.ts` pattern and a separate Jest config
(`test/jest-integration.json`), so they never run as part of `npm test`.

```text
src/geofences/geofences.service.spec.ts        # unit
src/geofences/geofences.http.spec.ts           # HTTP, mocked Prisma
test/integration/spatial-sync.integration-spec.ts   # real PostGIS database
```

## Running Tests

```bash
npm test                  # unit + HTTP suite (mocked Prisma, no database)
npm test -- --runInBand   # same, deterministic ordering
npm run test:db           # disposable PostgreSQL/PostGIS verification (needs Docker)
```

`npm run test:db` is the command that proves the database layer. It starts the
throwaway PostGIS container defined in `docker-compose.test.yml`, waits for its
health check, runs `prisma migrate deploy`, regenerates Prisma Client, runs the
integration suite, and removes the container again.

`npm run test:integration` runs only the integration suite and expects
`DATABASE_URL` to already point at a running disposable database — use it while
iterating after `npm run test:db -- --keep`.

## Current Verified Test State

```text
Unit + HTTP     Test Suites: 10 passed   Tests: 121 passed
Integration     Test Suites: 4 passed    Tests: 85 passed
E2E             Test Suites: 1 passed    Tests: 1 passed
```

## Test Architecture

- **Unit tests** — services/controllers with a mocked Prisma provider
  (`geofences.service.spec.ts`, `geofences.controller.spec.ts`,
  `password.service.spec.ts`).
- **HTTP tests** — a real Nest app booted with a mocked Prisma layer, exercising
  routing, the global validation pipe, the auth guard, and the error contract
  (`geofences.http.spec.ts`, `auth/auth.http.spec.ts`). No database required.
- **Integration tests** (`test/integration/*.integration-spec.ts`) — run against
  a **real, migrated PostgreSQL/PostGIS database**:
  - `database-structure.integration-spec.ts` — migration ledger, PostGIS
    extension, the `geography(Point, 4326)` column, its STORED GENERATED
    definition, the GiST index, foreign keys, uniqueness rules, and the
    `VarChar` bounds.
  - `database-constraints.integration-spec.ts` — coordinate ranges, radius
    bounds, required/valid tenant ownership and non-blank names, proven by
    raw inserts that bypass the validation pipe entirely.
  - `spatial-sync.integration-spec.ts` — longitude→X / latitude→Y ordering,
    SRID 4326, recomputation on update, and PostgreSQL's refusal to let the
    spatial and scalar values diverge.
  - `tenant-isolation.integration-spec.ts` — the full GF-2 tenant-boundary
    matrix, ported unchanged from SQLite to PostgreSQL, plus anonymous-access
    denial.

### Disposable test database

The integration suite is destructive (it truncates tables), so it is fenced off
from developer data on several levels:

| Property | Developer stack (`docker-compose.yml`) | Disposable stack (`docker-compose.test.yml`) |
| --- | --- | --- |
| Compose project | directory default | `geofence-gf3-disposable-test` |
| Container | `geofence-alert-postgres` | `geofence-gf3-disposable-postgis` |
| Database | `geofence` (configurable) | `geofence_gf3_disposable` |
| Host port | `5432` | `127.0.0.1:55433` |
| Storage | named volume `geofence_postgres_data` | `tmpfs` (RAM) |

The guard requires the exact URL (scheme, fixture credentials, loopback address,
high port, database and sole schema parameter) before any connection. It then
inspects the local `desktop-linux` Docker context and requires the expected
container, project/service labels, image, credentials, port mapping, PGDATA,
tmpfs backing and health. The runner applies the same proof before migration and
checks project container identity before cleanup. Remote contexts, persistent
mounts, alternate URL encodings and query overrides fail closed. Teardown uses
plain `docker compose down` without orphan or volume removal.

The current runner targets Windows Docker Desktop (local named-pipe context).
`TEST_DB_PORT` may be a canonical port from 49152 through 65535; the runner
passes its resolved value to Compose so a local .env cannot silently override it.

There is no committed CI workflow. Required pre-push validation is:
`npm run lint`, `npm run build`, `npm test -- --runInBand`,
`npm run test:e2e`, and `npm run test:db`. A future CI workflow must invoke
all layers; `npm test` alone does not validate tenant isolation on PostgreSQL.

> Terminology note: the mocked HTTP tests are **not** database integration
> tests. Only the files under `test/integration/` run against a real database.

## Current Test Coverage

- Geofence service/controller CRUD, summary, and tenant scoping
- Auth registration/login validation matrix (email, password, tenant-name bounds)
- Token handling: missing, malformed, altered (bad signature), missing/expired
  expiry, `alg: none`, inconsistent claims, and deleted memberships
- Password hashing: no plaintext, per-hash salt, bcrypt 72-byte/UTF-8 bound
- Tenant-isolation matrix (real PostgreSQL): list/get/patch/delete/search/
  pagination/summary cannot cross tenants; ownership cannot be forged or
  reassigned; anonymous callers are refused
- Database structure: PostGIS extension, geography column type/SRID, GiST index,
  foreign keys, uniqueness rules
- Database constraints: coordinate ranges, radius bounds, ownership requirements
- Scalar/spatial synchronization: axis order, SRID stability, non-divergence
- User enumeration resistance (generic 401 for wrong password vs unknown account)
- DTO validation boundaries and route-identifier (cuid) validation
- `/api/v1` routing and unversioned public `/health` and `/status`
- Unknown-field / mass-assignment rejection and the stable, non-leaky error contract

## Planned Test Coverage

Additional planned test coverage includes:

- Location-event ingestion (GF-4)
- Spatial containment / `ST_DWithin` evaluation
- Enter/exit transition behavior
- Alert workflow behavior

## Testing Notes

Testing should be updated whenever new service methods, controller routes, DTO rules, or query behavior are added.

Each completed backend workflow should include either:

- A passing unit test
- A documented manual verification step
- A note explaining why the behavior is not currently test-covered
