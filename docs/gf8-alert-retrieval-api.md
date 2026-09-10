# GF-8 — Authenticated Tenant-Scoped Alert Retrieval API

**Status:** implemented locally on the
`phase-gf-8-authenticated-tenant-scoped-alert-retrieval-api` branch and awaiting
independent audit. **Not merged, not deployed.**

GF-8 opens the durable alert events GF-7 records to the tenant that owns them. It
adds two read routes and nothing else: no alert is created, changed,
acknowledged, resolved, deleted, delivered, queued or scheduled by anything in
this phase.

---

## Routes

```text
GET /api/v1/alert-events
GET /api/v1/alert-events/:id
```

Both are served under the application's existing `/api/v1` prefix and both
require a bearer token, like every other application route.

### Why `alert-events` and not `alerts`

The resource is the `AlertEvent` model, and every other route in this API is the
kebab-case plural of the model it exposes: `geofences` for `Geofence`,
`tracked-devices` for `TrackedDevice`, `location-events` for `LocationEvent`.
`alert-events` is also the path this repository's own API design document and
README have reserved for alert history since before GF-7. A second convention for
one resource would be the only inconsistency in the surface.

---

## Authentication and tenant isolation

- Both routes are protected by the existing global `JwtAuthGuard`, which verifies
  the token signature, the pinned algorithm and the expiry, and then revalidates
  the exact `(membershipId, userId, tenantId)` tuple against the database. Every
  failure mode collapses to the same generic `401`.
- The tenant comes **only** from the verified principal. There is no `tenantId`,
  `userId` or membership property on the query DTO, and the global validation
  pipe runs with `whitelist` + `forbidNonWhitelisted`, so a caller that sends one
  gets a `400` naming the offending property rather than having it ignored.
  Headers outside the auth contract are not read at all.
- Tenant scope is part of the database predicate, not a check applied to rows
  that were already fetched. The list builds `where.tenantId` first and
  unconditionally; the detail endpoint uses `findFirst({ where: { id, tenantId } })`
  and never `findUnique` by id followed by an ownership comparison.

---

## Alert representation

Both endpoints return the same eight fields, produced by one explicit mapper, so
a list item and the detail response for the same alert are identical objects.

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier of the durable alert event |
| `tenantId` | Owning tenant — always the caller's own |
| `transition` | The crossing recorded: `ENTER` or `EXIT`, never anything else |
| `observedAt` | The source's own observation instant, copied by GF-7 from the location event that owns the crossing |
| `createdAt` | When this server durably recorded the alert (server bookkeeping time) |
| `trackedDeviceId` | The device that crossed |
| `geofenceId` | The geofence whose boundary was crossed |
| `sourceLocationEventId` | The single observation that produced the crossing |

```json
{
  "id": "clx0000000000000000000009",
  "tenantId": "clx0000000000000000000001",
  "transition": "ENTER",
  "observedAt": "2026-09-09T06:00:00.000Z",
  "createdAt": "2026-09-09T06:00:01.482Z",
  "trackedDeviceId": "clx0000000000000000000003",
  "geofenceId": "clx0000000000000000000005",
  "sourceLocationEventId": "clx0000000000000000000007"
}
```

`observedAt` and `createdAt` are deliberately both present and deliberately
different values. A device that was offline can flush a back-dated observation,
so the instant a crossing happened and the instant this server learned of it can
be far apart. Ordering and time filtering use `observedAt` only.

### Not returned, and why

- `severity` and `status` — unwritten legacy columns sitting at their defaults.
  Publishing `"status": "OPEN"` would advertise an acknowledgement workflow that
  does not exist.
- `eventType`, `message`, `source`, `latitude`, `longitude` — `NULL` on every row
  GF-7 writes. A permanently null field is not a contract.
- `updatedAt` — an alert is immutable, so a second timestamp that always equals
  `createdAt` would only invite polling for changes that cannot happen.
- The geofence's name and the device's label — these are *current* values of
  mutable related rows, not a snapshot of the crossing. A geofence renamed after
  the fact would make an old alert appear to describe a place it never described.
  A client that wants the present name has `geofenceId` and the geofence
  endpoints, and gets an answer that is honestly current.

`tenantId` **is** included, matching the geofence and location-event
representations, which both publish it. It discloses nothing: the caller proved
that value by authenticating.

---

## `GET /api/v1/alert-events`

### Filters

All filters are exact, bounded and optional, and all are conjoined (`AND`) with
the authenticated tenant scope in the SQL predicate itself.

