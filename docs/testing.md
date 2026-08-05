# Testing

This document tracks the current testing state for the GeoFence Alert API.

## Test Framework

This project uses Jest for backend unit testing.

Tests are located alongside source files using the `.spec.ts` naming pattern.

Current examples:

```text
src/geofences/geofences.service.spec.ts
src/geofences/geofences.controller.spec.ts
```

## Running Tests

Run the full test suite with:

```bash
npm run test
```

## Current Verified Test State

The current verified test state is:

```text
Test Suites: 10 passed
Tests: 116 passed
```

Run the suite deterministically with `npm test -- --runInBand`.

## Test Architecture

- **Unit tests** — services/controllers with a mocked Prisma provider
  (`geofences.service.spec.ts`, `geofences.controller.spec.ts`,
  `password.service.spec.ts`).
- **HTTP tests** — a real Nest app booted with a mocked Prisma layer, exercising
  routing, the global validation pipe, the auth guard, and the error contract
  (`geofences.http.spec.ts`, `auth/auth.http.spec.ts`). No database required.
- **Real database integration test** — `auth/tenant-isolation.spec.ts`
  provisions an isolated temporary SQLite database, applies the project's actual
  migrations, and drives the API end-to-end to prove the tenant boundary. It
  never touches `dev.db` and cleans up after itself.

> Terminology note: the mocked HTTP tests are **not** database integration tests.
> Only `tenant-isolation.spec.ts` runs against a real database.

## Current Test Coverage

- Geofence service/controller CRUD, summary, and tenant scoping
- Auth registration/login validation matrix (email, password, tenant-name bounds)
- Token handling: missing, malformed, altered (bad signature), expired, `alg: none`
- Password hashing: no plaintext, per-hash salt, bcrypt 72-byte bound
- Tenant-isolation matrix (real DB): list/get/patch/delete/search/pagination/
  summary cannot cross tenants; ownership cannot be forged or reassigned
- User enumeration resistance (generic 401 for wrong password vs unknown account)
- DTO validation boundaries and route-identifier (cuid) validation
- `/api/v1` routing and unversioned public `/health` and `/status`
- Unknown-field / mass-assignment rejection and the stable, non-leaky error contract

## Planned Test Coverage

Additional planned test coverage includes:

- Location-event processing behavior
- Spatial containment / point-in-geofence evaluation
- Alert workflow behavior

## Testing Notes

Testing should be updated whenever new service methods, controller routes, DTO rules, or query behavior are added.

Each completed backend workflow should include either:

- A passing unit test
- A documented manual verification step
- A note explaining why the behavior is not currently test-covered