# Database Schema

> **Implementation status.** The database is **PostgreSQL with PostGIS** (GF-3).
> The Prisma schema contains `User`, `Tenant`, `Membership`, `Geofence`, and
> `AlertEvent`; primary keys are string `cuid` values, **not** UUIDs. Identity
> and per-tenant ownership are implemented (GF-2). Circle geofences now carry a
> canonical `geography(Point, 4326)` centre with a GiST index. Spatial
> *evaluation* — containment, distance, enter/exit — is **not** implemented; GF-3
> builds the storage foundation only. The legacy "planned" section at the end of
> this document predates GF-2 and is retained as historical context.

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
| `radiusMeters` | `double precision` | Radius in metres, > 0 and ≤ 5000 |
| `isActive` | `boolean` | Defaults to `true` |
| `centerPoint` | `geography(Point, 4326)` | **Generated** — see below. Not readable or writable through Prisma Client |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps |

Every query for tenant-owned data is scoped by `tenantId` derived from the
authenticated principal. See [security.md](security.md).

### `AlertEvent` (schema only — no runtime logic)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (`cuid`) | Primary key |
| `geofenceId` | `text` | FK → `Geofence.id` (cascade delete) |
| `eventType` | `text` | e.g. `ENTER` / `EXIT` |
| `severity` | enum `AlertSeverity` | `LOW`/`MEDIUM`/`HIGH`/`CRITICAL`, default `MEDIUM` |
| `status` | enum `AlertStatus` | `OPEN`/`ACKNOWLEDGED`/`RESOLVED`, default `OPEN` |
| `message` | `text` | Required |
| `source` | `text` | Optional |
| `latitude` / `longitude` | `double precision` | Optional; range-checked when present |
| `createdAt` / `updatedAt` | `timestamp(3)` | Timestamps |

No API endpoint reads or writes `AlertEvent` yet; the model exists to support
future alert workflows.

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
between the datamodel and a fully migrated database:

```sql
ALTER TABLE "public"."Geofence" ALTER COLUMN "centerPoint" SET NOT NULL,
ALTER COLUMN "centerPoint" SET DEFAULT (st_setsrid(st_makepoint(longitude, latitude), 4326))::geography;
```

Prisma cannot express `GENERATED ALWAYS AS ... STORED` and renders it as a
column default. This is a reporting artifact, not a schema defect. The practical
consequence: generate future migrations with
`prisma migrate dev --create-only` and **delete that statement** before applying
them. Any migration touching the spatial column, the CHECK constraints, or the
GiST index must be hand-authored.

## Database-enforced constraints

These duplicate limits that already exist in the API contract
(`src/geofences/dto/geofence.constants.ts`, `src/auth/auth.constants.ts`), so
data written outside the NestJS validation pipe is still bounded.

| Constraint | Rule |
| --- | --- |
| `Geofence_latitude_range_check` | `latitude` between −90 and 90 |
| `Geofence_longitude_range_check` | `longitude` between −180 and 180 |
| `Geofence_radiusMeters_positive_check` | `radiusMeters > 0` |
| `Geofence_radiusMeters_max_check` | `radiusMeters <= 5000` |
| `Geofence_name_not_blank_check` | `btrim(name)` is not empty |
| `Tenant_name_not_blank_check` | `btrim(name)` is not empty |
| `User_email_not_blank_check` | non-blank, no surrounding whitespace |
| `AlertEvent_latitude_range_check` | null, or between −90 and 90 |
| `AlertEvent_longitude_range_check` | null, or between −180 and 180 |

Deliberate decisions:

- The radius floor is `> 0` — the geometric invariant — rather than the API's
  1 metre minimum, which is product policy that may be retuned without a
  migration. The ceiling mirrors `GEOFENCE_RADIUS_MAX_METERS` (5000).
- The lowercase half of email canonicalization is **not** asserted in SQL:
  PostgreSQL's `lower()` is locale-dependent and does not always agree with
  JavaScript's `toLowerCase()`, so such a CHECK could reject addresses the API
  legitimately accepts. Trimming and non-emptiness are asserted.
- `AlertEvent` string columns carry no length bound, because no endpoint reads or
  writes them yet and there is no contract to align with. Bounds arrive with the
  alert workflow.

## Migration history

| Migration | Purpose |
| --- | --- |
| `20260908102300_enable_postgis` | `CREATE EXTENSION IF NOT EXISTS postgis` |
| `20260908102319_init_postgresql_baseline` | Prisma-generated tables, enums, foreign keys, indexes |
| `20260908102400_geofence_spatial_constraints` | Generated spatial column, GiST index, CHECK constraints |

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