| Query parameter | Type | Description |
| --- | --- | --- |
| `page` | integer | Page number. Default `1`, minimum `1`. Bounded above so an offset the database cannot bind is a `400`, never a server error. |
| `limit` | integer | Records per page. Default `10`, minimum `1`, maximum `100`. |
| `transition` | string | `ENTER` or `EXIT`. Any other transition is rejected. |
| `trackedDeviceId` | cuid | Exact device, within the caller's tenant. |
| `geofenceId` | cuid | Exact geofence, within the caller's tenant. |
| `sourceLocationEventId` | cuid | Every alert one ingestion produced. |
| `observedFrom` | ISO-8601 instant | **Inclusive** lower bound on `observedAt`. |
| `observedBefore` | ISO-8601 instant | **Exclusive** upper bound on `observedAt`. |

There is deliberately no free-text search, no caller-chosen sort, no field
selection, no relation expansion, no raw filter object and no spatial predicate.

`transition` is validated against the same constant GF-7 persistence and the
`AlertEvent_transition_crossing_check` database constraint are written from, so
the read filter cannot drift away from the write policy.

### Time-bound semantics

The window is half-open: `[observedFrom, observedBefore)`.

Exclusive at the top, and named `observedBefore` so the wire contract says so.
Adjacent windows then tile exactly — a client reading `[09:00, 10:00)` and then
`[10:00, 11:00)` sees every alert once, with no gap and nothing counted twice. An
inclusive upper bound cannot do that, because the shared endpoint belongs to both
windows.

- Timestamps must carry an explicit `Z` or numeric offset. A zone-free value is
  rejected, because it would mean different instants on different hosts.
- Impossible calendar dates (`2026-02-30`) and out-of-range components are
  rejected rather than silently rolled forward.
- A window whose upper bound is **earlier** than its lower bound is rejected as a
  `400`. Bounds that are exactly equal are accepted and describe an empty window,
  which is what a client stepping through adjacent windows produces at a
  boundary.
- Both bounds apply to `observedAt`, the source observation instant, and never to
  `createdAt`. The two are never mixed.

### Pagination and ordering

Page/limit pagination, matching the geofence list endpoint rather than
introducing a second pagination philosophy.

The order is **total and fixed**: `observedAt DESC, id DESC`. The tie-breaker is
not decoration — one observation can cross several geofences at the same instant,
so `observedAt` alone is not unique, and an unstable order within a tie is what
puts one alert on two adjacent pages while hiding another entirely.

A `limit` above `100` is **rejected** with a `400`, not clamped. Silently
returning a different page size than the one requested makes a client's own
pagination arithmetic wrong.

Response envelope:

```json
{
  "data": [],
  "meta": {
    "total": 0,
    "count": 0,
    "page": 1,
    "limit": 10,
    "totalPages": 0,
    "hasNextPage": false,
    "hasPreviousPage": false,
    "filters": {
      "transition": null,
      "trackedDeviceId": null,
      "geofenceId": null,
      "sourceLocationEventId": null,
      "observedFrom": null,
      "observedBefore": null
    },
    "sort": { "sortBy": "observedAt", "sortOrder": "desc", "tieBreaker": "id" }
  }
}
```

- `total` counts every match across all pages; `count` is how many items this
  page carries. They differ on a partial final page and past the end.
- `filters` echoes what was actually applied, with `null` for "not filtered".
- `sort` reports the fixed total order as data, so a client paging a feed can see
  that a unique tie-breaker is what makes its pages stable.

A tenant with no alerts, and a page past the last one, both return `200` with an
empty collection. Neither is a `404`.

### Read consistency — the honest limitation

The items and the total are two statements inside one transaction, which is the
pattern the geofence list endpoint already uses. That transaction is READ
COMMITTED, so each statement takes its own snapshot: an ingestion that commits a
new alert between them can leave `total` describing one instant and `data`
another.

The window is small, and **within that one response** the consequence is a count
that is off by the number of alerts recorded during it — not a wrong page, a
duplicated row or a missing one, because `data` comes from a single snapshot and
both statements share one predicate. Closing the window entirely would mean
REPEATABLE READ for a read endpoint, and GF-8 does not take that on.

That guarantee is about one request. It does **not** extend across requests.

### Offset pagination drifts across requests while alerts are being ingested

The total order makes a page stable for a database state that is not changing.
It does not make a sequence of page requests stable while ingestion continues,
and no ordering can: pages are cut by `OFFSET`, the list is newest-first, and a
newly recorded alert is inserted at the front. Every alert after it shifts one
position toward the back, so a client that has already read page 1 will see its
last row again on page 2, and an alert can be skipped entirely if rows are
removed between requests.

