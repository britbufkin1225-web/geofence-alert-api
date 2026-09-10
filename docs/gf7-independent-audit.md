# GF-7 independent audit

Audit date: 2026-09-09 America/Chicago (2026-09-10 UTC).

Verdict: **PASS WITH CAVEAT — READY FOR PUSH/PR/MERGE**. GF-7 behavior and the expanded database regressions pass. The repository-wide no-emit command still fails on two pre-existing auth-test type errors; this is not a fully green validation result. Deployment also requires an empty legacy AlertEvent table.

## Locked state and scope

Baseline: a34539dcd799595bb8aaef6bd0e7e35ec6257a4c.
Implementation reviewed: b37143edda4a29741fc2c5d1bc2dc8e9eddf2ba9.
The shorter malformed hash in the request's opening block was superseded by its explicit mandatory-preflight full SHA.

Starting branch: phase-gf-7-deterministic-alert-event-creation-deduplication.
All seven mandatory preflight commands returned exit 0. Status was clean. HEAD matched implementation; origin/main, merge base and HEAD parent all matched baseline. Divergence was 0 behind / 1 ahead. No unrelated commits. The earlier attempt stopped on an untracked audit file; that file was absent at this run's clean preflight, so no existing report was overwritten. Git emitted a sandbox global-ignore access warning, not a repository modification.

The complete implementation diff was inspected: **28 files, 4,080 insertions, 151 deletions**. Stat, name-status, numstat and whitespace checks were run against the verified baseline/implementation pair (origin/main..HEAD resolved to exactly those SHAs). No configuration, dependency, endpoint, delivery or unrelated changes were introduced.

| Changed file | Classification |
| --- | --- |
| README.md | Documentation |
| docs/api-endpoints.md | Documentation |
| docs/api.md | Documentation |
| docs/database-schema.md | Documentation |
| docs/gf7-geofence-alert-events.md | Documentation |
| docs/project-status.md | Documentation |
| docs/security.md | Documentation |
| docs/testing.md | Documentation |
| prisma/migrations/20260909180000_geofence_alert_events/migration.sql | Database schema or migration |
| prisma/schema.prisma | Database schema or migration |
| src/location-events/dto/geofence-alert-response.dto.ts | Application implementation |
| src/location-events/dto/geofence-transition-response.dto.ts | Application implementation |
| src/location-events/dto/location-event-response.dto.ts | Application implementation |
| src/location-events/geofence-alert.policy.spec.ts | Unit test (includes mocked HTTP tests) |
| src/location-events/geofence-alert.policy.ts | Application implementation |
| src/location-events/geofence-alert.query.ts | Application implementation |
| src/location-events/geofence-alert.service.spec.ts | Unit test (includes mocked HTTP tests) |
| src/location-events/geofence-alert.service.ts | Application implementation |
| src/location-events/geofence-transition.classification.ts | Application implementation |
| src/location-events/geofence-transition.query.ts | Application implementation |
| src/location-events/geofence-transition.service.spec.ts | Unit test (includes mocked HTTP tests) |
| src/location-events/geofence-transition.service.ts | Application implementation |
| src/location-events/location-events.http.spec.ts | Unit test (includes mocked HTTP tests) |
| src/location-events/location-events.module.ts | Application implementation |
| test/integration/database-constraints.integration-spec.ts | Integration test |
| test/integration/database-structure.integration-spec.ts | Integration test |
| test/integration/geofence-alert.integration-spec.ts | Integration test |
| test/integration/geofence-transition.integration-spec.ts | Integration test |

## Findings by severity

No P0 or P1 runtime defect was demonstrated.

### P2 — Database guarantees overstated (corrected)

The original migration note 2, schema AlertEvent commentary, policy, security guide and GF-7 guide claimed the CHECK prevents fabricated crossings. It only permits ENTER/EXIT labels. The new regression deliberately inserts an ENTER for a baseline with a different same-tenant device and a different observedAt; PostgreSQL accepts it. Composite foreign keys enforce tenant agreement and existence, not complete device/time provenance or spatial history. The application transaction supplies those guarantees. No schema redesign was warranted.

The original read-back commentary also overstated its ability to enforce atomicity independently. A separately committed insert cannot be undone by a later failed read. Corrected to identify the shared transaction client as the actual atomicity mechanism.

### P2 — Arrival-order and replay claims overstated (corrected)

The original test titled “converges to the same state and alert set whichever order the events arrive in” only ran newest-first. Renamed it and added chronological FAR/FAR/INSIDE arrival. Newest-first yields BASELINE_INSIDE and zero alerts; chronological yields ENTER and one alert. The strict stale policy is unchanged. Documentation now limits replay alert reuse to the event that still owns current state, and removes the unsupported claim that a normal geometry edit permits the same older event to cross again in the opposite direction. Direction remains in the uniqueness key unchanged.

