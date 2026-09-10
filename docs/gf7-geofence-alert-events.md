# GF-7 — Deterministic Alert-Event Creation and Deduplication

> **Status.** Implemented locally on the
> `phase-gf-7-deterministic-alert-event-creation-deduplication` branch and
> **awaiting independent audit**. Not merged, not released, not deployed.

GF-7 answers one question about every classification GF-6 produces: **is this a
real boundary crossing, and if so, is it already recorded?** When the answer is
"yes, and no", it writes exactly one durable alert event.

It records the alarm. It does not ring it: nothing is sent, queued, scheduled or
retried, and no delivery state exists to be left permanently false.

## Purpose and scope

GF-7 adds:

- a durable `AlertEvent` row for every authoritative accepted `ENTER` and `EXIT`;
- database-enforced deduplication, so one crossing is one alert no matter how
  many times the request arrives;
- an additive, optional `alert` field on each entry of the existing
  `geofenceTransitions` array.

GF-7 explicitly does **not** add notification delivery, dwell detection, alert
management, or any asynchronous machinery. See [Non-goals](#non-goals).

## Alert policy

Only a crossing is an alert.

| GF-6 classification | Alert |
| --- | --- |
| `ENTER` | **One durable alert** |
| `EXIT` | **One durable alert** |
| `BASELINE_INSIDE` / `BASELINE_OUTSIDE` | none |
| `STAY_INSIDE` / `STAY_OUTSIDE` | none |
| Stale observation (`stateAdvanced: false`, superseded) | none |
| Geofence deactivation / state retirement | none |
| Inactive geofence | none (not evaluated at all) |
| Authentication, validation, not-found or conflict failure | none |

**Why a baseline is silent.** The first accepted observation for a device and
geofence — and the first after a reactivation — establishes state and nothing
more. A device that is already inside a geofence never entered it while the
system was watching, so reporting an `ENTER` would be inventing an event that
nobody observed.

**Why a stale observation is silent.** An observation older than the stored state
is reported as a `STAY_*`, and a `STAY_*` is never an alert. It is not evidence
that the device crossed anything: the state it would have to be compared against
belongs to a later observation, and that comparison can no longer be
reconstructed.

**Why there is no dwell alert.** GF-6 declares no dwell classification, and GF-7
invents none. A timer that fires without an observation is a different kind of
fact and belongs to the phase that implements it.

The policy lives in one place,
[`geofence-alert.policy.ts`](../src/location-events/geofence-alert.policy.ts),
and the same two values are written into the `AlertEvent_transition_crossing_check`
CHECK constraint. The constant is where the application decides; the constraint is
where PostgreSQL rejects other labels. The CHECK does not verify spatial history.
A direct SQL session can fabricate an ENTER/EXIT with tenant-consistent references.
Application classification and its transaction establish crossing semantics and
copy provenance; foreign keys do not prove source-device or timestamp equality.

## What an alert stores

GF-7 reuses the `AlertEvent` table declared, unused, by the GF-1 baseline rather
than introducing a competing one. A second alert table would have split "what
happened" across two places for no reason beyond the shape of a model nothing had
ever written.

The columns GF-7 adds are the provenance a crossing needs, and nothing else:

| Column | Meaning |
| --- | --- |
| `tenantId` | The verified principal's tenant. Never read from a request. |
| `trackedDeviceId` | Taken from the stored location event, never supplied. |
| `geofenceId` | The geofence whose boundary was crossed. |
| `sourceLocationEventId` | The observation that produced the crossing. |
| `transition` | `ENTER` or `EXIT`, constrained by CHECK. |
| `observedAt` | The source's own instant, `timestamptz(3)`, copied from the event. |
| `id`, `createdAt` | Stable identity and durable recording time. |

Deliberately absent: coordinates, the measured distance, the geofence radius, and
any device or geofence snapshot. All of them are already reachable through the
foreign keys, and a copy would be a second answer that can go stale. Also absent
is anything about delivery — no channel, recipient, attempt count or sent-at
column exists.

### Reconciling the legacy columns

The GF-1 declaration carried speculative columns for an alert workflow that GF-7
defers. They are reconciled conservatively rather than removed:

- `severity` and `status` keep their pre-existing defaults (`MEDIUM`, `OPEN`).
  GF-7 never reads, advances or exposes them.
- `eventType` and `message` become nullable; `source` was already nullable.
  All three are left `NULL`. The
  authoritative crossing type is the typed `transition` column, so writing it a
  second time as free text would create a value that can disagree with it, and
  inventing a human-readable `message` would be fabricating a notification
  template for a phase that sends nothing. Relaxing `NOT NULL` on two unused
  text columns removes no guarantee anything depended on: the row's meaning is
  carried entirely by typed columns and foreign keys, which this phase tightens.
- `latitude` and `longitude` stay nullable and unwritten, with their existing
  range CHECK constraints intact.

## Deduplication

The deduplication boundary is a real unique index, not an application check:

```sql
CREATE UNIQUE INDEX "AlertEvent_crossing_key" ON "AlertEvent"
  ("tenantId", "trackedDeviceId", "geofenceId", "sourceLocationEventId", "transition");
```

One accepted crossing is one (tenant, device, geofence, source observation,
direction). Retrying a request, replaying the event, racing two identical
submissions and repairing a half-finished ingestion all resolve to that same
tuple.

The insert is `INSERT ... ON CONFLICT DO NOTHING` (Prisma's `skipDuplicates`).
There is deliberately **no** "does it already exist?" read before the write: that
check and the write it guards cannot be made atomic with respect to another
connection doing the same thing, so two concurrent replays would both find
nothing and both insert. Here the second writer's row is discarded by PostgreSQL,
on the index. A crossing-key conflict is successful only when exact read-back
recovers the required alert; unrelated conflicts fail and roll back advancement.

**Direction in the key.** The identity explicitly includes ENTER/EXIT. A normal
geometry edit cannot make an equal or older event advance again: the strict
observation ordering still applies. The key is retained unchanged; it does not
promise reclassification of historical observations after geometry edits.

## Transaction boundary

> A newly accepted `ENTER`/`EXIT` state advancement and its alert commit
> together, or neither commits.

The alert write runs inside the transaction that GF-6's
`GeofenceTransitionQuery.evaluateAndAdvance` already owns. This is the phase's
central safety property, and it is why the alert boundary is handed a transaction
client rather than opening one.

A crossing is only ever visible in the instant it is classified. Once the state
row moves on, nothing can reconstruct that a boundary was crossed. An `ENTER` that
committed without its alert would therefore be an unrecoverable gap, not a
temporary one.

The transaction client is the atomicity boundary. Read-back joins the current
state on crossing identity and sees its uncommitted writes. This is an additional
consistency check, not a substitute for sharing the transaction: an out-of-
transaction insert could already commit before a read-back failure. The committed
rollback tests exercise the actual transaction path. The uncommitted mutation
report is historical context only; see [Adversarial verification](#adversarial-verification).

### The limitation that remains

**Location-event creation is _not_ in that transaction.** This is the known GF-6
boundary and GF-7 does not change it: ingestion stores the event with Prisma
Client, and transition classification plus alert creation run afterwards in their
own transaction. A failure between them leaves the event stored with no state and
no alert, and the request returns 500.

That state is recoverable rather than corrupt. The client's retry with the same
`eventKey` reaches the replay path, which re-runs classification for the stored
event; if no newer observation has superseded it, the crossing is classified again
and the alert is created exactly once. If it has been superseded, the missing
historical comparison cannot be reconstructed by anything — which is the same
pre-existing GF-6 property, not a new one.

No automatic retry, queue or background repair exists.

## Replay, repair and convergence

Replay and repair are the same code path as first arrival. A candidate alert is
produced whenever the current transition state of a geofence is a crossing owned
by this event — true on the advancing request and on replays only while it still owns state.
After supersession, replay follows stale suppression and returns no alert.

- **First arrival** inserts.
- **A replay** conflicts on the unique index and reuses the stored row, returning
  the same `alert.id` and the *original* `alert.createdAt`.
- **A replay after a failure that lost the alert** inserts the missing one.

None of the three needs to know which it is, and the response cannot tell them
apart except by `stateAdvanced`.

Two guards keep a partial result from being reported as success. The read-back
must return exactly one stored alert per accepted crossing: fewer means a crossing
was accepted that the database has no record of, and more means the read-back
matched something other than the crossings just accepted. Either fails the request
inside the transaction, rolling the transition advancement back with it, so the
crossing stays re-derivable by the next replay.

Arrival order is intentionally significant. Newest-first arrival can establish
a baseline and suppress older events, producing zero alerts. Chronological
arrival can reach the same latest position through a crossing and produce an
alert. Latest containment may converge; transition and alert histories need not.

## Migration precondition

The five required columns have no backfill defaults. Deployment requires the
legacy AlertEvent table to be empty; repository absence of a writer does not
prove deployed contents. Nonempty tables fail migration and require an explicit
data migration plan. Verify contents before deployment.

## Concurrency

Every ordering decision belongs to PostgreSQL. Two independent mechanisms carry
the weight:

1. GF-6's single `INSERT ... ON CONFLICT DO UPDATE` serializes concurrent writers
   on the transition-state tuple, so two observations cannot both decide they
   crossed.
2. GF-7's unique index serializes concurrent writers on the alert tuple, so two
   replays cannot both create one.

The integration suite proves the dangerous schedules with controlled
interleavings rather than a burst of parallel requests, confirming through
`pg_blocking_pids` that the second writer really is blocked before the first
commits:

- two writers released into the same instant around one transition identity
  produce one alert, and both responses name it;
- an alert inserted and held uncommitted by a competing session forces the
  application's insert to block on the index; on release it reuses that row and
  answers `200`, not `500`, with no constraint name in the body;
- an observation overtaken mid-flight — its state advanced and committed
  underneath it before it proceeds — records nothing, and the crossing that really
  was accepted still resolves to exactly one alert;
- deactivation committing while an evaluation is blocked produces no phantom
  `EXIT` and leaves no state behind.

## API surface

No new route. `POST /api/v1/location-events` gains one optional field per
transition entry:

```json
{
  "geofenceId": "clx0000000000000000000001",
  "name": "Warehouse Zone",
  "radiusMeters": 250,
  "distanceMeters": 9.652,
  "state": "INSIDE",
  "transition": "ENTER",
  "stateAdvanced": true,
  "alert": {
    "id": "clx0000000000000000000009",
    "createdAt": "2026-09-09T06:00:01.482Z"
  }
}
```

`alert` is present only when `transition` is `ENTER` or `EXIT`, and the key is
**absent entirely** otherwise — not present and null — so the absence of a
crossing cannot be misread as an alert whose fields failed to arrive.

Only two fields are exposed, because nothing else in the response carries them.
`id` is the stable identity a client correlates against later, and it is identical
on every replay. `createdAt` is the original recording time, which is what
distinguishes an idempotent reuse from a second alert. The geofence, direction,
device, tenant and observation instant are deliberately not repeated: they are
already stated by the enclosing entry and the response body, and a second copy
could appear to disagree.

Not exposed at all: the deduplication key, `severity`, `status`, and any database
or constraint detail. An unrelated uniqueness collision fails with a sanitized error if exact
read-back cannot recover the required alert.

## Ownership boundaries

| Layer | Responsibility |
| --- | --- |
| `LocationEventsController` | Unchanged. Authentication context, validated input, HTTP status. |
| `LocationEventsService` | Unchanged. Orchestration only. |
| `GeofenceTransitionQuery` | Owns the transaction; the alert write joins it. |
| `GeofenceTransitionService` | Serializes the classification and attaches the alert. |
| `geofence-transition.classification.ts` | The single authoritative classification rule. |
| `geofence-alert.policy.ts` | Which classifications are alerts. |
| `GeofenceAlertService` | Derives candidates, mediates persistence, maps the DTO. |
| `GeofenceAlertQuery` | The two statements. Classifies nothing. |
| Database constraints | Final deduplication and tenant consistency. |

`classifyTransition` was extracted from `GeofenceTransitionService` without a
change of behaviour, because two callers now need the identical answer and must
not be able to disagree about it: the service that serializes it into the
response, and the alert boundary that decides inside the transaction whether the
crossing is durable. Duplicating the rule in the second caller is exactly the
defect that would let an alert describe a different crossing from the one the API
reported.

## Tenant isolation

- `tenantId` on an alert is always the verified principal's, derived from the JWT
  and validated membership. The ingestion DTO rejects unknown properties, so a
  caller cannot supply one at all.
- All three foreign keys are composite on `(id, tenantId)`, onto `Geofence`,
  `TrackedDevice` and `LocationEvent`. PostgreSQL rejects any alert whose tenant
  disagrees with its geofence, device or source event, so a cross-tenant alert is
  structurally impossible rather than merely avoided by query predicates — which
  also carry the tenant.
- The GF-1 single-column `AlertEvent_geofenceId_fkey` is replaced by the composite
  `AlertEvent_geofenceId_tenantId_fkey`. It enforces everything the old key did
  and tenant agreement as well, so this is a strictly stronger constraint.
- Deletion cascades and cannot reach across tenants: each referenced row is proven
  to belong to the alert's own tenant by the very same key.
- Two tenants may use the same external `deviceKey`. The deduplication key is
  built from internal, tenant-scoped identities, so their crossings never collide
  and neither can learn that the other exists.
- Every statement binds every value as a parameter. No identifier, tenant id or
  event id is interpolated into statement text.

## Adversarial verification

The implementation author reported the following scratchpad mutations. The
mutation harness and outputs were not committed, so these are historical claims,
not independently reproducible audit evidence. Committed regression tests and
independent audit results are the verification record.

| # | Defect | Detected by |
| --- | --- | --- |
| 1 | `BASELINE_INSIDE` allowed to alert | baseline policy tests |
| 2 | `STAY_*` allowed to alert | stay policy tests |
| 3 | Conflict-safe insert removed (`skipDuplicates: false`) | replay/deduplication tests |
| 4 | `tenantId` dropped from the uniqueness key | catalog assertion on the index definition |
| 5 | Request-supplied tenant identity honoured | caller-supplied-tenant test |
| 6 | Stale observations alert | stale-observation test |
| 7 | Alert read-back not anchored to the source event | source-anchoring test |
| 8 | Alert persisted outside the transition transaction | ENTER provenance test |
| 9 | Deactivation no longer retires state | reactivation baseline test |
| 10 | A new alert identity returned on replay | replay identity test |

Mutations 7 and 8 were **not** detected on the first pass. That gap was real, and
it was closed by strengthening the implementation rather than the assertions: the
read-back became a join against the authoritative transition state, and the
alert-count invariant became exact. Both mutations are now detected
deterministically.

## Non-goals

GF-7 adds none of the following:

email · SMS · push notifications · Slack · Discord · webhooks ·
notification-provider SDKs · queues · workers · cron jobs · schedulers · polling
loops · retry daemons · outbox tables · event buses · Kafka · Redis · BullMQ ·
RabbitMQ · user-configurable alert rules · thresholds · quiet hours · escalation
policies · routing · dwell detection or timers · alert acknowledgement,
assignment, dismissal, resolution or reopening · incident management · alert
list/detail/search endpoints · manual alert creation · polygon geofences · bulk
ingestion · new auth or tenancy models · frontend or dashboard changes · new
dependencies.

There is **no delivery record and no delivery column**. An alert here is a
recorded fact, not a message. The phase that delivers alerts will read these rows;
the fact that it does not exist yet is precisely why there is no `sentAt` to leave
permanently null.

Nothing in the API response asserts that anyone was notified.

## Related documents

- [gf6-geofence-transition-detection.md](gf6-geofence-transition-detection.md) —
  the classification GF-7 consumes
- [database-schema.md](database-schema.md) — the `AlertEvent` table
- [api.md](api.md) — the ingestion response contract
- [security.md](security.md) — tenant isolation posture
- [testing.md](testing.md) — what is proven where
