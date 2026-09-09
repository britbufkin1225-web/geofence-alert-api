# Database Schema

> **Implementation status.** The database is **PostgreSQL with PostGIS** (GF-3).
> The Prisma schema contains `User`, `Tenant`, `Membership`, `Geofence`,
> `AlertEvent`, and — added in GF-4 — `TrackedDevice` and `LocationEvent`;
> primary keys are string `cuid` values, **not** UUIDs. Identity and per-tenant
> ownership are implemented (GF-2). Circle geofences carry a canonical
> `geography(Point, 4326)` centre with a GiST index, and location events carry
> the same generated point representation. Spatial *evaluation* — containment,
> distance, enter/exit — is **not** implemented; GF-3 and GF-4 build storage and
> ingestion only. The legacy "planned" section at the end of this document
> predates GF-2 and is retained as historical context.

## Current Schema (Implemented)

Source of truth: [`prisma/schema.prisma`](../prisma/schema.prisma), provider
`postgresql`.

Prisma 7 no longer accepts a `url` inside the `datasource` block; the connection
string comes from `DATABASE_URL` via [`prisma.config.ts`](../prisma.config.ts)
for the CLI and via the driver adapter in
[`src/prisma/prisma.service.ts`](../src/prisma/prisma.service.ts) at runtime.

### `User` (implemented)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `email` | `varchar(254)` | **Unique** login identity (canonicalized: trimmed + lowercased). Length matches the RFC 5321 bound in the auth DTOs |
| `passwordHash` | `text` | Bcrypt hash; plaintext is never stored. Deliberately unbounded — its length is a property of the algorithm, not an API contract |
| `createdAt` | `timestamp(3)` | Set on create |
| `updatedAt` | `timestamp(3)` | Updated on change |

CHECK `User_email_not_blank_check`: the email is non-blank and carries no
surrounding whitespace.

### `Tenant` (implemented)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `name` | `varchar(120)` | Human-readable tenant name |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps |

CHECK `Tenant_name_not_blank_check`: the name is non-blank.

### `Membership` (implemented)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `userId` | `text` | FK → `User.id` (cascade delete) |
| `tenantId` | `text` | FK → `Tenant.id` (cascade delete) |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps |

Unique constraint on `(userId, tenantId)`; indexed on `tenantId`. Membership is
the explicit link that authorizes a user to act within a tenant.

### `Geofence` (implemented)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `tenantId` | `text` | **Required** FK → `Tenant.id` (cascade delete); set server-side, indexed |
| `name` | `varchar(120)` | Required, non-blank |
| `description` | `varchar(1000)` | Optional |
| `latitude` | `double precision` | Centre latitude, −90…90 |
| `longitude` | `double precision` | Centre longitude, −180…180 |
| `radiusMeters` | `double precision` | Radius in metres, ≥ 1 and ≤ 5000 |
| `isActive` | `boolean` | Defaults to `true` |
| `centerPoint` | `geography(Point, 4326)` | **Generated** — see below. Not readable or writable through Prisma Client |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps |

Every query for tenant-owned data is scoped by `tenantId` derived from the
authenticated principal. See [security.md](security.md).

### `AlertEvent` (implemented, GF-7 — local only, awaiting audit)

One durable record that a device crossed one geofence boundary in one direction,
at one observed instant. GF-7 reuses the table declared unused by the GF-1
baseline rather than adding a competing one.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key; the stable alert identity the API returns |
| `tenantId` | `text` | **Required**; from the verified principal, never a request |
| `trackedDeviceId` | `text` | **Required**; from the stored location event |
| `geofenceId` | `text` | **Required**; the geofence whose boundary was crossed |
| `sourceLocationEventId` | `text` | **Required**; the observation that produced the crossing |
| `transition` | enum `GeofenceTransition` | **Required**; `ENTER` or `EXIT` only, by CHECK |
| `observedAt` | `timestamptz(3)` | The source's own instant, copied from the event |
| `eventType` | `text` | Legacy, nullable, unwritten — see below |
| `severity` | enum `AlertSeverity` | Legacy; default `MEDIUM`; never read or advanced by GF-7 |
| `status` | enum `AlertStatus` | Legacy; default `OPEN`; never read or advanced by GF-7 |
| `message` | `text` | Legacy, nullable, unwritten — see below |
| `source` | `text` | Legacy, nullable, unwritten |
| `latitude` / `longitude` | `double precision` | Legacy, nullable, unwritten; range-checked when present |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps; `createdAt` is the durable recording time |

