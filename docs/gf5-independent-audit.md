# GF-5 independent audit

## 1. Verdict

**PASS WITH CAVEAT — HARDENED**

Audit date: 2026-09-09. Delivery mode: merge-gate. Brit/devdevbuilds remains final merge authority. The locked implementation was independently inspected and exercised. No runtime spatial or authorization defect was found. A defective radius-cap regression assertion, inaccurate rounding claims, and GF-5 table formatting were corrected. Additional real-database regressions protect fixed boundaries, maximum-radius behavior, serialization, ordering, and forged principal inputs.

The authoritative `ST_Distance <= radiusMeters` predicate and 5,001-meter `ST_DWithin` prefilter are accepted. Runtime SQL, dependencies, migrations, and ingestion behavior are unchanged. The prior unexplained unit failure remains an unreproduced caveat; repository-wide Prettier failures are inherited and are not exclusively CRLF.

## 2. Repository proof

- Canonical work directory: `C:\Users\britb\Documents\geofence-alert-api`.
- Origin: `https://github.com/britbufkin1225-web/geofence-alert-api.git`.
- Branch: `phase-gf-5-deterministic-point-in-circle-evaluation`.
- Locked baseline: `2cff4b6be8196593ba971e53d366b2c78eb9f8a3`.
- Original implementation and initial HEAD: `7df5e6e70adb9d15f8d8b5d265b7ad63fa745f22`.
- Initial working tree: clean; initial divergence from origin/main: 0 behind / 1 ahead.
- Successful `git fetch --prune origin` before edits and again before committing. Fetched origin/main and merge base remain exactly the locked baseline.
- `git cat-file -t` confirmed the original object is a commit; its identity and ancestry remain preserved. The initial baseline-to-HEAD log contained exactly the original implementation.
- `git ls-remote --heads origin` returned only main at the baseline. `git branch -r --contains` the original returned no branch. No GF-5 commit is present in the current advertised remote branch history; this does not purport to prove whether an inaccessible/deleted historical ref ever existed.
- Exactly one separate audit commit is intended: `fix: harden deterministic geofence evaluation`. Its identity is the commit containing this report, recoverable with `git log -1 --format=%H -- docs/gf5-independent-audit.md`. A commit cannot embed its own literal SHA; the final delivery supplies the literal SHA after committing.
- Final expected graph: baseline -> unchanged original -> report-containing audit commit; 0 behind / 2 ahead of origin/main. Final post-commit status and hashes are verified in the delivery response. The report and four narrowly scoped changes are the only staged files.
- No push, PR creation/modification, merge, deploy, amend, rebase, squash, reset of Git history, or history rewriting was performed. The database reset below is explicitly disposable and is not a Git reset.

GF-3's committed audit report and GF-4's committed audit additions establish the precedent for including evidence with a justified hardening commit. This is not an audit-only documentation commit: the radius-cap regression was concretely inadequate.

## 3. Findings and dispositions

| Severity | Original evidence                                                                                                                                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | `test/integration/geofence-evaluation.integration-spec.ts:942` used `definition.toContain(String(GEOFENCE_RADIUS_MAX_METERS))`. The definition for a 15,000-meter cap contains `5000`, so a future enlarged cap could pass while valid distant matches were prefiltered away. The catalog search also lacked a relation qualification and validation-state assertion. | Pin the entire catalog definition on the actual Geofence relation, require `convalidated = true`, and exercise rejection of maximum + 0.001 meters. Final assertion is near line 1023. The audit SQL independently returned true for the old assertion applied to a 15,000 cap. |
| Low      | DTO `geofence-evaluation-response.dto.ts:41` promised rounded distance always <= radius. The original query comments also implied the response could not contradict the radius.                                                                                                                                                                                       | Correct the comments and API documentation. Real HTTP/database regression proves distances 100.0006 and 100.0007 can both display 100.001 against radius 100.0008 while being correctly inside. Preserve rounding and raw ordering.                                             |
| Low      | Query comments treated ST_DWithin as universally stricter and justified its margin mainly from a 250-meter fixture.                                                                                                                                                                                                                                                   | Replace that account with the Point/Point source-level argument below and protect fixed boundaries and maximum radii at five locations. No predicate change is needed.                                                                                                          |
| Low      | The new GF-5 table in `docs/api.md:123` added non-EOL Prettier differences.                                                                                                                                                                                                                                                                                           | Format only the GF-5 section, leaving inherited formatting elsewhere intact.                                                                                                                                                                                                    |