Concretely, with `limit=2` and one alert ingested between the two requests:

| Request | Rows returned |
| --- | --- |
| page 1 | `alert-J`, `alert-I` |
| *(a newer alert commits)* | |
| page 2 | `alert-I` *(seen again)*, `alert-H` |

This is inherent to offset pagination and is the same behavior the geofence list
endpoint has; it is recorded here because the fixed total order and the `sort`
block in every response describe within-snapshot stability, which is easy to read
as a promise about paging a live feed. A client that needs an exact,
non-overlapping sweep of a feed under concurrent ingestion should bound the
window it is reading with `observedFrom`/`observedBefore` — the half-open range
makes adjacent windows tile exactly — rather than relying on `page` alone.
Keyset/cursor pagination would close this properly and is deliberately not part
of GF-8.

### Deep offsets are bounded, not cheap

`page` is validated against an upper bound as well as a lower one, so no request
can produce an `OFFSET` the query engine cannot bind; an out-of-range page is a
`400`, not a server error. The bound is defensive arithmetic, not a performance
claim: PostgreSQL still walks every skipped index entry, so a deep page costs in
proportion to its depth even though the index supplies the order with no sort
step.

---

## `GET /api/v1/alert-events/:id`

- A malformed id is rejected as `400` by the existing cuid pipe, before the
  service or the database is reached.
- A well-formed id naming an alert of another tenant, and one naming no alert at
  all, return the **same** `404` with the same message shape. Nothing in the
  response confirms that another tenant's alert exists.
- The lookup performs no write, no backfill, no transition evaluation and no lazy
  alert creation.

---

## Database and migration

GF-8 adds **no** column, table, constraint, trigger or view, and edits no
historical migration. It adds exactly one forward-only index:

```sql
CREATE INDEX "AlertEvent_tenantId_observedAt_id_idx"
  ON "AlertEvent" ("tenantId", "observedAt" DESC, "id" DESC);
```

Why it was necessary. GF-8's primary access path is one tenant's alerts, newest
first — and nothing that already existed serves it:

- `AlertEvent_crossing_key` leads with `(tenantId, trackedDeviceId)` and does not
  contain `observedAt` at all;
- `AlertEvent_tenantId_sourceLocationEventId_idx` and
  `AlertEvent_tenantId_geofenceId_idx` each serve one exact filter and can order
  by neither the observation instant nor the tie-breaker.

Without it, an unfiltered list is a scan of everything the tenant has ever
recorded followed by a sort, so its cost grows with the tenant's whole history
rather than with the page returned. All three existing indexes are untouched and
still serve the lookups they were created for.

Both components descend, matching the `ORDER BY` exactly, so the ordering is
satisfied by a forward index scan with no sort step. Verified against a
2,000-alert fixture: PostgreSQL chooses this index unaided for the default page,
for a deep page, for a filtered page and for a bounded time window.

**Deployment note.** This is a plain `CREATE INDEX`, which takes a `SHARE` lock
and blocks writes to `AlertEvent` (that is, ingestion of crossings) while it
builds. On a large existing table, build it as `CREATE INDEX CONCURRENTLY`
outside Migrate — Migrate runs each migration in a transaction, and
`CONCURRENTLY` cannot run inside one.

---

## Non-goals

Everything below remains deferred and has no endpoint, column, table or
background process in this phase:

- alert acknowledgement, assignment, dismissal, resolution, reopening, mutation
  and deletion;
- manual or arbitrary alert creation;
- notification delivery of any kind — email, SMS, push, chat — and webhooks;
- queues, workers, cron, schedulers, polling, retries, outbox and event buses;
- dwell detection, dwell alerts, timers and escalation policy;
- analytics, summaries, grouped counts, dashboards, reports, exports and bulk
  endpoints;
- free-text search, arbitrary sorting, GraphQL and user-selected relation
  expansion;
- any change to geofence, device, location-event, transition or alert write
  behavior;
- frontend, map or visualization work.

GF-8 opens the filing cabinet. It does not install a dispatch center.

---

## Related documents

- [gf7-geofence-alert-events.md](gf7-geofence-alert-events.md) — how the alerts
  GF-8 reads are created and deduplicated.
- [gf6-geofence-transition-detection.md](gf6-geofence-transition-detection.md) —
  the transition classification a crossing comes from.
- [api.md](api.md) — the full current endpoint surface.
- [security.md](security.md) — authentication and tenant-isolation posture.