Constraints and indexes:

- `AlertEvent_crossing_key` — unique on
  `(tenantId, trackedDeviceId, geofenceId, sourceLocationEventId, transition)`.
  This is the deduplication boundary and the conflict target of the phase's
  conflict-safe insert: one accepted crossing is one alert, whatever the retry,
  replay or race.
- `AlertEvent_transition_crossing_check` — `CHECK ("transition" IN ('ENTER','EXIT'))`.
  A baseline, a stay or a stale observation cannot be recorded as an alert by any
  code path, including a direct SQL session.
- Three composite foreign keys on `(id, tenantId)` — onto `Geofence`,
  `TrackedDevice` and `LocationEvent`, all `ON DELETE CASCADE`. A cross-tenant
  alert is rejected by PostgreSQL, not merely avoided by the service. The GF-1
  single-column `AlertEvent_geofenceId_fkey` is replaced by the composite
  `AlertEvent_geofenceId_tenantId_fkey`, which enforces everything the old key
  did and tenant agreement as well.
- `AlertEvent_tenantId_sourceLocationEventId_idx` and
  `AlertEvent_tenantId_geofenceId_idx` — the read-back and the cascades. Tenant
  and device lookups need no index of their own: they are the leading columns of
  the unique key.

The legacy `eventType`, `message` and `source` columns were relaxed to nullable by
the GF-7 migration and are deliberately left `NULL`. The authoritative crossing
type is the typed `transition` column, so writing it again as free text would
create a value that can disagree with it, and inventing a `message` would
fabricate a notification template for a phase that sends nothing. No coordinate,
distance, delivery, dwell or acknowledgement column exists.

See [gf7-geofence-alert-events.md](gf7-geofence-alert-events.md).

### `TrackedDevice` (implemented, GF-4)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `tenantId` | `text` | **Required** FK → `Tenant.id` (cascade delete); set server-side, indexed |
| `deviceKey` | `varchar(128)` | External key the source reports; unique **within** a tenant, non-blank |
| `name` | `varchar(120)` | Required, non-blank |
| `isActive` | `boolean` | Defaults to `true`; an inactive device cannot ingest |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps |

`@@unique([tenantId, deviceKey])` lets two tenants use the same external key for
unrelated devices without colliding. `@@unique([id, tenantId])` exists so
`LocationEvent` can reference the pair — see below.

### `LocationEvent` (implemented, GF-4)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `tenantId` | `text` | Server-derived; part of the composite FK below |
| `trackedDeviceId` | `text` | Resolved within the caller's tenant |
| `eventKey` | `varchar(200)` | Client idempotency key, non-blank |
| `observedAt` | `timestamptz(3)` | Instant supplied by the source |
| `receivedAt` | `timestamptz(3)` | Server receipt, `DEFAULT CURRENT_TIMESTAMP` |
| `latitude` | `double precision` | −90…90, not `NaN` |
| `longitude` | `double precision` | −180…180, not `NaN` |
| `accuracyMeters` | `double precision` | 0…100000, not `NaN` |
| `observedPoint` | `geography(Point, 4326)` | **Generated** — same construction as `Geofence.centerPoint` |

Rows are append-only, so the model carries a single `receivedAt` rather than the
`createdAt`/`updatedAt` pair used by the mutable models; an `updatedAt` column
would advertise a mutability the ingestion contract does not have.

Both timestamps are `timestamptz` rather than the plain `timestamp` used by the
older bookkeeping columns: `observedAt` comes from an external source with its
own clock and offset, so preserving the absolute instant exactly is part of the
contract.

Two constraints carry the ownership invariant:

- `@@unique([tenantId, trackedDeviceId, eventKey])` — the idempotency boundary,
  tenant-qualified in its own right so one tenant's event key can never collide
  with or disclose another's.
- The composite foreign key `(trackedDeviceId, tenantId)` →
  `TrackedDevice(id, tenantId)` — PostgreSQL rejects any event whose tenant
  disagrees with its device's tenant, so the invariant does not depend on the
  service layer being correct. Deletion cascades
  `Tenant → TrackedDevice → LocationEvent`.

`@@unique([id, tenantId])` was added by GF-6 so `GeofenceDeviceState` can
reference the pair — see below.