### P2 — Migration deployment precondition overstated (documented)

Five required columns have no backfill defaults. Absence of a repository writer does not establish deployed table contents. Fresh empty deployment passed; a separate rollback-only legacy-schema probe applied migrations 2–7 (PostGIS already present), inserted a valid legacy alert, and applied migration 8. It failed as expected with SQLSTATE 23502: column observedAt contains null values. The entire probe schema was rolled back. Live databases were not inspected. Verify emptiness or plan explicit data migration before deployment. Migration SQL behavior is unchanged; only comments changed. Comment changes alter migration checksum, so any environment that already applied the original GF-7 migration needs checksum/history review rather than blindly assuming byte identity.

### P2 — GF-7 integration response type omitted alert (fixed)

The new assertion in geofence-transition.integration-spec.ts accessed alert on TransitionBody without declaring it, causing TS2339 in npx tsc --noEmit. Added the optional response shape. No production behavior changed.

### P3 — Legacy-column and evidence descriptions inaccurate (corrected)

Only eventType and message become nullable; source was nullable at baseline. Coordinate columns remain present and nullable. Documentation now distinguishes validated ingestion input from copied alert provenance. Uncommitted mutation experiments are labelled implementation-author reports, not independent reproducible evidence. Published test counts updated. Corrected a unit-test comment that contradicted its empty-candidate assertion.

### P3 — Pre-existing repository no-emit failures (remaining caveat)

src/auth/auth.http.spec.ts:71 and :73 pass unknown to Supertest send, which expects string | object | undefined (TS2345). The file, package manifest/lock and TypeScript configuration are unchanged from baseline; git diff against baseline confirms no auth-file difference. These are outside GF-7 hardening scope and remain untouched. Application build, lint, Jest and Prisma validation pass. No claim is made that repository-wide no-emit passes.

## Call path and transaction audit

Global JwtAuthGuard verifies JWT algorithm/signature/expiry and membership tuple; LocationEventsController passes principal.tenantId. LocationEventsService resolves an active device through tenantId/deviceKey, validates observation time and exact replay payload, then persists or reuses the event. Event creation is outside the transition transaction, as in GF-6.

GeofenceTransitionQuery.evaluateAndAdvance opens prisma.$transaction. Its tx.$queryRaw evaluates the tenant-qualified stored event against active tenant geofences using the shared PostGIS containment expressions. FOR SHARE locks geofences in ID order. INSERT ON CONFLICT DO UPDATE serializes each state identity and advances only for a strictly greater (observedAt, eventId) pair. The SQL comparison/classification expressions are unchanged from GF-6; GF-7 adds device/time output columns. classifyTransition is a behavior-preserving extraction of the previous classifier: advanced label, otherwise current owner label, otherwise STAY at the evaluated containment.

The same tx reads non-advanced stored state and flows into alerts.record, persistAndRead, tx.alertEvent.createMany(skipDuplicates: true), then tx.$queryRaw read-back. No root Prisma client is used for those writes/reads. Errors propagate through the callback and roll it back. AlertService checks exact row count and unique-geofence cardinality before returning; response mapping occurs after commit using the same classifier and captured rows. Baseline, stay, stale, inactive and retirement paths produce no candidates. Replay of an intact current crossing reuses its alert without changing it; out-of-band deletion can be repaired while that event still owns crossing state. Transaction failure itself does not leave committed crossing state missing its alert.

Read-back joins tenant, device, geofence, source event and direction to current state and filters tenant/source/geofence candidates. Event IDs and geofence IDs are globally unique primary keys; literal duplicate internal IDs across tenants cannot exist. Shared external keys and coincident geometry remain isolated. No alert-list endpoint exists. The uniqueness index contains exactly tenantId, trackedDeviceId, geofenceId, sourceLocationEventId, transition. No check-then-insert race exists in alert persistence. An added temporary unrelated unique index proved skipped insertion without the required read-back row raises a sanitized 500 and rolls state back; removing it allows an exact retry to create the missing EXIT.

## Controlled concurrency and failures

Existing four schedules exercise replay/state locking, competing uncommitted unique-key insertion, stale/newer advancement and deactivation. Their pg_blocking_pids checks establish real blocking rather than sleep-based guesses. The synthetic missing-alert and manually advanced-state fixtures are out-of-band states, not outcomes a failed application transaction can leave.

Four new cases wrap the real persistAndRead once, pause after the real insert/read-back while the transaction is open, then start a second real evaluation. External reads still see the previous state and zero alerts; pg_blocking_pids confirms the second upsert blocks. Cases cover same event, later same-side event, older event, and forced rollback after alert insertion. Commit produces one durable alert; later same-side advancement is STAY, older is stale. Forced rollback removes both writes and releases the lock; the same-event contender advances safely and produces exactly one alert. These test the service transaction directly; the existing integration suite additionally exercises authenticated HTTP ingestion.

