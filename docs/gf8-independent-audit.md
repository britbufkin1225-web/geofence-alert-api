# GF-8 — Independent Audit

**Scope.** Independent adversarial audit of the GF-8 implementation commit
`6b72e2b0552c6cec38371643e2c3c09f3d42f271` against the locked baseline
`3abd9303e08da4c9c8794395be29968116215198`.

**Verdict: PASS WITH CAVEAT.** One reproducible defect (P1) and one misleading
documentation guarantee (P2) were found, fixed, and covered by regression tests.
Tenant isolation, read-only behavior, response mapping, ordering, filters, the
migration and the index were verified against a real PostgreSQL/PostGIS database
and found correct as claimed.

The original implementation commit is unchanged. All audit work is in one
separate commit on top of it. Nothing was pushed, merged, or deployed.

---

## 1. What was verified independently

Every claim below was checked against production code, live HTTP behavior, real
database state, PostgreSQL catalogs, and Git — not against the implementation's
own report or test names.

### Provenance

| Fact | Result |
| --- | --- |
| Canonical path | `C:\Users\britb\Documents\geofence-alert-api` |
| Remote | `github.com/britbufkin1225-web/geofence-alert-api` |
| Branch | `phase-gf-8-authenticated-tenant-scoped-alert-retrieval-api` |
| Merge base with `origin/main` | `3abd930` — equals the locked baseline |
| Commits above baseline before audit | exactly 1 (`6b72e2b`) |
| Divergence before audit | 0 behind / 1 ahead |
| GF-7 impl `b37143e` + hardening `46606f4` ancestors of baseline | yes |
| Implementation diffstat | **24 files, +4,045 / −32 — reconciles exactly** |
| Secrets, conflict markers, generated files, logs in diff | none |
| `package.json` / `package-lock.json` / `.env` touched | no — zero dependency change |

The implementation report's "Edited 10 files" summary refers to an interrupted
tooling session, not to this commit. Git's 24-file diff is authoritative and is
what was audited.

### Tenant isolation — verified, no defect

Proven against a two-tenant real-database fixture whose alerts were produced only
through the real ingestion path (GF-6 classification → GF-7 persistence), with
both tenants crossing at **identical instants**:

- Both routes are covered by the global `JwtAuthGuard` registered as `APP_GUARD`
  in `auth.module.ts`. `AlertEventsController` carries no `@Public()`, so it
  fails closed. The guard revalidates the exact `(membershipId, userId,
  tenantId)` tuple against the database on every request.
- `tenantId` is read only from `principal.tenantId`. Attempts to supply it via
  `tenantId`, `tenant_id`, `TenantId`, `__proto__[tenantId]`,
  `constructor[prototype][tenantId]` and `where[tenantId]` query keys all return
  `400` from `forbidNonWhitelisted`; `X-Tenant-Id` and `X-Forwarded-Tenant`
  headers are ignored entirely. No attempt leaked a foreign row.
- The database total (6) equals the sum of the two tenants' reported totals
  (3 + 3); each tenant's `data` contained exactly one distinct `tenantId`.
- A foreign alert id and a never-issued alert id return byte-identical `404`
  bodies and the same status.
- Every `AlertEvent` foreign key is **composite and includes `tenantId`**
  (`(geofenceId, tenantId)`, `(trackedDeviceId, tenantId)`,
  `(sourceLocationEventId, tenantId)`), so a cross-tenant relation is not merely
  unqueried but structurally impossible.

### Read-only — verified, no defect

Full row-level snapshots of `AlertEvent` and `GeofenceDeviceState` plus the
`LocationEvent` count were captured before and after a barrage of GETs including
list, deep page, filtered list, detail, a `404` detail and a `400` list. The
snapshots were identical. No domain write, no transition-state change, no lazy
alert creation, no `updatedAt` movement. The application has no request-log
table, so "no writes" is unqualified here.

### Response mapping — verified, no defect

Both routes return exactly the eight documented fields at the HTTP boundary, in
list and detail alike, from one explicit mapper over an explicit Prisma `select`.
The response DTOs are plain TypeScript interfaces, so nothing is serialized that
the mapper did not name.