`LocationEvent` has **no** GiST index, deliberately: the containment query a
later phase will run probes the *geofence* index, and indexing observations would
serve only a location-history API that does not exist. The integration suite
asserts the absence so it stays a recorded decision. See
[gf4-location-event-ingestion.md](gf4-location-event-ingestion.md).

### `GeofenceDeviceState` (implemented, GF-6)

The transition state of one device against one geofence — the whole of GF-6's
persistence.

| Column | Type | Notes |
| --- | --- | --- |
| `tenantId` | `text` | Part of the primary key and of all three composite FKs |
| `trackedDeviceId` | `text` | Part of the primary key |
| `geofenceId` | `text` | Part of the primary key |
| `state` | `GeofenceContainmentState` | `INSIDE` / `OUTSIDE` at the last accepted observation |
| `lastTransition` | `GeofenceTransition` | The classification that observation produced |
| `lastLocationEventId` | `text` | Which observation the state came from |
| `lastObservedAt` | `timestamptz(3)` | When that observation was taken, per the source |
| `createdAt` / `updatedAt` | `timestamp(3)` | Written explicitly by the upsert, not by Prisma Client |

`@@id([tenantId, trackedDeviceId, geofenceId])` — the identity **is** the
uniqueness constraint, and it is the conflict target of the single
`INSERT ... ON CONFLICT DO UPDATE` statement that compares and advances state
atomically. There is no surrogate `cuid`: the row has no identity of its own to
name, and every write to this table is raw SQL, which cannot invoke Prisma's
`cuid()`.

All three foreign keys are composite on `(id, tenantId)` — onto `Geofence`,
`TrackedDevice` and `LocationEvent` — so PostgreSQL rejects any state row whose
tenant disagrees with its geofence, device or source event. Deletion cascades from
all three, and from `Tenant` through them.

No distance, latitude or longitude is stored: distance is a presentation value
derived from the geography columns on demand, and persisting it would create a
second, staler answer. There is deliberately **no transition-history table** —
only the current state is needed to compare consecutive observations, and durable
alert-event generation belongs to GF-7. See
[gf6-geofence-transition-detection.md](gf6-geofence-transition-detection.md).

### Enums

| Enum | Values | Used by |
| --- | --- | --- |
| `AlertSeverity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` | `AlertEvent` (schema only) |
| `AlertStatus` | `OPEN`, `ACKNOWLEDGED`, `RESOLVED` | `AlertEvent` (schema only) |
| `GeofenceContainmentState` | `INSIDE`, `OUTSIDE` | `GeofenceDeviceState` (GF-6) |
| `GeofenceTransition` | `BASELINE_INSIDE`, `BASELINE_OUTSIDE`, `ENTER`, `EXIT`, `STAY_INSIDE`, `STAY_OUTSIDE` | `GeofenceDeviceState` (GF-6) |

## Circle geofence spatial representation (GF-3)

Circles remain the only supported geometry. Polygons are deferred.

`Geofence."centerPoint"` is the canonical spatial value:

```sql
"centerPoint" geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography
  ) STORED
```

- **Axis order.** `ST_MakePoint(X, Y)` — **longitude is X, latitude is Y**. That
  is the PostGIS convention and the reverse of the order coordinates are usually
  spoken in, so it is asserted explicitly in
  `test/integration/spatial-sync.integration-spec.ts`.
- **SRID 4326** (WGS 84) matches the degrees the API already accepts.
- **`geography`, not `geometry`.** Geography measures in **metres** — the same
  unit as `radiusMeters` — so future `ST_DWithin` evaluation needs no projection.
- **Index.** `Geofence_centerPoint_gist_idx`, a GiST index on `centerPoint`.

### Why the scalar and spatial values cannot diverge

`latitude`/`longitude` remain the application-facing read/write representation;
the API contract and DTOs are unchanged. The spatial column is derived from them
by PostgreSQL itself, which is what makes divergence impossible rather than
merely unlikely:

- A stored generated column is recomputed on every INSERT and on every UPDATE
  that touches either coordinate.
- PostgreSQL **rejects** any direct write to it (`column "centerPoint" can only
  be updated to DEFAULT`). No application bug, raw query, or psql session can
  set the point without the scalars, or the scalars without the point.
- A trigger would produce the same result on the ordinary path, but could be
  bypassed (`ALTER TABLE ... DISABLE TRIGGER`) and would need correct INSERT
  *and* UPDATE handling. A generated column has no such surface.