Existing forced CHECK failure proves insertion failure rolls advancement back and HTTP retry succeeds. The new post-insert rollback proves an alert cannot survive rollback of its transition. No arbitrary sleeps were added, no automatic retries or queue infrastructure introduced. These are bounded controlled schedules, not proof of every possible multi-geofence contention schedule.

## Schema and migration results

All eight migrations applied from scratch on the guarded tmpfs PostGIS 16/3.4 Docker stack, isolated from the development database. Actual catalog tests cover exact index identity/order, three composite foreign keys with ON DELETE/UPDATE CASCADE, required provenance, timestamptz(3), allowed labels, legacy nullability, table/column scope, and generated spatial columns. Defaults remain CUID/application identity generation, existing MEDIUM/OPEN and bookkeeping timestamps; no provenance backfill defaults were invented.

Prisma migrate diff returned exactly the two expected centerPoint/observedPoint NOT NULL/generated-expression representations, no additional drift. The identical expectedDrift assertion is present in the locked baseline script, and the relevant generated expressions and NOT NULL definitions originate in GF-3/GF-4 migrations unchanged by GF-7. No drift repair SQL was applied.

## Commands and exact results

| Command/check | Result |
| --- | --- |
| Mandatory Git preflight plus git show -s --format=%P HEAD | Pass; clean, exact ancestry, 0 behind/1 ahead |
| git diff --stat / --name-status / --numstat baseline..implementation | 28 files, +4080/-151 |
| git diff --check baseline..implementation | Exit 0 |
| npm test -- --runInBand | Exit 0; 18 suites, 437 pass, 0 fail, 0 skip |
| npm test -- --runInBand geofence-transition.service.spec.ts geofence-alert.policy.spec.ts geofence-alert.service.spec.ts | Exit 0; 3 suites, 67 pass, 0 fail, 0 skip (subset of 437) |
| npm run test:e2e -- --runInBand | Exit 0; 1 suite, 1 pass, 0 fail, 0 skip |
| npm run lint | Final exit 0 |
| npm run build | Exit 0 |
| npm run prisma:validate | Exit 0 |
| npx tsc --noEmit | Final exit 1; exactly 2 pre-existing TS2345 errors in auth.http.spec.ts |
| npm run test:db (original implementation tests) | Exit 0; 9 suites, 315 pass, 0 fail, 0 skip |
| npm run test:db (expanded tests, final) | Passed; 9 suites, 322 pass, 0 fail, 0 skip; includes GF-6 54 and GF-7 59 |
| Nonempty legacy migration probe using pg Client and rollback-only schema | Expected SQLSTATE 23502; probe rolled back |
| git diff --check (hardening) | Exit 0 |

The database runner invokes prisma migrate deploy, prisma generate, prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script, and npx jest --config ./test/jest-integration.json --runInBand. This is the canonical integration command; no unsafe test run against an unspecified DATABASE_URL was attempted. Final database log is at the session TEMP path gf7-audit-db.log. The runner removed its disposable container/network afterward.

Initial sandbox Docker access failed before any test ran; approved escalation resolved it. One intermediate expanded run had 318 pass/4 fail because new LocationEvent fixtures omitted required accuracyMeters; fixed to 5 and final run passed all 322. Intermediate lint found one unnecessary non-null assertion in a new test; removed and lint passed. Initial no-emit had the GF-7 response-type error plus the two baseline auth errors; an intermediate check also caught the new fixture omissions. None of these intermediate results are represented as passes.

## Bounded hardening and final Git record

Changes are documentation/source-comment corrections, the GF-7 test response type, seven regression cases, updated test counts, and this audit artifact. Application statements, stale policy, unique key, schema fields and migration executable SQL are unchanged. No new dependency, endpoint, delivery or unrelated cleanup was added. Proposed diff was reviewed before committing.

The report is included in the single local commit named fix: harden GF-7 alert event guarantees, directly after b37143edda4a29741fc2c5d1bc2dc8e9eddf2ba9. Its SHA is reported in the final response (embedding a commit's own SHA in its content is not possible). Final repository state, verified after committing: clean status, the same branch, baseline origin/main, 0 behind/2 ahead and whitespace-clean diff. Final checks: git status --short; git branch --show-current; git rev-parse HEAD; git log --oneline --decorate -8; git rev-list --left-right --count origin/main...HEAD; git diff --check origin/main...HEAD; git diff --stat origin/main...HEAD; git diff --name-status origin/main...HEAD. The final SHA is reported with the commit in the final response.

Nothing was pushed, PR'd, merged, deployed, rebased, amended or history-rewritten. Remaining limitations: pre-existing no-emit failures; unknown live migration contents; original migration checksum changes from comment corrections; event creation outside the transition transaction; stale-history loss after supersession; database constraints do not independently prove spatial or complete provenance semantics; mutation claims without a committed harness were not independently reproduced.