**`tenantId` exposure decision: retain.** The consistency claim is true —
`Geofence` and `LocationEvent` responses both publish `tenantId`. Under a tenant
boundary that is verified to hold, the value discloses nothing the caller did not
prove by authenticating, and removing it would make alert history the only
top-level tenant-owned resource that omits its own scope. Retained as a
deliberate, tested decision rather than an accident: two mutation checks confirm
the eight-field set is asserted at the serialization boundary.

### Ordering and pagination semantics — verified, no defect

- The production order is exactly `observedAt DESC, id DESC`, applied in the
  database.
- With three alerts sharing one `observedAt` (one observation crossing three
  geofences), paging one at a time reproduced the full-list order exactly: no
  duplicate, no omission.
- Filters apply identically to `findMany` and `count` — both take the *same*
  where object — confirmed across six filter combinations by comparing `total`
  against the materialized item count and against `totalPages` at `limit=1`.
- Combined filters are `AND`. Unknown parameters are rejected by the whitelist.
- The half-open `[observedFrom, observedBefore)` contract holds: equal bounds
  return an empty `200` (coherent — a half-open interval that meets is empty),
  reversed bounds return `400 "must not be earlier than observedFrom"`.

### Migration and index — verified, no defect

- The migration adds **only** the one index plus comments. No historical
  migration was modified (`git diff` over `prisma/migrations/` shows one added
  file and nothing else).
- Catalog definition matches the schema and the migration SQL exactly:
  `CREATE INDEX "AlertEvent_tenantId_observedAt_id_idx" ON public."AlertEvent" USING btree ("tenantId", "observedAt" DESC, id DESC)`.
  Name length 37 characters — well inside PostgreSQL's 63-byte limit.
- The hand-removal of the PostGIS drift blocks was correct **and complete**:
  `prisma migrate diff` against the migrated database emits exactly the two
  documented `Geofence.centerPoint` / `LocationEvent.observedPoint` blocks and
  nothing else. Had the edit discarded anything necessary, the missing index
  would appear in that drift. It does not.
- Fresh application of all nine migrations on a disposable PostGIS 16.4 instance
  succeeds.
- **Populated upgrade:** the 8-migration baseline was deployed, loaded with
  25,000 alerts across 5,000 distinct instants, then upgraded. All 25,000 rows
  survived, the index was created in 2.2 s, and all 3 foreign keys, 3 check
  constraints and the primary key remained intact. `prisma migrate status`
  reports 9 migrations, up to date.
- **Deployment note verified empirically.** `CREATE INDEX` was observed taking a
  `ShareLock` on `AlertEvent` (blocks writes, permits reads), and
  `CREATE INDEX CONCURRENTLY` inside a transaction block was reproduced failing
  with `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.
  Both statements in the migration comment and the API document are accurate.

### Query plans — verified independently, one claim narrowed

Rebuilt from scratch rather than trusting the implementation's 2,000-row fixture:
30,003 alerts for one tenant against 503 for another (realistic skew), then
`EXPLAIN ANALYZE` with the planner **unaided**:

| Query shape | Plan chosen |
| --- | --- |
| Default page, large tenant | Index Scan on the GF-8 index, no sort |
| Default page, small tenant | Index Only Scan on the GF-8 index |
| Bounded observation window | Index Only Scan, all three bounds as Index Cond |
| Transition-only filter | Index Scan on the GF-8 index + filter |
| Deep offset (20,000) | Index Only Scan — but walks 20,010 entries |
| Detail lookup | `AlertEvent_pkey`, `tenantId` applied as a filter in the database |
| `count(*)` by tenant | `AlertEvent_tenantId_geofenceId_idx` (a narrower pre-existing index) |

The implementation did **not** commit the error the audit brief warns about: it
separates a small-fixture suite that uses `SET LOCAL enable_seqscan = off`
(explicitly labelled as proving only that the index *can* serve the query) from a
2,000-row suite where the planner chooses unaided. That separation is correct and
its assertions are sound.

Two honest narrowings, now recorded in the API document:

- The index does **not** serve the plain per-tenant `count(*)`; a narrower
  existing index does, which is the correct outcome and costs nothing.
- Deep offsets are index-supported but still walk every skipped entry, so the
  index removes the sort, not the offset cost.

The index remains justified: it is the only index that can order the default
list, and it converts the primary access path from scan-plus-sort into a bounded
index scan.

---

## 2. Findings

### P1 — Unbounded `page` produced a `500` on hostile input. Fixed.

**Evidence.** `page` carried `@IsInt()` and `@Min(1)` but no maximum.
`@IsInt` accepts any *integral* double, so `?page=1e20` passed validation, became
`skip = (1e20 − 1) × 10 = 1e21`, and exceeded the 64-bit integer Prisma binds an
`OFFSET` as. Reproduced against the real database:

```
GET /api/v1/alert-events?page=1e20   -> 500 Internal Server Error
   PrismaClientValidationError: Invalid `this.prisma.alertEvent.findMany()` invocation