### Prisma limitations, handled explicitly

Prisma has no PostGIS type, so the field is declared
`Unsupported("geography(Point, 4326)")?`:

- Prisma Client never selects or writes it — which is exactly what keeps the
  existing DTO and response contract unchanged.
- It is declared **optional** only because Prisma Client refuses to create rows
  for a model that has a required `Unsupported` field. The database enforces
  `NOT NULL` regardless.
- The GiST index *is* declared
  (`@@index([centerPoint], type: Gist, map: "Geofence_centerPoint_gist_idx")`)
  so Prisma knows it exists and will not try to drop it.

**Known, expected drift.** `prisma migrate diff` reports exactly one difference
from the datamodel to a fully migrated database (`--from-schema prisma/schema.prisma --to-config-datasource --script`):

```sql
ALTER TABLE "public"."Geofence" ALTER COLUMN "centerPoint" SET NOT NULL,
ALTER COLUMN "centerPoint" SET DEFAULT (st_setsrid(st_makepoint(longitude, latitude), 4326))::geography;
```

Prisma 7.8.0 reports the generated expression as a default. The opposite comparison
(`--from-config-datasource --to-schema prisma/schema.prisma --script`), which
is relevant when generating a migration toward the datamodel, produces:

```sql
-- AlterTable
ALTER TABLE "Geofence" ALTER COLUMN "centerPoint" DROP NOT NULL,
ALTER COLUMN "centerPoint" DROP DEFAULT;
```

Do not apply either artifact. Generate future migrations with
`prisma migrate dev --create-only` on a disposable development database,
review the complete SQL, and remove only the operations above when they refer
to this generated column. Never discard a whole statement if it also contains
an intended change. Review CHECK constraints and generated expressions separately:
Prisma diff does not fully model them. `npm run test:db` asserts the exact
known datamodel-to-database SQL and fails on any additional modeled drift.

A required Unsupported field with `@default(dbgenerated())` still reports the
expression difference. Supplying the expression as a fake default hides the
drift, but PostgreSQL rejects the resulting DDL (column references cannot appear
in defaults). Retain the truthful optional Unsupported declaration and the
stored generated column. GiST is supported by Prisma and is already declared;
only generated-column and CHECK-constraint changes require manual SQL.

The synchronization guarantee covers normal writes. A database owner capable
of altering the table can change either a generated column or a trigger; neither
mechanism protects against hostile schema owners.

## Database-enforced constraints

These duplicate limits that already exist in the API contract
(`src/geofences/dto/geofence.constants.ts`, `src/auth/auth.constants.ts`), so
data written outside the NestJS validation pipe is still bounded.

| Constraint | Rule |
| --- | --- |
| `Geofence_latitude_range_check` | `latitude` between −90 and 90 |
| `Geofence_longitude_range_check` | `longitude` between −180 and 180 |
| `Geofence_radiusMeters_positive_check` | `radiusMeters >= 1` |
| `Geofence_radiusMeters_max_check` | `radiusMeters <= 5000` |
| `Geofence_name_not_blank_check` | ECMAScript-whitespace-trimmed name is not empty |
| `Tenant_name_not_blank_check` | `btrim(name)` is not empty |
| `User_email_not_blank_check` | non-blank, no surrounding whitespace |
| `AlertEvent_latitude_range_check` | null, or between −90 and 90 |
| `AlertEvent_longitude_range_check` | null, or between −180 and 180 |
| `LocationEvent_latitude_range_check` | `latitude` between −90 and 90 |
| `LocationEvent_longitude_range_check` | `longitude` between −180 and 180 |
| `LocationEvent_coordinates_finite_check` | neither coordinate is `NaN` |
| `LocationEvent_accuracyMeters_range_check` | between 0 and 100000, and not `NaN` |
| `LocationEvent_eventKey_not_blank_check` | ECMAScript-whitespace-trimmed key is not empty |
| `TrackedDevice_deviceKey_not_blank_check` | ECMAScript-whitespace-trimmed key is not empty |
| `TrackedDevice_name_not_blank_check` | ECMAScript-whitespace-trimmed name is not empty |

Deliberate decisions:

- The radius floor is 1 metre and the ceiling is 5000 metres, matching the DTO. Both are contract constraints and require a migration when changed.
- The lowercase half of email canonicalization is **not** asserted in SQL:
  PostgreSQL's `lower()` is locale-dependent and does not always agree with
  JavaScript's `toLowerCase()`, so such a CHECK could reject addresses the API
  legitimately accepts. Trimming and non-emptiness use the explicit ECMAScript whitespace set in the audit migration. SQL does not enforce full email syntax or lowercase normalization; application writers must normalize email before persisting it.
- `AlertEvent` string columns carry no length bound, because no endpoint reads or
  writes them yet and there is no contract to align with. Bounds arrive with the
  alert workflow.
- The GF-4 `LocationEvent` checks exclude `NaN` explicitly as defense in depth.
  PostgreSQL sorts `NaN` above finite values, so the existing upper range bounds
  already reject it, including on GF-3 `Geofence` and `AlertEvent` coordinates.
  The previously reported GF-3 NaN gap was disproved by direct SQL audit probes;
  no historical migration change is needed. The GF-4 migration's original NaN
  commentary is inaccurate and is preserved to keep migration bytes unchanged.
- `LocationEvent.accuracyMeters` allows `0` and caps at 100000 metres as ingestion
  policy. Accuracy is metadata only; GF-4 draws no containment conclusion from it.

## Migration history

| Migration | Purpose |
| --- | --- |
| `20260908102300_enable_postgis` | `CREATE EXTENSION IF NOT EXISTS postgis` |
| `20260908102319_init_postgresql_baseline` | Prisma-generated tables, enums, foreign keys, indexes |
| `20260908102400_geofence_spatial_constraints` | Generated spatial column, GiST index, CHECK constraints |
| `20260908110000_audit_contract_hardening` | One-metre radius minimum and ECMAScript whitespace checks |
| `20260909063002_tracked_devices_and_location_events` | GF-4 tables, composite FK, uniqueness and lookup indexes |
| `20260909063100_location_event_spatial_constraints` | Generated `observedPoint`, CHECK constraints, no spatial index (by decision) |
| `20260909120000_geofence_device_transition_state` | GF-6 enums, `GeofenceDeviceState`, composite FKs, `(id, tenantId)` uniques on `Geofence` and `LocationEvent` |

`20260909120000` carries the same hand edit for the same reason, recorded in its
own header: Prisma re-proposed dropping the generation expressions on both
`centerPoint` and `observedPoint`, and both blocks were removed.

`20260909063002` is Prisma-generated with one hand edit, documented in the file
itself: Prisma's leading `ALTER TABLE "Geofence" ... DROP DEFAULT` block was
removed. That block is not a GF-4 change — it is Prisma re-proposing the known
`centerPoint` drift, which PostgreSQL rejects outright and which would have
reverted the GF-3 spatial guarantee had it succeeded. The drift itself is
unchanged and still asserted verbatim by `scripts/disposable-db-test.mjs`.

Deploy them with:

```bash
npm run prisma:migrate:deploy
```

### The GF-3 migration reset

The two pre-GF-3 migrations (`init`, `add_identity_tenant_ownership`) were
written in SQLite dialect — `REAL`/`DATETIME` column types and the
`PRAGMA` table-rebuild idiom — none of which PostgreSQL can execute. They were
**removed** rather than rewritten in place: editing committed migrations so they
appear PostgreSQL-native would have falsified the recorded history.

The reset is safe for this repository specifically because the project is
pre-production (v0.1.0), has never been deployed, and the only databases that
ever ran those migrations were local `dev.db` files and per-test temporary
files. No environment holds a `_prisma_migrations` table that needs to reconcile
with the old entries.

**Existing local SQLite data is not migrated.** A developer holding a `dev.db`
worth keeping must export it themselves before switching. Because there is no
pre-existing data to backfill, the GF-2 "legacy bootstrap tenant" is no longer
needed and is not recreated.

---

## Planned Schema (Roadmap — Not Implemented)

> **Note:** This section predates GF-2 and is retained as historical roadmap
> context. Identity and ownership are now implemented via the tenant-based model
> above (`User`/`Tenant`/`Membership`), which supersedes the `users`/`user_id`
> naming used below. The PostgreSQL/PostGIS **backend** is now implemented
> (GF-3); the spatial *evaluation* described below - checking a location against
> a geofence and emitting alerts - remains unimplemented.

The remainder of this document describes an aspirational relational design that
adds users/ownership. Its table and column naming is historical and does not
match the implemented schema.

The planned database is organized around three main entities:

| Table | Purpose |
| --- | --- |
| `users` | Stores application users or account owners |
| `geofences` | Stores named geographic zones created by users |
| `alert_events` | Stores alert records triggered when a location enters or exits a geofence |

## Entity Relationship Summary

A user can create multiple geofences.

A geofence can generate multiple alert events.

Each alert event belongs to one geofence.

```text
users
  └── geofences
        └── alert_events
```

## Users Table

The `users` table stores basic information about users who own geofences.

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID / Primary Key | Unique identifier for each user |
| `name` | String | User display name |
| `email` | String | User email address |
| `created_at` | Timestamp | Date and time the user record was created |
| `updated_at` | Timestamp | Date and time the user record was last updated |

### Users Table Purpose

The `users` table allows the API to associate geofence records with a specific account or owner.

## Geofences Table

The `geofences` table stores geographic zones that can trigger alerts.

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID / Primary Key | Unique identifier for each geofence |
| `user_id` | UUID / Foreign Key | References the user who owns the geofence |
| `name` | String | Human-readable name for the geofence |
| `description` | String / Nullable | Optional description of the geofence |
| `latitude` | Decimal | Center latitude of the geofence |
| `longitude` | Decimal | Center longitude of the geofence |
| `radius_meters` | Integer | Radius of the geofence in meters |
| `is_active` | Boolean | Indicates whether the geofence is currently active |
| `created_at` | Timestamp | Date and time the geofence was created |
| `updated_at` | Timestamp | Date and time the geofence was last updated |

### Geofences Table Purpose

The `geofences` table defines monitored geographic areas. Each record represents a circular geofence using latitude, longitude, and radius.

## Alert Events Table

The `alert_events` table stores events generated when a tracked location interacts with a geofence.

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID / Primary Key | Unique identifier for each alert event |
| `geofence_id` | UUID / Foreign Key | References the geofence that triggered the alert |
| `event_type` | String | Type of event, such as `ENTER` or `EXIT` |
| `latitude` | Decimal | Latitude where the event occurred |
| `longitude` | Decimal | Longitude where the event occurred |
| `message` | String | Human-readable alert message |
| `created_at` | Timestamp | Date and time the alert event was created |

### Alert Events Table Purpose

The `alert_events` table provides a historical log of geofence activity. This allows the API to return recent alerts, audit location-based events, and support dashboard or reporting features later.

## Relationships

| Relationship | Type | Description |
| --- | --- | --- |
| `users` → `geofences` | One-to-many | One user can own many geofences |
| `geofences` → `alert_events` | One-to-many | One geofence can generate many alert events |

## Foreign Keys

| Table | Foreign Key | References |
| --- | --- | --- |
| `geofences` | `user_id` | `users.id` |
| `alert_events` | `geofence_id` | `geofences.id` |

## Example Data Flow

1. A user creates a geofence called `Warehouse Zone`.
2. The API stores the geofence with a latitude, longitude, and radius.
3. A location update is checked against the geofence.
4. If the location enters or exits the geofence, an alert event is created.
5. The alert event can be retrieved through the API.

## Example Logical Schema

```text
users
- id
- name
- email
- created_at
- updated_at

geofences
- id
- user_id
- name
- description
- latitude
- longitude
- radius_meters
- is_active
- created_at
- updated_at

alert_events
- id
- geofence_id
- event_type
- latitude
- longitude
- message
- created_at
```

## Backend Value

This schema demonstrates several backend development concepts:

- Relational database design
- Primary key and foreign key relationships
- Event logging
- Location-based data modeling
- API-ready resource structure
- Future support for authentication and user-owned resources
- Clear separation between users, geofence definitions, and generated events

## Future Schema Improvements

Possible future improvements include:

| Improvement | Purpose |
| --- | --- |
| Add `devices` table | Track mobile devices or assets being monitored |
| Add `organizations` table | Support multiple teams or business accounts |
| Add `severity` field to alert events | Classify alerts by importance |
| Add `resolved_at` field | Track whether alerts have been handled |
| Add polygon geofence support | Support more complex geographic boundaries |
| Add indexes on foreign keys | Improve query performance |
| Add audit logging | Track changes to geofences and users |

## Summary

The GeoFence Alert API database schema is designed around a simple but practical backend model: users create geofences, and geofences generate alert events. This structure keeps the project understandable while still demonstrating real backend architecture, relational modeling, and event-driven API design.