No unresolved production finding remains. The existing negative-target integration run also emits secondary teardown TypeErrors because its afterEach accesses uninitialized Prisma after beforeAll refuses the target. That is diagnostic noise in the deliberately refused run; it neither connects nor weakens the guard, and is recorded rather than expanded into cleanup refactoring.

## 4. Spatial investigation and predicate decision

### Exact statement and types

The entire production statement is in `src/location-events/geofence-containment.query.ts:96`. Prisma binds, in order: authenticated tenant, constant 5001 cast to double precision, event ID, authenticated tenant. No request text becomes an identifier or SQL fragment. Both spatial operands come from stored generated columns; event and geofence tenant predicates are directly in SQL, with `isActive = TRUE`.

Database catalogs independently confirmed non-null stored generated `geography(Point,4326)` columns. Their expression is `(st_setsrid(st_makepoint(longitude, latitude), 4326))::geography`. Longitude is X everywhere. The selected overloads are `st_distance(geography,geography,boolean DEFAULT true)` and `st_dwithin(geography,geography,double precision,boolean DEFAULT true)`. Both default to the spheroid; units are meters. Geometry casts in the fixture only extract coordinates from projected points, never decide containment. These signatures agree with the [official ST_DWithin documentation](https://postgis.net/docs/ST_DWithin.html).

### Reproduced boundary

Austin center (-97.7431 longitude, 30.2672 latitude), projected east 250 meters:

| Measurement                            |             Result |
| -------------------------------------- | -----------------: |
| `ST_Distance(a,b)`                     |                250 |
| `_ST_DistanceUnCached(a,b,0,true)`     | 250.00000000049803 |
| `ST_DWithin(a,b,ST_Distance(a,b))`     |              false |
| `ST_Distance(a,b) <= ST_Distance(a,b)` |               true |
| `ST_DWithin(a,b,5001)`                 |               true |
| `ST_Distance(a,b,false)`               |       249.50815832 |

The discrepancy is internal distance rounding, not degrees, swapped coordinates, a radius cast, or accidentally selecting sphere mode. The forward projection and binary coordinate representation explain why the underlying result is slightly above 250. They do not justify treating the measured public distance as greater than 250.

Exact release source was downloaded from the PostGIS 3.4.3 tag into ignored audit scratch space. `geography_distance` rounds at 10 nm with PROJ_GEODESIC (100 nm otherwise); `geography_dwithin` can compare the unrounded result. Rounding can move in either direction, so neither predicate is universally stricter. See [geography_measurement.c, lines 43–48, 235–250, 263–315](https://github.com/postgis/postgis/blob/3.4.3/postgis/geography_measurement.c).

Decision: accept boundary inclusion in terms of the documented PostGIS measurement, `ST_Distance <= radius`. This is a floating-point measurement contract, not a claim of infinitely precise physical geometry. The selected raw distance and predicate use the same function and operands; application millimeter rounding occurs afterward and can legitimately cross the displayed radius. Changing to ST_DWithin as the decision would reproduce the measured boundary exclusion.

### Prefilter safety argument

The validated database constraint is exactly `CHECK (("radiusMeters" <= (5000)::double precision))`, from `prisma/migrations/20260908102400_geofence_spatial_constraints/migration.sql:85`. The lower bound is 1 meter, and generated Point coordinates are range constrained. The application cap is exactly 5000; it is a static constant, not a runtime environment override. The new complete-definition assertion fails if either the migration cap or application cap changes independently. A maximum + 0.001 insert is rejected by the database.

For two points, PostGIS bypasses the geometry cache, so changing cached shapes cannot produce a different distance path. See [geography_measurement_trees.c, lines 157–175 and 286–317](https://github.com/postgis/postgis/blob/3.4.3/postgis/geography_measurement_trees.c).

In the Point/Point ST_DWithin fallback, a spherical estimate below 95% of the tolerance returns early and therefore accepts. Otherwise it calls spheroid_distance. That shortcut cannot reject a candidate, even where spherical and spheroidal distances differ substantially. See [lwgeodetic.c, lines 1756–1790](https://github.com/postgis/postgis/blob/3.4.3/liblwgeom/lwgeodetic.c).

The standard distance tree ultimately calls the same spheroid_distance for the point pair before its wrapper rounds. See [lwgeodetic_tree.c, lines 608–630](https://github.com/postgis/postgis/blob/3.4.3/liblwgeom/lwgeodetic_tree.c). Consequently, if public distance <= 5000, the unrounded comparison is within the internal rounding quantum plus floating-point conversion noise, far below 0.000001 meter at this scale. It is less than 5001. This argument is independent of latitude and longitude and is specific to the constrained Point type and inspected PostGIS release. It is not an unsupported assumption that sphere/spheroid differences are under one meter.

The native ST_DWithin GiST condition is retained with its own geography bounding-box support, rather than manually inventing a planar box. Exact-query EXPLAIN demonstrates that path. Upstream PostGIS numerical/type changes should be re-audited; the source proof is version-specific.

### Independent numerical coverage

The deterministic grid examined 41,440 pairs: integer latitudes -90 through 90 plus -89.9995, 89.9995, Austin and Oslo latitude; four longitudes including both sides of the antimeridian; eight bearings at 45-degree steps; radii 1, 250, 4749, 4999, 4999.999, 5000 and 5000.001.

- Valid matches lost by the 5001 prefilter: **0**.
- Maximum absolute public/raw spheroid difference: **4.383764462545514e-9 m**.
- Maximum absolute sphere/spheroid difference: **28.07180064000022 m**.
- Cases where ST_DWithin at public distance was false: **20,915**.

The grid corroborates, rather than substitutes for, the source argument. Real API tests independently project forward at equator, Austin, Oslo, antimeridian adjacency, and near-pole coordinates with fixed radii 250 and 5000. Distances tested are 0, 120, 249.999, 250, 250.001, 4999.999, 5000, 5000.001. All expected memberships pass. The fixed-boundary tests do not derive their radii or expected answers from the production distance expression. The original radius-assigned-from-distance identity test remains useful for exact equality but is no longer the sole boundary premise.

### Index evidence

`containmentStatement` itself, including all four bound values, was supplied to EXPLAIN ANALYZE with 10,000 additional geofences in a transaction that was rolled back. No planner index-forcing setting was used. The statement produced:

```text
Index Scan using Geofence_centerPoint_gist_idx
Index Cond: (centerPoint && _st_expand(event.observedPoint, 5001))
Filter: isActive AND tenant predicate AND st_dwithin(...) AND st_distance(...) <= radiusMeters
Sort Key: st_distance(..., true), geofence.id
Planning Time: 0.536 ms
Execution Time: 0.096 ms
```

This sparse 10,000-row probe returned zero candidates; it proves the access path, not throughput for dense result sets. The committed integration plan test also passes with 200 fixtures using the exact production statement. No claim is made that every data distribution must cause the planner to choose GiST.

## 5. Security and deterministic contract

- `src/auth/auth.module.ts:40` installs the global JWT guard. It verifies signature, pinned algorithm, expiry and the membership/user/tenant tuple before replacing request.principal. Evaluation has no Public decorator. Anonymous, malformed, expired and revoked-membership requests are rejected.
- `location-events.controller.ts:68` exposes the canonical prefixed GET route. It binds only a validated path ID and CurrentUser. Body, query, custom tenant headers and serialized principals cannot replace the verified principal. A new real-database HTTP test submits all three forgery channels together and gets exactly the ordinary tenant-scoped response.
- `geofence-evaluation.service.ts:53` resolves the event with both ID and authenticated tenant in the database predicate. SQL independently repeats that scope and filters active same-tenant geofences. Coincident foreign and inactive own geofences are excluded.
- Missing and foreign event IDs follow the same 404 policy. Errors echo only the supplied ID/path and a request-time error timestamp, as on existing routes. They are semantically indistinguishable after normalizing those client-supplied values; they are not claimed byte-identical across different paths/times.
- Real Nest HTTP tests and the global exception filter prove unexpected lookup/SQL failures return generic 500 messages, without server SQL, schema, database paths, stack traces or foreign identifiers. Expected test-injected errors are logged server-side; those logs are not response leakage.
- Unknown query fields are ignored on routes with no query DTO, matching existing get-by-ID behavior. Global whitelist/reject settings apply to bound DTOs; they do not globally reject every unbound query string. Malformed CUIDs get 400. The optional String constructor dependency on ParseCuidPipe safely uses its geofence default under Nest, verified by the existing geofence HTTP route and complete suite.
- Response mapping explicitly selects seven top-level fields and six match fields; no raw geography or internal tenant data escapes. observedAt is the stored instant serialized as ISO UTC; no evaluation clock, UUID or randomness enters a successful payload. matchCount is derived from matches.length. No matches is 200 with an empty array and zero count.
- ORDER BY uses numeric raw distance followed by unique text geofence ID. The verified database uses deterministic en_US.utf8 collation; unique primary-key IDs and deterministic text comparison give a total tie-break order. No nondeterministic collation was introduced. Equivalent unchanged-state requests are byte-identical in the real HTTP suite. Collation migration is an environmental change and should be reviewed, not assumed to preserve every lexical ordering across servers.
- Output numbers have at most three decimal places and omit trailing zeros. Raw-distance sorting survives presentation rounding. The new test deliberately uses reverse ID order for two distinct distances that both display 100.001; the nearer circle remains first.
- Call graph: controller -> evaluation service -> event SELECT and containment SELECT; the guard separately reads membership. No write path is called. Read-only tests compare all table row counts plus complete event/geofence values and zero alerts across repeated requests. Code inspection complements those counts, which alone could not detect arbitrary updates elsewhere.

## 6. Validation and test assessment

Environment: Node 22.23.2, npm 10.9.8, Prisma Client 7.8.0, Docker server 29.7.2. Disposable identity: local desktop-linux named-pipe engine, Compose project geofence-gf3-disposable-test, container geofence-gf3-disposable-postgis, image postgis/postgis:16-3.4, database geofence_gf3_disposable, loopback port 55433, tmpfs PGDATA, expected labels and healthy state. Credentials are intentionally omitted here. Actual engine: PostgreSQL 16.4, PostGIS 3.4.3, GEOS 3.9.0, PROJ 7.2.1.

| Command / operation                                                                                                                                                  | Outcome                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------- |
| `git remote -v`; `git branch --show-current`; `git status --porcelain=v1`; revision, cat-file, merge-base and baseline-to-HEAD log checks                            | Exact preflight passed before edits                                                                                                   |
| `git fetch --prune origin`; `git ls-remote --heads origin`; `git branch -r --contains 7df5e6e70adb9d15f8d8b5d265b7ad63fa745f22`                                      | Passed with escalation; only remote main at locked baseline                                                                           |
| `npm ci --dry-run`                                                                                                                                                   | Exit 0; no lockfile change                                                                                                            |
| `npm run lint`                                                                                                                                                       | Original, hardened and final all exit 0                                                                                               |
| `npm run build`                                                                                                                                                      | Original, hardened and final all exit 0                                                                                               |
| `npx prettier --check .` in baseline snapshot and audited worktree                                                                                                   | Expected exit 1; baseline 104 files, worktree 111 inherited failures before report; comparison below                                  |
| `npm run prisma:validate`                                                                                                                                            | Exit 0                                                                                                                                |
| `npm run prisma:generate`, then only after exit `npm test -- --runInBand`, three repetitions                                                                         | Each generate exits 0; each unit run 348/348, 15 suites                                                                               |
| `npm test`, three further canonical repetitions                                                                                                                      | Each 348/348, 15 suites; normal worker execution                                                                                      |
| `npm test -- --runInBand --runTestsByPath src/location-events/geofence-evaluation.service.spec.ts`                                                                   | 22/22                                                                                                                                 |
| Same focused command for `src/location-events/geofence-evaluation.http.spec.ts`                                                                                      | 29/29                                                                                                                                 |
| Hardened focused command with both paths                                                                                                                             | 51/51                                                                                                                                 |
| `npm test -- --runInBand --detectOpenHandles` after hardening                                                                                                        | 348/348; no open-handle finding                                                                                                       |
| `npm test` after hardening                                                                                                                                           | 348/348                                                                                                                               |
| `npm run test:e2e -- --runInBand`, original and hardened                                                                                                             | 1/1 each                                                                                                                              |
| `npm run test:db -- --keep`, original                                                                                                                                | 202/202 across seven suites; cold deploy, generate and exact drift assertion pass                                                     |
| `npx jest --config test/jest-integration.json --runInBand --runTestsByPath test/integration/geofence-evaluation.integration-spec.ts`, guarded disposable environment | 38/38 after initial six regressions; final suite contains 39 including real principal forgery                                         |
| Guarded `npx prisma migrate status`                                                                                                                                  | Six migrations, up to date                                                                                                            |
| Guarded `npx prisma migrate reset --force`                                                                                                                           | Exit 0; six migrations applied on disposable database only                                                                            |
| Guarded `npx prisma migrate status` after reset                                                                                                                      | Up to date                                                                                                                            |
| Guarded `npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script`                                                                 | Only exact known generated-column differences for Geofence and LocationEvent                                                          |
| `node tmp/gf5-audit/probe.cjs`                                                                                                                                       | Catalog, overload, 41,440-pair grid, five-location matrix and exact-query EXPLAIN evidence captured                                   |
| `npm run test:db`, final                                                                                                                                             | **209/209**, seven suites, including **39 GF-5** cases; clean deploy, generate, drift assertion and cleanup pass                      |
| Focused real integration command with deliberately unsafe synthetic DATABASE_URL                                                                                     | Expected exit 1; complete-identity guard refuses in beforeAll before database connection                                              |
| Full unit suite includes disposable identity guard regressions                                                                                                       | 25 guard tests pass, including rejection before Docker calls                                                                          |
| `git diff --check` for locked range and audit changes                                                                                                                | Both pass                                                                                                                             |
| `git grep -n -E '^(<<<<<<<                                                                                                                                           | =======                                                                                                                               | >>>>>>> )'` | No tracked conflict markers |
| Diff secret scan plus contextual review                                                                                                                              | No private key/token patterns or real secret found; original 58 and audit 5 sensitive-word lines are fixture/auth-contract references |
| Final Docker project-container query                                                                                                                                 | Empty after successful verified teardown; test network removed                                                                        |

The original implementation counts 348 unit/HTTP and 202 integration tests were reproduced independently. Final aggregate is 348 unit/HTTP + 1 e2e + 209 integration = **558 tests** per complete combined validation. Repetitions are not added to that unique count.

Prisma drift consists solely of SET NOT NULL / SET DEFAULT suggestions for the two generated geography columns. The canonical runner compares the complete expected SQL rather than filtering arbitrary changes. Prisma still cannot fully model generated columns and CHECK semantics; catalog and behavioral tests remain essential. No migration file changed.

The six original-unit repetitions contain no concurrent client generation; the runner uses spawnSync, and package scripts contain no background generator. The three sequential run durations were 6.503, 6.556 and 6.631 seconds; canonical runs were 4.137, 4.310 and 4.288 seconds. No failure recurred, no worker crash or open handle was found, and there is no evidence to attribute the earlier 1/348 failure to concurrent rewriting. Unit fixtures mock Prisma, integration tests are serialized, HTTP apps close, and suite mocks are reset. Existing wall-clock validation tests use buffers or mocked Date.now; GF-5 success fixtures use fixed observedAt values. Retain the original unexplained failure as a caveat.

The original 1,003-line integration suite centralizes registration, event/geofence creation, projection, radius pinning, measurement, row counts and cleanup helpers. The new cases reuse those helpers and do not duplicate bootstrap. Its one-statement test checks result cardinality rather than instrumenting query count; the one-statement property is established directly by the query call graph, not that test alone. Original exact-boundary identity tests are supplemented with independent fixed-radius projection cases. Snapshot files were removed before final full discovery; the final seven-suite count excludes all scratch copies.

Formatting was checked against an isolated repository-local baseline reconstructed from Git blobs with core.autocrlf=true checkout line endings; HEAD/branch/history were never switched. `node tmp/gf5-audit/format.cjs` separately compared tracked files before and after LF normalization. Baseline: 104 failures, 86 EOL-only and 18 content-format failures. Original GF-5: 111 failures, 93 EOL-only and the same 18 content-format filenames. They include inherited Markdown tables/fences, Compose/config formatting and prisma.config.ts. Thus “exclusively CRLF” is false. All GF-5 TypeScript passes ESLint's authoritative prettier/prettier endOfLine:auto rule. Only the newly added GF-5 API section was formatted; inherited sections were preserved. The audit report is separately Prettier-formatted and checked with LF. The baseline snapshot is no longer present to pollute Jest discovery.

Audit tooling failures were not counted as passes: initial sandbox fetch denial was resolved by approved escalation; an unprivileged ls-remote credential error was resolved by escalation; probe-only SQL first used a removed lc_collate setting, then a duplicate alias, then omitted required accuracyMeters. Those were corrected before the successful probe, and the transaction rolled back on disconnect. One approval attempt was rejected when credits ran out; the user explicitly reset credits and authorized continuation. No test or production failure was concealed.

## 7. Scope and exact changed-file accounting

Original locked diff: **12 files, 2,193 insertions, 8 deletions**.

| Original file                                               |    + |   - | Classification                                                                          |
| ----------------------------------------------------------- | ---: | --: | --------------------------------------------------------------------------------------- |
| docs/api.md                                                 |   59 |   1 | Supporting public contract; rounding explanation and new-table formatting hardened      |
| docs/project-status.md                                      |   15 |   2 | Supporting local phase status; no runtime behavior                                      |
| src/common/pipes/parse-cuid.pipe.ts                         |   22 |   2 | Required shared resource label; optional DI default preserves geofence wording          |
| src/location-events/dto/geofence-evaluation-response.dto.ts |   72 |   0 | Required public shape; inaccurate rounded-radius comment corrected                      |
| src/location-events/dto/geofence-evaluation.constants.ts    |   20 |   0 | Required presentation precision                                                         |
| src/location-events/geofence-containment.query.ts           |  143 |   0 | Required parameterized spatial statement; source-backed rationale corrected             |
| src/location-events/geofence-evaluation.http.spec.ts        |  432 |   0 | Required routing/auth/error contract coverage with mocked database boundary             |
| src/location-events/geofence-evaluation.service.spec.ts     |  274 |   0 | Required orchestration/mapping/rounding tests                                           |
| src/location-events/geofence-evaluation.service.ts          |  106 |   0 | Required tenant-scoped read orchestration                                               |
| src/location-events/location-events.controller.ts           |   39 |   2 | Required canonical GET route and existing ingestion preserved                           |
| src/location-events/location-events.module.ts               |    8 |   1 | Required provider wiring                                                                |
| test/integration/geofence-evaluation.integration-spec.ts    | 1003 |   0 | Required real spatial/security proof; cap assertion and concrete coverage gaps hardened |

Audit-only diff against original:

| File                                                        |   + |   - | Purpose                                                                                                                 |
| ----------------------------------------------------------- | --: | --: | ----------------------------------------------------------------------------------------------------------------------- |
| docs/api.md                                                 |   9 |   6 | Explicit raw ordering/display rounding and GF-5 table formatting                                                        |
| src/location-events/dto/geofence-evaluation-response.dto.ts |   3 |   2 | Correct display-distance guarantee                                                                                      |
| src/location-events/geofence-containment.query.ts           |  18 |  18 | Correct numerical explanation; executable SQL unchanged                                                                 |
| test/integration/geofence-evaluation.integration-spec.ts    | 115 |   4 | Exact validated cap, behavioral cap rejection, five location matrices, rounding/order and principal-forgery regressions |
| docs/gf5-independent-audit.md                               | 210 |   0 | This evidence report                                                                                                    |

Audit totals: **355 insertions, 30 deletions across five files**. The combined baseline-to-final totals are recorded by final Git numstat in the delivery; they are recomputed rather than adding overlapping diffs mechanically. Ignored scratch logs/source/probe scripts remain under tmp/gf5-audit for local inspection and are not committed.

The whole locked diff and relevant auth/ingestion/evaluation call graph were inspected. No domain writes, persisted evaluations, prior-event comparison, enter/exit/dwell state, alerts, delivery, audit-domain rows, queues, workers, schedulers, webhooks, frontend, auth redesign, dependencies or migrations were introduced. Ingestion does not call evaluation. Future features remain deferred.

## 8. Caveats and deferred work

1. The historical 1/348 unit failure remains unexplained and unreproduced after six original and two hardened full-unit runs. No invented root cause is asserted.
2. Repository-wide prettier --check fails at baseline and final state; 18 inherited failures are not purely CRLF. Authoritative lint passes and GF-5-specific additions were checked.
3. Known generated-column Prisma drift remains explicit and exactly asserted; schema/catalog verification supplements Prisma.
4. Numerical proof applies to the inspected Point geography/PostGIS 3.4.3 environment. Re-audit deliberate type/engine changes. The finite grid is corroboration, not an exhaustive proof of real-number arithmetic.
5. The deliberate unsafe-target test produces secondary cleanup noise after its successful refusal, without connecting. The sparse EXPLAIN is access-path evidence, not a load benchmark.

Transitions, enter/exit/dwell, persisted evaluation results, alerts and delivery remain deferred.

## 9. Merge recommendation

Recommend pushing and reviewing, under Brit/devdevbuilds' authority, the two-commit range from `2cff4b6be8196593ba971e53d366b2c78eb9f8a3` through the single report-containing audit commit. Preserve original `7df5e6e70adb9d15f8d8b5d265b7ad63fa745f22` unchanged. The final response records the exact terminal SHA. No push or merge was performed by this audit.
