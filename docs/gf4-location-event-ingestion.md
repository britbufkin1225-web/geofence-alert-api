# GF-4 — Authenticated Location-Event Ingestion

Phase note for the first secure, persistent ingestion path for tenant-owned
device location events.

**Status: implemented and independently hardened locally.** GF-4 is not merged,
not deployed, and not operationally proven.

GF-4 records authenticated, validated location observations; it does not verify
the physical truth of client-reported coordinates. It performs **no** geofence
evaluation: no point-in-circle test, no `ST_DWithin`, no enter/exit/dwell
transitions, no alerts, no background processing. See
[Deferred functionality](#deferred-functionality).

---

## Endpoints

Both routes sit under the `/api/v1` prefix and are protected by the global
`JwtAuthGuard`, like every other application route.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/tracked-devices` | Register a location source owned by the caller's tenant |
| POST | `/api/v1/location-events` | Ingest one observation from one of those devices |

`POST /api/v1/tracked-devices` is the **minimum** device foundation: without it
no tenant could ever own a device, and the ingestion endpoint would be
unreachable by any API client. It is registration only — there is deliberately
no list, read, update, deactivate or delete route, no per-device credential, and
no enrollment workflow. Those belong to a device-management phase.

### Request — `POST /api/v1/tracked-devices`

```json
{
  "deviceKey": "van-a1",
  "name": "Van A1",
  "isActive": true
}
```

Returns `201` with the created device. `isActive` defaults to `true`.

### Request — `POST /api/v1/location-events`

```json
{
  "deviceKey": "van-a1",
  "eventKey": "evt-2026-09-09-0001",
  "observedAt": "2026-09-09T06:00:00.000Z",
  "latitude": 30.2672,
  "longitude": -97.7431,
  "accuracyMeters": 8.5
}
```

### Response

```json
{
  "id": "clx1a2b3c4d5e6f7g8h9i0j1k",
  "tenantId": "clx0000000000000000000000",
  "trackedDeviceId": "clx1111111111111111111111",
  "deviceKey": "van-a1",
  "eventKey": "evt-2026-09-09-0001",
  "observedAt": "2026-09-09T06:00:00.000Z",
  "receivedAt": "2026-09-09T06:00:01.482Z",
  "latitude": 30.2672,
  "longitude": -97.7431,
  "accuracyMeters": 8.5,
  "replayed": false
}
```

The derived `observedPoint` geography column is never returned; the scalar
coordinates are the application-facing contract.

### Naming

The conceptual contract for this phase used `deviceId` / `eventId`. The
implementation uses **`deviceKey`** and **`eventKey`** instead, because
everything named `*Id` in this codebase is an internal `cuid` primary key
(`tenantId`, `geofenceId`, `trackedDeviceId`). These two fields are opaque
*external* keys chosen by the client, so naming them `*Id` would have been
actively misleading about which identifier space they belong to.

---

## Authentication and tenant derivation

- A valid `Authorization: Bearer <token>` is required. Anonymous, malformed,
  expired, wrong-algorithm, `alg: none`, and structurally incomplete tokens all
  collapse to the same generic `401`, as do tokens whose backing membership has
  been deleted. This is the unchanged GF-2 guard; GF-4 adds no new auth path.
- The active tenant is the `tid` claim of the verified token, after the guard
  re-confirms the exact `mid`/`sub`/`tid` tuple still exists in the database.
- Tenant identity is **never** read from the request body, query string, URL
  parameter, header, device metadata, or the idempotency key.
- Client-supplied `tenantId`, `id`, `trackedDeviceId`, `receivedAt`,
  `createdAt`, `observedPoint`, and nested `tenant` / `trackedDevice` objects are
  rejected with `400` by the global `whitelist` + `forbidNonWhitelisted`
  validation pipe. They are not silently dropped — the response names the
  offending property.

---

## Tracked-device ownership model

- Every tracked device belongs to exactly one tenant (`TrackedDevice.tenantId`,
  `NOT NULL`, foreign key with `ON DELETE CASCADE`).
- `deviceKey` is unique **within** a tenant (`@@unique([tenantId, deviceKey])`).
  Two tenants may legitimately register the same external key for unrelated
  devices; neither can observe or collide with the other.
- Device resolution during ingestion is a tenant-qualified lookup
  (`findUnique({ where: { tenantId_deviceKey: { tenantId, deviceKey } } })`), not
  a global read followed by an ownership comparison.
- A key owned by **another** tenant and a key that exists **nowhere** produce a
  identical `404 Tracked device not found` responses apart from the response
  timestamp. Ingestion cannot be used to
  discover which device keys other tenants use.
- **Inactive devices cannot ingest.** Deactivation is how a tenant stops
  accepting data from a device, so an inactive device is refused with
  `409 Tracked device is not active`. That `409` is only reachable by a caller
  who already owns the device, so unlike the `404` above it discloses nothing
  across the tenant boundary.

---

## Location-event persistence model

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (cuid) | Primary key |
| `tenantId` | `text` | Server-derived; part of the composite foreign key |
| `trackedDeviceId` | `text` | Resolved within the tenant |
| `eventKey` | `varchar(200)` | Client idempotency key |
| `observedAt` | `timestamptz(3)` | Supplied by the source |
| `receivedAt` | `timestamptz(3)` | Server receipt, `DEFAULT CURRENT_TIMESTAMP` |
| `latitude` | `double precision` | |
| `longitude` | `double precision` | |
| `accuracyMeters` | `double precision` | |
| `observedPoint` | `geography(Point, 4326)` | `GENERATED ALWAYS AS (...) STORED`, `NOT NULL` |

Rows are **append-only**. Nothing in the API updates a location event, so the
model carries a single `receivedAt` rather than the `createdAt`/`updatedAt` pair
used by the mutable models; an `updatedAt` column would advertise a mutability
the contract does not have.

### Spatial storage

`observedPoint` uses exactly the GF-3 approach: a `STORED GENERATED` column
computed by PostgreSQL as
`ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography`. Longitude
is X and latitude is Y, SRID 4326 (WGS 84). PostgreSQL refuses direct writes to
it (`column can only be updated to DEFAULT`), so the scalar and spatial
representations cannot diverge through any code path — application, worker, or
`psql` session.

### No spatial index, deliberately

`Geofence.centerPoint` carries a GiST index because the containment query a later
phase will run is *"which geofences lie within radius of this point"*, which
probes the **geofence** index once per event. Indexing
`LocationEvent.observedPoint` would instead serve *"which events fall inside this
area"* — a location-history query API that GF-4 does not provide and that no
committed query path uses. Adding a GiST index over the highest-volume table in
the schema on speculation would cost write throughput and storage for nothing.

The integration suite asserts the index's **absence**, so this stays a recorded
decision rather than an oversight. It is a one-line addition whenever a real
query path justifies it.

### Ownership is structural

`LocationEvent` carries a composite foreign key on
`(trackedDeviceId, tenantId) → TrackedDevice(id, tenantId)`. PostgreSQL itself
rejects any row whose tenant disagrees with its device's tenant, so the
invariant does not depend on the service layer being correct. Tenant deletion
cascades `Tenant → TrackedDevice → LocationEvent`.

---

## Timestamp semantics

`observedAt` is required and must be an ISO-8601 date-time with an **explicit**
UTC designator (`Z`) or numeric offset (`±HH:MM`).

- **Timezone-free values are rejected.** `2026-09-09T06:00:00` would be read in
  the *server's* local zone, so the same payload would mean different instants on
  different hosts. For a timestamp supplied by a remote source that is never
  acceptable.
- **Parsing is strict.** `new Date()` silently rolls impossible calendar dates
  forward (`2026-02-30` becomes 2 March) and accepts a long tail of non-ISO
  formats. Every component is range-checked against the real calendar first, so
  `2026-02-30`, `2025-02-29`, `2026-13-01`, `24:00:00`, leap seconds, and
  out-of-range offsets are refused rather than normalized into a different
  instant.
- Fractional seconds are optional and bounded to **milliseconds**, matching the
  column precision. More digits are rejected rather than silently truncated.
- **Future-clock policy:** an observation may be at most **5 minutes**
  (`LOCATION_EVENT_MAX_FUTURE_SKEW_MS`) ahead of the server clock. A strict "not
  in the future" rule would reject legitimate events, because devices and servers
  do not share a clock and submissions take time to arrive. The bound is tight
  enough that a wrong or hostile clock cannot park observations far in the future
  and distort ordering built on `observedAt` later.
- **Past policy:** there is **no lower bound**. Back-dated events are accepted so
  a source that was offline can flush its buffer. **Retention enforcement is
  explicitly deferred** — GF-4 adds no retention, expiry, or deletion behavior.
- Both timestamps are stored as `timestamptz(3)`, so the absolute instant is
  preserved regardless of the session time zone of whatever process reads it.
  (The pre-existing bookkeeping columns elsewhere in the schema are plain
  `timestamp`; for a value supplied by an external source with its own clock and
  offset, preserving the instant exactly is part of the contract.)

Application connections are pinned to UTC. The installed `@prisma/adapter-pg`
7.8.0 parser replaces non-UTC offsets without adjusting the clock time; the
audit reproduced a 14-hour read error. UTC connection startup options avoid
that adapter defect, including when the URL requests a different timezone.
Application SQL must not change the session timezone. The database itself
preserves the instant under other zones, verified using epoch reads inside a
transaction; Prisma round-tripping is verified on the pinned UTC connection.

---

## Accuracy semantics

`accuracyMeters` is required, finite, and in **`0`…`100000`** meters inclusive.

- **Zero is allowed.** The W3C Geolocation contract most sources follow defines
  accuracy as non-negative, and a source that considers its fix exact — or a
  simulated source — legitimately reports `0`. Rejecting it would force clients
  to lie.
- The 100 km ceiling is the chosen ingestion policy, not a geometric theorem
  or proof that a source is malfunctioning.
- Accuracy is **metadata only** in GF-4. Nothing evaluates, filters, or branches
  on it.

---

## Idempotency

The client supplies `eventKey`. Uniqueness is enforced by the database
constraint `LocationEvent_tenantId_trackedDeviceId_eventKey_key` on
**`(tenantId, trackedDeviceId, eventKey)`**. There is no in-memory idempotency
anywhere in the path.

Including `tenantId` is redundant with the composite foreign key, but it keeps
the constraint — and every replay lookup that uses it — tenant-qualified in its
own right, so one tenant's event key can never collide with, or disclose,
another's.

**Scope:** the key is per **device**. The same key on two different devices in
one tenant creates two independent events; the same key in two different tenants
creates two independent events.

### Replay-versus-conflict contract

| Situation | Response |
| --- | --- |
| Key not seen before | `201 Created`, `"replayed": false` |
| Key seen, **all** immutable observation fields identical | `200 OK`, `"replayed": true`, the stored resource |
| Key seen, **any** of `observedAt` / `latitude` / `longitude` / `accuracyMeters` differs | `409 Conflict`, `eventKey already used for a different location event` |

A conflicting replay never overwrites the stored event. Answering `200` there
would tell the client its new data was recorded when it was not.

An equal instant written with a different offset (`2026-09-09T08:00:00+02:00`
versus `2026-09-09T06:00:00Z`) is a **replay**, not a conflict — comparison is on
the absolute instant.

### Concurrency

The service reads first (the ordinary retry-after-lost-response case is cheaper
and quieter as a read), then creates, then catches Prisma `P2002` only for the
exact `LocationEvent_tenantId_trackedDeviceId_eventKey_key` index and re-reads
the winning row. The database, not the application, decides which concurrent
submission wins; the loser is then answered with the same replay-or-conflict
rule, so the outcome does not depend on timing. Eight simultaneous identical
submissions produce exactly one `201`, seven `200`s, and one stored row.

Other unique violations or missing constraint metadata propagate as sanitized
server errors. Registration similarly recognizes only the tenant/device-key
index, not the device primary key.

---

## Validation boundaries

| Field | Rule |
| --- | --- |
| `deviceKey` | Required string, trimmed, 1–128 chars, `[A-Za-z0-9._:-]+` |
| `eventKey` | Required string, trimmed, 1–200 chars, `[A-Za-z0-9._:-]+` |
| `observedAt` | Required strict ISO-8601 instant with explicit `Z` or offset; ≤ 5 min future |
| `latitude` | Required number in `-90`…`90` inclusive |
| `longitude` | Required number in `-180`…`180` inclusive |
| `accuracyMeters` | Required number in `0`…`100000` inclusive |

The key charsets are restricted rather than free-form: these are opaque
correlation tokens later read in logs and exports, so nothing legitimate needs
whitespace or control characters in them, and restricting once here is cheaper
than sanitizing everywhere they are read. They comfortably admit the formats
sources actually use (UUIDs, cuids, ULIDs, `<device>:<seq>` pairs).

Numeric fields reject `NaN` and `Infinity` (class-validator's `@IsNumber()`
defaults), and reject numeric **strings** — implicit conversion is off, so the
transport contract is JSON numbers. Unknown and protected properties are
rejected with `400`.

---

## Database guarantees

Enforced by PostgreSQL independently of the NestJS validation pipe, so a write
from a future worker, a `psql` session, or a bad migration is still bounded:

| Constraint | Guarantee |
| --- | --- |
| `LocationEvent_latitude_range_check` | `-90 ≤ latitude ≤ 90` |
| `LocationEvent_longitude_range_check` | `-180 ≤ longitude ≤ 180` |
| `LocationEvent_coordinates_finite_check` | Neither coordinate is `NaN` |
| `LocationEvent_accuracyMeters_range_check` | `0 ≤ accuracy ≤ 100000`, not `NaN` |
| `LocationEvent_eventKey_not_blank_check` | Non-blank after ECMAScript-whitespace trim |
| `TrackedDevice_deviceKey_not_blank_check` | Non-blank after ECMAScript-whitespace trim |
| `TrackedDevice_name_not_blank_check` | Non-blank after ECMAScript-whitespace trim |
| `LocationEvent_tenantId_trackedDeviceId_eventKey_key` | Idempotency uniqueness |
| `TrackedDevice_tenantId_deviceKey_key` | Device key unique within a tenant |
| `TrackedDevice_id_tenantId_key` | Referenced by the composite foreign key |
| `LocationEvent_trackedDeviceId_tenantId_fkey` | Event tenant **must** equal device tenant; `ON DELETE CASCADE` |
| `TrackedDevice_tenantId_fkey` | Device tenant must exist; `ON DELETE CASCADE` |
| `observedPoint` generated column | Spatial value cannot diverge from the scalars |

The explicit `NaN` exclusions are defense in depth. PostgreSQL orders `NaN`
above finite numbers, so the upper range bounds already reject it. Direct SQL
audit probes disproved the reported GF-3 coordinate gap on both `Geofence` and
`AlertEvent`. No GF-3 migration was changed; the original GF-4 migration's
incorrect NaN comments remain historical text, not the database contract.

Indexes: `TrackedDevice_tenantId_idx` and
`LocationEvent_tenantId_trackedDeviceId_observedAt_idx` (the tenant-scoped device
timeline later phases read).

---

## Error contract

| Status | Cause |
| --- | --- |
| `400` | Validation failure, unknown/protected property, malformed body |
| `401` | Missing, malformed, expired, wrong-algorithm, or revoked token |
| `404` | Device key not owned by the caller's tenant (identical for foreign and non-existent) |
| `409` | Inactive device, or `eventKey` reused with different observation data |
| `201` / `200` | Created / replayed |

Error responses use the existing non-leaky shape
`{ statusCode, error, message, path, timestamp }`. Prisma codes, SQL, stack
traces, and filesystem paths never reach a client.

---

## Test coverage

| Suite | File | Count |
| --- | --- | --- |
| Validator unit | `src/common/validators/strict-iso-date-time.spec.ts` | 60 |
| Service unit | `src/location-events/location-events.service.spec.ts` | 23 |
| HTTP contract | `src/location-events/location-events.http.spec.ts` | 93 |
| Real-database ingestion | `test/integration/location-event-ingestion.integration-spec.ts` | 41 |
| Real-database structure/constraints | `test/integration/location-event-database.integration-spec.ts` | 44 |

Covered: anonymous / malformed / expired / revoked-membership authentication;
cross-tenant device keys and non-disclosure; ownership-injection attempts;
coordinate and accuracy boundaries; scalar/spatial synchronization and refusal of
direct spatial writes; timestamp format, calendar validity, offset normalization,
future skew and back-dating; identifier emptiness, whitespace, length and
charset; unknown and protected properties; first write, identical replay,
conflicting replay, cross-tenant and cross-device key scoping, and concurrent
duplicates; database-level constraint, foreign-key, cascade and catalog checks;
and database instant preservation under a hostile session time zone, with
Prisma connections pinned to UTC to work around the adapter defect.

---

## Deferred functionality

Not implemented in GF-4, and not partially started: point-in-circle evaluation,
`ST_DWithin` matching, enter/exit/dwell/approach state machines, transition
persistence, alert creation or delivery, webhooks/email/SMS/push, queues, Redis,
background workers, scheduled jobs, event streaming, bulk or batch ingestion,
mobile SDKs, device enrollment beyond the minimum registration route, per-device
secrets, refresh-token or RBAC redesign, retention/deletion jobs, privacy
automation, location-history query APIs, maps, frontend, dashboards, live
tracking, and WebSockets.

No new runtime or development dependency was added.

---

## Next recommended phase

**GF-5 — deterministic point-in-circle geofence evaluation.** Given a stored
location event and the tenant's active geofences, compute containment with
`ST_DWithin` against the existing `Geofence_centerPoint_gist_idx`, as a pure,
synchronous, well-tested read. Transitions, alert records and delivery should
remain deferred beyond it.