```

Threshold established by bisection: `skip ≤ 1e18` returned `200`; `skip ≥ 1e19`
returned `500`.

A second, quieter symptom: `?page=9007199254740993` was accepted and the response
echoed `"page": 9007199254740992` — a different number than the caller sent,
because the value was rounded past `Number.MAX_SAFE_INTEGER`.

This contradicted the DTO's own documented contract, which claimed "every
malformed form therefore fails validation rather than being coerced into
something plausible."

**Disposition — fixed.** `ALERT_EVENT_PAGINATION_MAX_PAGE` is derived, not
chosen, as `floor(Number.MAX_SAFE_INTEGER / ALERT_EVENT_PAGINATION_MAX_LIMIT)`,
and applied as `@Max` on `page`. At the maximum limit the deepest accepted `skip`
is `9,007,199,254,740,800` — an exact JavaScript integer and a valid `OFFSET`.
The bound rejects nothing a real client could want and closes both the crash and
the silent-rounding class in one predicate. Verified over real HTTP: every
previously-`500` input now returns `400`, the boundary page still returns `200`
and echoes its page unrounded, and ordinary pages are unaffected.

**Scope note.** The pre-existing `PaginationQueryDto` used by
`GET /api/v1/geofences` has the identical unbounded `page`, and
`GET /api/v1/geofences?page=1e20` was reproduced returning `500` as well. GF-8
inherited the pattern by deliberately mirroring the sibling endpoint rather than
inventing a defect. Only the GF-8 DTO was changed here; the geofence endpoint is
pre-existing baseline debt and is recorded in §5 as deferred, per the audit
brief's instruction not to fix repository-wide debt in this phase.

### P2 — The read-consistency section overstated paging safety. Corrected.

**Evidence.** The document stated that the READ COMMITTED consequence is "**not**
a wrong page, a duplicated row or a missing one, because the ordering is total."
Read as written that sentence is about the two statements inside one request, and
in that narrow sense it is **accurate** — confirmed by controlled interleaving:
inside one READ COMMITTED transaction the same predicate counted 30,004 and then
30,005 after a concurrent commit, while the page itself came from a single
consistent snapshot.

But the claim sits in a section a client reads for guidance on paging a feed, and
the `sort` block in every response reinforces it. Total ordering does **not**
prevent cross-request offset drift, and this was demonstrated directly:

| Request | Rows returned |
| --- | --- |
| page 1 (`limit=2`) | `…g3oiptl6`, `…47x1ac1y` |
| *(one newer alert committed)* | |
| page 2 (`limit=2`) | `…47x1ac1y` **(duplicate)**, `…ppfxevob` |

The client saw one alert twice, and the newly ingested alert appeared on neither
page.

**Disposition — documentation corrected.** The within-request guarantee is now
explicitly scoped to one response, and a new section documents cross-request
offset drift with the reproduction above, recommends bounding a sweep with the
half-open `observedFrom`/`observedBefore` window, and records that keyset/cursor
pagination would close it properly and is deliberately out of GF-8 scope. No
cursor redesign and no isolation-level change were introduced: this is inherent
to offset pagination, which is the established convention in this repository.

### P3 — Prettier "94 files" accounting is coincidental. Recorded, not fixed.

Both baseline failures reproduce exactly and neither was introduced by GF-8:

- `tsc -p tsconfig.json --noEmit` fails with the same two `TS2345` errors in
  `src/auth/auth.http.spec.ts` at the baseline and at HEAD. `tsconfig.build.json`
  (production) is clean at both.
- Repo-wide Prettier fails on 94 files at both commits.

The cause is confirmed as line endings, not formatting: `core.autocrlf=true` with
**no `.gitattributes`**, so checkouts are CRLF while Prettier's default
`endOfLine: "lf"` expects LF. Proven at the byte level — every committed GF-8
blob is pure LF (`git cat-file` shows 0 CR bytes) and **every GF-8-touched file
passes Prettier in its committed form**. No line-ending churn is hidden in the
diff; `git diff --check` is clean.

One correction to the accounting: the counts match by coincidence. The baseline
fails 94 of 94 files; HEAD fails 94 of 105, because the implementation rewrote
eleven files with LF endings in the working tree. GF-8 added **zero** Prettier
debt. Repository-wide line-ending debt is deferred per the audit brief.

---

## 3. Test and mutation quality

The committed tests are genuine proof, not test-count theater. The integration
fixture produces every alert through the real ingestion path rather than by
inserting alert rows, so the read path is proven against the write path. It
deliberately constructs the one case an ordering without a tie-breaker gets
wrong — one observation crossing three geofences at one instant.

No mutation harness or mutation list was committed with the implementation, so
the "ten reported mutations" could not be reproduced as reported. This matches
the GF-7 audit precedent, where uncommitted mutation claims were likewise
labelled implementation-author reports. An **independent** ten-mutation audit was
run instead, each mutation reverted with `git checkout --`, and each verified to
fail behaviorally rather than by compile error (`tsc -p tsconfig.build.json`
checked clean for every one):

| # | Injected defect | Detected |
| --- | --- | --- |
| 1 | `buildAlertEventWhere` drops `tenantId` | yes — unit + integration |
| 2 | `findOne` drops `tenantId` from the predicate | yes — unit + integration |
| 3 | `ORDER BY` loses the `id` tie-breaker | yes — unit only (see below) |
| 4 | `observedBefore` becomes inclusive (`lt`→`lte`) | yes — unit + integration |
| 5 | `count` ignores the filters the page applied | yes — unit + integration |
| 6 | `select` dropped and the raw record returned | yes — **including at the HTTP boundary** |
| 7 | `skip` arithmetic off by one page | yes — unit + integration |
| 8 | GET performs an `updateMany` | yes — unit + integration |
| 9 | `limit` loses its maximum bound | yes — unit + integration |
| 10 | List ordered oldest-first | yes — unit + integration |

All ten were behaviorally detected. Two observations worth recording:

- **Mutation 6** is caught at the serialization boundary, not only in the
  service: the integration test *publishes exactly the eight documented fields*
  fails when raw records leak. This is the strongest form of that guard.
- **Mutation 3** is caught only by white-box assertions on the production
  `orderBy` array, not by observable behavior. This is appropriate rather than a
  gap: at fixture scale PostgreSQL returns tied rows in a stable order anyway, so
  a black-box test for the tie-breaker would be non-deterministic. The assertion
  reads the argument the production code actually passes to Prisma, which is not
  tautological.

### Tests added by this audit

Six DTO cases, one HTTP case and two real-database cases, all guarding the P1
fix — the derived bound and its arithmetic, `1e20`, `1e18`, values past
`Number.MAX_SAFE_INTEGER`, the `400` envelope, the proof that the database is
never reached, and the proof that the deepest accepted page still succeeds and
reports its page number unrounded. No existing test was weakened or loosened.

---

## 4. Validation matrix

| # | Check | Result |
| --- | --- | --- |
| 1 | Dependency/lockfile integrity | unchanged by GF-8 and by this audit |
| 2 | `prisma validate` | pass |
| 3 | `prisma format` | no tree change (schema hash identical before/after) |
| 4 | `prisma generate` | pass, no tree change |
| 5 | `eslint` | pass, 0 problems |
| 6 | Prettier, GF-8/audit-touched files | pass (committed LF form) |
| 7 | Prettier, repo-wide | 94 files fail — reproduced at baseline, pre-existing |
| 8 | `nest build` | pass |
| 9 | `tsc -p tsconfig.build.json --noEmit` | clean |
| 10 | `tsc -p tsconfig.json --noEmit` | 2 errors — reproduced at baseline, pre-existing |
| 11 | Unit + HTTP suite | **537 passed / 537**, 21 suites |
| 12 | Integration suite (real PostGIS) | **385 passed / 385**, 10 suites |
| 13 | E2E suite | 1 passed / 1 |
| 14 | Fresh 9-migration application | pass |
| 15 | Populated baseline→GF-8 upgrade (25,000 alerts) | pass, 2.2 s, no data loss |
| 16 | `prisma migrate status` | 9 migrations, up to date |
| 17 | Drift comparison | exactly the two documented PostGIS blocks, nothing else |
| 18 | Catalog inspection | index/constraints match schema exactly |
| 19 | Independent query plans (30k rows, skewed tenants) | index chosen unaided |
| 20 | Independent hostile-input probes | P1 found; all others clean |
| 21 | Tenant-isolation adversarial probes (2 tenants, equal instants) | clean |
| 22 | Equal-timestamp page-boundary probe | clean |
| 23 | Controlled READ COMMITTED interleaving | skew reproduced, claim narrowly accurate |
| 24 | Cross-request offset drift | drift reproduced → doc corrected |
| 25 | No-domain-write before/after snapshots | identical |
| 26 | Ten independent mutations | 10/10 behaviorally detected |
| 27 | Secret / log / conflict-marker scan | clean |
| 28 | `git diff --check` | clean |

**Database identity (sanitized).** Container `geofence-gf3-disposable-postgis`,
image `postgis/postgis:16-3.4`, PostgreSQL 16.4, database
`geofence_gf3_disposable`, tmpfs-backed, bound to `127.0.0.1` only, guarded by
`scripts/disposable-db-identity.js`. No credentials are reproduced here. All
destructive work was confined to this instance.

---

## 5. Caveats and deferred work

Evidence-backed, and none of them blocking:

1. **Cross-request offset drift.** Inherent to offset pagination; now documented
   rather than silently implied away. Keyset pagination would close it and is out
   of GF-8 scope.
2. **READ COMMITTED count skew.** Real, reproduced, and bounded to `total` only —
   the page itself is always internally consistent. Accepted, documented.
3. **Deep offsets are bounded, not cheap.** The index removes the sort, not the
   offset walk.
4. **`GET /api/v1/geofences?page=1e20` still returns `500`.** Pre-existing
   baseline defect in `PaginationQueryDto`, reproduced during this audit, out of
   GF-8 scope. Recommended as the next small hardening item.
5. **Repository line-ending debt.** No `.gitattributes` with
   `core.autocrlf=true` makes repo-wide Prettier and the two `tsc` spec errors
   fail on any Windows checkout. Pre-existing at baseline; a one-line
   `.gitattributes` would fix it repository-wide, outside this phase.
6. **Migration lock on a large deployed table.** The plain `CREATE INDEX` blocks
   ingestion while it builds — 2.2 s for 25,000 rows here, but proportional to
   table size. The document's `CONCURRENTLY`-outside-Migrate guidance is correct
   and was verified.
7. **No deployed database was inspected.** All database evidence comes from the
   disposable instance. What a live database contains is unknown to this audit.

---

## 6. Regression and scope

GF-1 through GF-7 behavior is unchanged: the full unit/HTTP suite (537) and the
full integration suite (385) pass, including the GF-3 tenant-isolation, GF-4
ingestion, GF-6 transition and GF-7 alert-creation suites. The three shared-code
edits GF-8 made are additive and backward-compatible — exporting `CUID_PATTERN`,
narrowing `isAlertProducingTransition` to a type predicate (no runtime change),
and adding a new cross-property validator that no existing DTO uses.

No prohibited feature entered this audit: no acknowledgement, resolution or
mutation route; no notification, webhook, queue, worker, outbox, dwell, analytics
or export surface; no cursor-pagination redesign; no auth or tenancy redesign; no
dependency; no formatting sweep; no edit to any historical migration.
