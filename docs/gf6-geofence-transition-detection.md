# GF-6 — Deterministic Geofence Transition Detection

GF-6 answers one question about every accepted location observation: for each
active geofence of the caller's tenant, **did this device just cross the
boundary, and which way?**

It builds directly on GF-5's point-in-circle evaluation and changes none of its
spatial semantics. The containment predicate is not restated anywhere in GF-6 —
it is embedded from the GF-5 module, so both phases share one definition of
"inside".

## Purpose and scope

GF-6 adds:

- a classification of every observation against every applicable geofence;
- the minimum persistent state required to make that classification
  deterministic — one current-state row per tenant, device and geofence;
- an additive `geofenceTransitions` array on the existing ingestion response.

GF-6 explicitly does **not** add alerts. See [Non-goals](#non-goals).

## Transition classification

| Previous state | Current state | Classification     |
| -------------- | ------------- | ------------------ |
| _none_         | Inside        | `BASELINE_INSIDE`  |
| _none_         | Outside       | `BASELINE_OUTSIDE` |
| Outside        | Inside        | `ENTER`            |
| Inside         | Outside       | `EXIT`             |
| Inside         | Inside        | `STAY_INSIDE`      |
| Outside        | Outside       | `STAY_OUTSIDE`     |

### Baseline semantics

The first accepted observation for a (tenant, device, geofence) triple
establishes a baseline. It never reports `ENTER` or `EXIT`, because nothing is
known about where the device was before it: claiming a crossing would be an
invention, not a measurement.

A geofence that is reactivated returns to that unknown-previous condition and
baselines again — see
[Inactive and reactivated geofences](#inactive-and-reactivated-geofences).

### Boundary semantics

Containment is GF-5's, unchanged:

```
ST_Distance("Geofence"."centerPoint", "LocationEvent"."observedPoint")
  <= "Geofence"."radiusMeters"
```

Both operands are `geography(Point, 4326)`, so the comparison is in **meters on
the WGS 84 spheroid**, never degrees and never planar. The predicate is
`<=`, so an observation exactly on the boundary is **inside** — and therefore
arriving on the boundary from outside is a real `ENTER`.

`distanceMeters` in the response is rounded to three decimal places for
serialization only, exactly as in GF-5. It never participates in the containment
decision, so a displayed distance may sit up to half a millimeter above an
unrounded radius while the observation is genuinely inside.

### The applicable set

Every **active** geofence of the caller's tenant is evaluated — not only the ones
that contain the point. An `EXIT` is only observable by measuring a geofence the
device is no longer inside, so GF-5's `ST_DWithin` prefilter is deliberately
absent from the transition statement: that prefilter is an index bound for "which
circles contain this point", and applying it here would silently drop exactly the
distant geofences an exit depends on.

The cost is one geodesic distance per active geofence of one tenant, per accepted
observation. GF-5's containment endpoint is untouched and keeps its index-servable
prefilter.

## Persistent state identity

One row per triple, in `GeofenceDeviceState`:

```
PRIMARY KEY ("tenantId", "trackedDeviceId", "geofenceId")
```

The identity **is** the uniqueness constraint, and it is the conflict target the
atomic upsert infers — so the database, not the service layer, guarantees that
one device/geofence pair can never hold two contradictory rows.

| Column                | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `state`               | `INSIDE` / `OUTSIDE` at the last accepted observation        |
| `lastTransition`      | The classification that observation produced                 |
| `lastLocationEventId` | Which observation the state came from                        |
| `lastObservedAt`      | When that observation was taken, per the source (`timestamptz`) |
| `createdAt` / `updatedAt` | Bookkeeping, written explicitly by the upsert             |

All three foreign keys are **composite on `(id, tenantId)`** — onto `Geofence`,
`TrackedDevice` and `LocationEvent`. A state row whose tenant disagrees with its
geofence, its device or its source event is rejected by PostgreSQL, so
cross-tenant collision is structurally impossible rather than merely avoided by
the query predicates (which also carry the tenant). Deleting a tenant, geofence,
device or source event cascades the state away.

No distance is persisted. Distance is a presentation value derived from the
geography columns on demand; storing it would create a second, staler answer to a
question the database already answers exactly.

`lastTransition` is stored rather than only returned for two reasons: the
`ON CONFLICT` update computes it from the row it is actually overwriting, which is
what makes classification atomic with advancement instead of a read-then-write
race; and a replay of the same event can then answer with the identical
classification rather than a second, differently-worded description of one
crossing.

## Observation ordering

The canonical ordering value is `LocationEvent.observedAt` — the instant the
source reports the fix was taken. Server receipt time (`receivedAt`) is **never**
consulted for ordering.

State advances only when the incoming pair is **strictly greater**:

```
(EXCLUDED."lastObservedAt", EXCLUDED."lastLocationEventId")
  > (state."lastObservedAt", state."lastLocationEventId")
```

### Equal-timestamp tie-break

When two observations share an instant, the one with the **greater event id**
wins, compared as text. Event ids are `cuid`s, which are a stable total order.

This is order-independent in the property that matters: whichever of the two
arrives first, the state that ends up stored is the same. Only the classification
each request is *told* differs, because the first one seen has no predecessor and
baselines.

### Stale observations

An observation older than the stored state does not advance it, and never reports
a crossing. It is reported as `STAY_INSIDE` / `STAY_OUTSIDE` for **its own**
containment, with `stateAdvanced: false`: it is not evidence that the device
crossed anything, and the state it would have to be compared against belongs to a
later observation.

Because `state` always describes the observation carried by the request, a
non-advancing entry's `state` is not necessarily the device's current persisted
state.

For stale input, `STAY_*` means **no crossing can be inferred**, not that the
device historically remained on that side. OUTSIDE at T2 submitted after INSIDE
at T3 returns `state: OUTSIDE`, `transition: STAY_OUTSIDE`, and `stateAdvanced:
false`; stored state remains INSIDE at T3. Authoritative current state is not
returned. Consumers must interpret these fields together.

## Idempotency

Transition detection runs on both the create and the replay path of ingestion.

- Replaying an event with the same `eventKey` and identical observation data
  returns `200` with `replayed: true`. While that event still owns a geofence's
  current-state row, its stored classification repeats with `stateAdvanced:
  false`; even `updatedAt` is unchanged. Once superseded, it follows the stale
  observation policy and its original classification cannot be recovered.
  Replays evaluate the current geofence configuration and active set; this is
  ingestion idempotency, not an immutable historical response.
- Reusing an `eventKey` with **different** data is still a `409`, raised before
  transition detection runs. A conflicting replay never touches state.
- Running detection on the replay path is deliberate: if a first attempt stored
  the event and then failed before advancing state, the client's retry is what
  completes the work. The ordering guard makes re-running it for an event that
  already advanced state a no-op.

## Concurrency strategy

Event creation commits before the separate transition transaction. A transition
failure returns the sanitized HTTP 500 envelope but leaves the event stored.
An identical retry can establish missing state and return `200`, `replayed:
true`, and `stateAdvanced: true`. If a newer event already advanced state,
the retry is stale and cannot reconstruct the omitted comparison. Without a
retry, a stored event can remain unevaluated indefinitely. There is no automatic
repair or shared ingestion/transition transaction. Concurrent original and replay
requests may differ in which response reports advancement.

Comparison and advancement are a **single `INSERT ... ON CONFLICT DO UPDATE`
statement**. Reading the previous state and then writing the new one as two round
trips is a lost-update race — two observations can both read `OUTSIDE` and both
report `ENTER`. PostgreSQL serializes concurrent writers on the conflicting tuple
and re-evaluates the `DO UPDATE` (including its guard and its `CASE` expressions)
against the row version that actually won, so:

- no duplicate state row can exist for one identity;
- no lost update can fabricate a transition;
- no stale input can regress state;
- a failure leaves state either fully advanced or untouched, never partial.

A second statement, in the same transaction, reads the state that owns each
geofence this observation did **not** advance, so a replay can be told apart from
a genuinely older observation. It is a separate statement on purpose: a
common-table expression would see the snapshot the statement began with, which is
exactly the read the upsert exists to avoid trusting.

No queue, worker, scheduler, advisory lock, retry loop or new dependency is
involved.

The conflicting state-row lock is retained until transaction completion even
when the upsert's advancement guard is false. A third writer or deletion cannot
interleave between the upsert and stored-state read for that row.

Evaluated geofences are locked `FOR SHARE` in geofence-ID order until transaction
completion. Either evaluation finishes before API retirement, or it waits and
rechecks the active predicate after deactivation. This prevents an in-flight
evaluation from recreating retired state after the deactivation's delete.
Shared locks remain compatible with concurrent observations.

## Inactive and reactivated geofences

- Inactive geofences are excluded by the join, so they produce no row, no
  comparison and therefore **no `EXIT`**. Deactivating a geofence under a device
  that is inside it reports nothing.
- Accepting a deactivation **retires** that geofence's transition state, in the
  same transaction as the deactivation. Only that geofence, and only inside that
  tenant.
- Consequently, the first accepted observation after a geofence is re-enabled is
  a `BASELINE_INSIDE` / `BASELINE_OUTSIDE`. This is the documented policy: the
  domain model has no activation-version boundary, and resuming a comparison
  against a position the device may have left while the geofence was not being
  evaluated would report a crossing nobody observed.
- The policy is enforced on the geofence-update path. A geofence deactivated by a
  direct database write bypasses it, as such a write bypasses every other
  service-layer rule.
- A geofence that simply disappears from the applicable set (deleted, or made
  inactive) never fabricates a transition; deletion cascades its state away.

## Tenant isolation

`tenantId` is always the authoritative value from the verified principal — never
read from the body, path, query or a client-supplied header.

- The event lookup, the geofence join and the inserted row all carry the tenant
  predicate.
- The device is derived from the stored event, never supplied by the caller.
- The composite foreign keys make a cross-tenant state row impossible to store.
- Two tenants may use the same external `deviceKey` and place geofences at
  identical coordinates without their state ever meeting.
- Every value in both statements is a bound parameter. No identifier, coordinate
  or tenant id is interpolated into statement text.

## Response contract

The classification is returned on the **existing ingestion response**, as an
additive nested array. Every pre-GF-6 field keeps its meaning and value, so a
client that ignores the array is unaffected.

`POST /api/v1/location-events` → `201` (or `200` on replay):

```json
{
  "id": "clx1a2b3c4d5e6f7g8h9i0j1k",
  "tenantId": "clx0000000000000000000t01",
  "trackedDeviceId": "clx9z8y7x6w5v4u3t2s1r0q9p",
  "deviceKey": "van-17",
  "eventKey": "evt-2026-09-09-0001",
  "observedAt": "2026-09-09T06:00:00.000Z",
  "receivedAt": "2026-09-09T06:00:02.000Z",
  "latitude": 30.2672,
  "longitude": -97.7431,
  "accuracyMeters": 8.5,
  "replayed": false,
  "geofenceTransitions": [
    {
      "geofenceId": "clx0000000000000000000001",
      "name": "Warehouse Zone",
      "radiusMeters": 250,
      "distanceMeters": 9.652,
      "state": "INSIDE",
      "transition": "ENTER",
      "stateAdvanced": true
    },
    {
      "geofenceId": "clx0000000000000000000002",
      "name": "Airport Perimeter",
      "radiusMeters": 1500,
      "distanceMeters": 11123.494,
      "state": "OUTSIDE",
      "transition": "STAY_OUTSIDE",
      "stateAdvanced": true
    }
  ]
}
```

| Field           | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `state`         | Where **this** observation sits relative to the circle                |
| `transition`    | Accepted comparison, current-owner replay, or stale no-inference label |
| `stateAdvanced` | Whether this observation became the device's newest accepted state    |
| `geofenceId` / `name` | Geofence identity                                              |
| `radiusMeters` / `distanceMeters` | The same GF-5 values, by the same rounding rule  |

Ordering is GF-5's: ascending distance, then ascending `geofenceId`. The array is
empty when the tenant has no active geofence — a successful evaluation, not an
error.

`stateAdvanced: false` is a normal outcome (a replay or a stale observation), not
a failure.

### The GF-5 endpoint is unchanged

`GET /api/v1/location-events/:id/geofence-evaluation` remains a pure read. It
still returns containing geofences only, stores nothing, and reports no
transition. Adding state advancement to a `GET` would break that guarantee, and
adding a read-only transition view there would duplicate the contract above.

## Non-goals

GF-6 adds none of the following:

alert generation · alert-delivery records · email · SMS · push notifications ·
webhooks · notification-provider SDKs · background workers · queues · schedulers ·
retry systems · dwell-time detection · polygon geofences · route or trip
analytics · real-time sockets · frontend or dashboard changes · new
authentication systems · new authorization models · GraphQL · Redis · Kafka ·
AI/LLM functionality.

There is **no transition-history table**. Only the current-state row exists,
because only the current state is needed to compare consecutive observations.
Durable alert-event generation belongs to GF-7.

Nothing in the response asserts that an alert was created or that anyone was
notified.

## Validation

The table includes GF-6 hardening, including both lifecycle lock interleavings,
replay/stale conflict locks, real failure/retry recovery, and all four cascade
paths. Full TypeScript checking still reports the two pre-existing TS2345 errors
in `src/auth/auth.http.spec.ts` at lines 71 and 73; baseline Git-object compilation
reproduces both errors. The build, lint, and tests below pass.

Run against the disposable PostgreSQL/PostGIS stack:

```bash
npm run test:db
```

| Command                                                                                                                 | Result                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `npx prisma validate`                                                                                                    | schema valid              |
| `npx prisma migrate deploy`                                                                                              | 7 migrations applied      |
| `npx prisma migrate status`                                                                                              | database schema up to date |
| `npm run lint`                                                                                                           | clean                     |
| `npm run build`                                                                                                          | clean                     |
| `npm test`                                                                                                               | 16 suites, 387 tests      |
| `npm run test:e2e`                                                                                                       | 1 suite, 1 test           |
| `npx jest --config test/jest-integration.json --runInBand`                                                               | 8 suites, 263 tests       |
| `npx jest --runInBand --runTestsByPath src/location-events/geofence-transition.service.spec.ts`                          | 31 tests                  |
| `npx jest --config test/jest-integration.json --runInBand --runTestsByPath test/integration/geofence-transition.integration-spec.ts` | 54 tests      |

Database-backed behavior is never mocked: classification, boundary semantics,
ordering, stale rejection, tenant isolation, the reactivation policy and the
concurrency guarantees are all proven against real PostgreSQL/PostGIS in
`test/integration/geofence-transition.integration-spec.ts`.
