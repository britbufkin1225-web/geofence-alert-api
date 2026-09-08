# GF-3 Independent Audit

## PASS WITH CAVEAT — HARDENED

Audit date: 2026-09-08. Scope: PostgreSQL/PostGIS spatial foundation only.

- Locked baseline / fetched origin/main / merge base: `fdd6680620041f94c847f252f3152229f4c17715`.
- Original implementation: `de5acdf32bab65e9eb9ea33e1dda277f7bdad68b` (preserved unchanged).
- Branch: `phase-gf-3-postgresql-postgis-spatial-foundation`.
- Starting tree clean; starting divergence 0 behind / 1 ahead.
- Docker 29.7.2 Client/Server, Compose 5.5.1, desktop-linux, Linux/WSL2 were accepted by the user after the initial version gate stopped the audit.
- One separate hardening commit is authorized. No push, PR, merge, amendment, branch deletion or global Git change was performed.

## Findings and dispositions

| Severity | Affected file(s) | Direct evidence and consequence | Disposition |
| --- | --- | --- | --- |
| High | `test/integration/support/database.ts`, `scripts/disposable-db-test.mjs` | Original guard compared only pathname to `geofence_gf3_disposable`. A production host with that exact database name passed; destructive TRUNCATE could follow. Port interpolation and cleanup lacked complete Docker identity proof. | Exact URL validation before connection, local named-pipe Docker context, project/service/name/image/credentials/port/PGDATA/tmpfs/health inspection, checked cleanup, no orphan removal, validated and explicitly propagated high test port. 25 guard regressions pass. |
| Medium | `prisma/migrations/20260908102400_geofence_spatial_constraints/migration.sql` | CHECK was radius > 0, while the unchanged DTO constant and @Min require >= 1. The old SQL permits 0.5. Product-policy rationale was inconsistent with the already mirrored 5000 maximum. | New additive audit migration enforces >= 1. Raw SQL rejects 0.5 and accepts 1. Original migration files remain unchanged. |
| Medium | Same migration | `btrim(text)` removes ASCII space, unlike JavaScript trim. Tab/newline and NBSP/BOM-only names passed the original SQL checks despite DTO rejection. | Additive migration uses the explicit ECMAScript whitespace character set for required names and surrounding email whitespace; raw SQL regressions pass. No new length or business limits. |
| Medium | `Dockerfile`, missing `.dockerignore` | `COPY . .` included ignored local .env/dev.db and host node_modules in the Docker context. Git ignore does not exclude Docker build input. | Added .dockerignore. Actual image build passes; network-isolated image inspection confirms no local .env/dev.db and a loadable generated Prisma Client. |
| Medium | `docker-compose.yml` | Raw password interpolation creates an invalid URL for a synthetic password containing `#` (`ERR_INVALID_URL`). | Compose supplies raw credentials to `scripts/start-compose.mjs`, which encodes each URL component and starts the API at postgres:5432. Reserved-character startup and Compose configuration checks pass. |
| Medium | `docs/database-schema.md`, disposable runner | The documented SQL is schema-to-database drift. The reverse direction proposes DROP NOT NULL/DROP DEFAULT. Unqualified instruction to delete “that statement” was misleading and could hide other changes. | Both exact directions documented; runner now requires exact known schema-to-database SQL, never a broad exclusion. Retained generated column for reasons below. |
| Low | Integration structure/spatial/tenant tests | Latitude-only test asserted only SRID; GiST validity/readiness and successful own-tenant PATCH/DELETE were not asserted. Null scalar-write behavior lacked coverage. | Strengthened existing assertions and added direct null-write plus own-tenant CRUD/active-filter tests. |
| Caveat | `package-lock.json` | Required npm install/audit reports 18 vulnerabilities: 12 high, 4 moderate, 2 low. All 18 affected package versions are identical to GF-2 baseline. | Recorded as inherited dependency debt; no broad or forced dependency updates during GF-3. This is not a finding that the dependencies are safe. |
| Caveat | `docs/testing.md` | No committed CI workflow exists; npm test alone excludes real database tests. | Required pre-push validation explicitly includes test:db. A future CI must run every layer. The hardened Docker guard currently targets Windows Docker Desktop; remote/Linux CI needs an equally strict local-engine adaptation. |

## Review of all 30 original changed files

R = required for GF-3; S = justified supporting change; H = risky/requiring hardening. No unrelated runtime feature was found.

| Original changed file | Classification and rationale |
| --- | --- |
| `.env.example` | S — PostgreSQL configuration and test fixture documentation |
| `Dockerfile` | S/H — client generation required; context exclusion missing |
| `README.md` | S — truthful provider, setup and scope documentation; counts updated |
| `docker-compose.test.yml` | R — isolated PostGIS/tmpfs fixture |
| `docker-compose.yml` | R/H — PostGIS, persistence and health dependency; raw URL encoding fixed |
| `docs/database-schema.md` | S/H — schema/reset documentation; drift direction and radius corrected |
| `docs/environment-variables.md` | S — required PostgreSQL settings; encoding/port clarification |
| `docs/project-status.md` | S — phase status and test results |
| `docs/testing.md` | S/H — database suite instructions; guard and required validation clarified |
| `package-lock.json` | R/S — PostgreSQL adapter dependency graph, dotenv, npm metadata churn |
| `package.json` | R — provider dependency and Prisma/database scripts |
| `prisma/migrations/20260602200706_init/migration.sql` (deleted) | R — obsolete SQLite dialect |
| `prisma/migrations/20260805193807_add_identity_tenant_ownership/migration.sql` (deleted) | R — obsolete SQLite rebuild/backfill |
| `prisma/migrations/20260908102300_enable_postgis/migration.sql` | R — extension precedes geography |
| `prisma/migrations/20260908102319_init_postgresql_baseline/migration.sql` | R — PostgreSQL reconstruction of GF-2 structure |
| `prisma/migrations/20260908102400_geofence_spatial_constraints/migration.sql` | R/H — generated geography/index/checks; radius/whitespace fixed additively |
| `prisma/migrations/migration_lock.toml` | R — provider switch |
| `prisma/schema.prisma` | R — provider, native lengths, Unsupported geography and GiST |
| `scripts/disposable-db-test.mjs` | R/H — disposable lifecycle; hardened identity, cleanup and drift checks |
| `src/app.service.ts` | S — status reports actual provider |
| `src/auth/migration.spec.ts` (deleted) | R — obsolete SQLite legacy-backfill test; live ownership assertions retained elsewhere |
| `src/config/env.validation.ts` | R — required PostgreSQL URL, no SQLite fallback |
| `src/prisma/prisma.service.ts` | R — PostgreSQL adapter and fail-closed missing URL |
| `test/integration/database-constraints.integration-spec.ts` | R/H — actual constraints; missing minimum/whitespace regressions added |
| `test/integration/database-structure.integration-spec.ts` | R/H — catalogs/migrations; GiST validity/readiness strengthened |
| `test/integration/spatial-sync.integration-spec.ts` | R/H — generated synchronization; latitude-only/null proof strengthened |
| `test/integration/support/database.ts` | R/H — originally insufficient destructive-operation guard |
| `src/auth/tenant-isolation.spec.ts` → `test/integration/tenant-isolation.integration-spec.ts` | R/H — all old assertions preserved, anonymous cases added; same-tenant mutation proof added by audit |
| `test/jest-integration.json` | R — separate required real-database suite |
| `test/jest-setup-env.ts` | S — mock-only database placeholder; no live fallback |

Original totals independently verified: **30 files, 2170 insertions, 521 deletions**. Lockfile metadata churn is supporting package-manager output, not a new product feature.

## Migration reset and structural comparison

Acceptable for this pre-production provider switch. Both old migrations were executed in an in-memory SQLite database using Node's SQLite engine. The first uses DATETIME (not a PostgreSQL type); the second uses SQLite PRAGMA and table-rebuild syntax. REAL itself is valid PostgreSQL syntax, so the old migration comment's blanket wording is imprecise. The chains as a whole are SQLite-specific.

Compared actual SQLite PRAGMA catalogs against migrated PostgreSQL information_schema/pg_constraint/pg_index catalogs:

| Table | GF-2 columns preserved | Existing indexes preserved | Foreign keys preserved |
| --- | ---: | ---: | ---: |
| User | 5 | 2 | 0 |
| Tenant | 4 | 1 | 0 |
| Membership | 5 | 3 | 2 |
| Geofence | 10 | 2 | 1 |
| AlertEvent | 11 | 1 | 1 |

All 35 old columns and nullability rules survive; centerPoint is the only added column. CUID remains client-generated. Timestamps map to timestamp(3), REAL inputs to double precision, boolean defaults remain true, and createdAt defaults remain CURRENT_TIMESTAMP. Unique email, unique membership pair and both tenant lookup indexes survive. All four foreign keys retain ON UPDATE CASCADE and ON DELETE CASCADE. Geofence tenant ownership remains required. Alert severity LOW/MEDIUM/HIGH/CRITICAL and status OPEN/ACKNOWLEDGED/RESOLVED become actual PostgreSQL enums with the same MEDIUM/OPEN defaults; SQLite stored them as text.

No identity, authentication, membership or ownership policy was changed. The removed legacy-backfill test is obsolete because this is not a data conversion: existing SQLite data is explicitly **not automatically migrated**, and a fresh PostgreSQL database must not invent a legacy owner. Its still-relevant FK/index/required-ownership assertions are covered by PostgreSQL tests.

Repository history and documentation describe a pre-production project; no deployed PostgreSQL migration history or deployment workflow was found. Repository inspection cannot prove the absence of every external deployment. The reset is appropriate on the stated pre-production baseline, not a recipe for resetting an existing production database.

Lexical order and _prisma_migrations were verified on cold deploys: enable_postgis → init_postgresql_baseline → geofence_spatial_constraints → audit_contract_hardening. Every entry finished without rollback. Additionally, a new database inside the verified tmpfs container was created from template0: pg_extension initially contained no postgis; the first migration enabled it; every later migration executed successfully. This avoids relying on the image's pre-enabled extension.

## Spatial and Prisma evidence

Catalog results: geography, Point subtype, SRID 4326, two dimensions, attgenerated = s, attnotnull = true. Complete generated expression:

```sql
(st_setsrid(st_makepoint(longitude, latitude), 4326))::geography
```

Longitude is X, latitude is Y. Insert, latitude-only update, longitude-only update and both-coordinate update produce correct points. Direct non-DEFAULT INSERT/UPDATE of centerPoint fail. Null scalar UPDATE fails and leaves the persisted point unchanged. All checked rows have zero scalar/spatial mismatches. DEFAULT writes remain legal but recompute the derived value.

`Geofence_centerPoint_gist_idx` is a valid, ready, nonunique GiST index on centerPoint; its catalog definition is:

```sql
CREATE INDEX "Geofence_centerPoint_gist_idx" ON public."Geofence" USING gist ("centerPoint")
```

Prisma's optional Unsupported declaration permits ordinary create/update/read operations without exposing or accepting centerPoint. PostgreSQL supplies and requires the value. Client generation, compilation and real API CRUD/list/summary tests pass; no invalid GiST SQL is generated.

Generated synchronization is a sound simpler choice than trigger synchronization here. Ordinary writes cannot bypass it, and no separate INSERT/UPDATE trigger logic is needed. Neither a trigger nor generated column protects against a privileged owner altering the schema; the original “impossible” language should be understood within normal-write scope.

### Exact reproduced drift

`npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script`:

```sql
-- AlterTable
ALTER TABLE "public"."Geofence" ALTER COLUMN "centerPoint" SET NOT NULL,
ALTER COLUMN "centerPoint" SET DEFAULT (st_setsrid(st_makepoint(longitude, latitude), 4326))::geography;
```

Reverse direction:

```sql
-- AlterTable
ALTER TABLE "Geofence" ALTER COLUMN "centerPoint" DROP NOT NULL,
ALTER COLUMN "centerPoint" DROP DEFAULT;
```

Stable on repeated fresh migrations. The runner now checks the entire first output exactly. It cannot silently discard extra modeled changes. Prisma still does not fully compare CHECK definitions/generated semantics: catalog and behavioral tests remain necessary, and this is an explicit caveat rather than a blanket no-drift guarantee.

Tested narrower alternatives: required Unsupported with empty dbgenerated still reports SET DEFAULT; an expression-valued fake default produces an empty diff but its DDL fails with **cannot use column reference in DEFAULT expression**. Hiding the difference this way misrepresents a generated column and weakens reliable schema reproduction. Preserve the design. Future migrations must be created without applying, fully reviewed, and stripped only of the known inappropriate generated-column operations; never automatically drop an entire mixed ALTER TABLE statement.

## Constraints and API contract

Nine CHECK constraints cover geofence latitude [-90,90], longitude [-180,180], radius [1,5000], nonblank geofence/tenant names, canonical surrounding email whitespace, and nullable AlertEvent coordinate ranges. Four bounded columns: email 254, tenant/geofence names 120, description 1000. Required ownership, PK/unique constraints, enums, nullability and cascades were catalog-verified against GF-2 and the DTO/service behavior.

No unrelated password-hash or AlertEvent string bound was invented. Full email syntax and lowercasing remain application responsibilities; SQL uniqueness is exact-string uniqueness, not case-insensitive identity normalization. Normalized duplicate registration returns a safe 409. Locale-dependent SQL lower() was not imposed on JavaScript's accepted identity input.

## Container isolation and secrets

Both Compose files retain postgis/postgis:16-3.4. Actual server: PostgreSQL 16.4, PostGIS 3.4.3, GEOS 3.9.0, PROJ 7.2.1. Prisma CLI/client 7.8.0; locked adapter-pg 7.10.0; Node 22.23.2. No dependency versions were changed by the audit.

Health checks execute SELECT 1 as well as pg_isready. API depends_on service_healthy is retained. Missing POSTGRES_PASSWORD fails Compose interpolation with exit 1; no development password default exists. Synthetic credentials containing reserved URL characters are encoded intact for postgres:5432. The configured host-facing URL is overridden by the Compose startup script.

Tracked secret grep was reviewed contextually: fixture passwords/JWTs, example placeholders and the dummy timing-equalization bcrypt hash are not leaked production credentials. No real committed secret was found. Docker build now excludes local secrets/database artifacts.

The disposable target uses its own project/container/database, loopback high port and tmpfs. Validation rejects deceptive hosts, normal developer port 5432, prefixed database names, capitalization/percent-encoding, fragments, extra query parameters, missing/malformed URLs and overridden identities. A fake production URL was run through the actual tenant suite and failed in beforeAll before application creation. Guard unit tests also prove rejected URLs never call Docker, much less PostgreSQL.

Every destructive test setup verifies identity before connection; TRUNCATE rechecks it. The only application DELETE is tenant-scoped. Test membership deletion uses the proven fixture. Container teardown verifies project resources and never removes volumes or orphans. No schema/database reset command was run against developer data.

After complete runs, docker ps -a was empty and only bridge/host/none networks remained. The same three pre-existing volumes remained, including `geofence-alert-api_geofence_postgres_data`; it was never mounted or mutated. The audit-built API image is retained as a local validation artifact. One early hardening run failed closed because Docker reports tmpfs under HostConfig.Tmpfs rather than Mounts; corrected inspection was rerun successfully. That failed attempt is not counted as a pass.

## Tenant isolation and validation

Anonymous protected access returns 401. Own-tenant create/get/update/list/filter/summary/delete passes. Cross-tenant GET/PATCH/DELETE returns 404; attempted mutations leave the target intact. Pagination totals, active/name filters and summaries remain scoped. Client tenantId is rejected with 400. Registration/login/me omit hashes; normalized duplicate email returns 409 without Prisma details. Missing, altered, expired, unsigned, wrong-algorithm, missing-expiration and inconsistent-membership tokens fail; deleted membership revokes authorization.

Original implementation snapshot: **96 unit/HTTP + 1 e2e + 79 database = 176 tests across 14 suites**, independently reproduced. Snapshot was kept out of final test discovery; no double-counting.

Hardened implementation: **121 unit/HTTP + 1 e2e + 85 database = 207 tests across 15 suites**. Multiple cold full disposable workflows pass and clean up. A --keep run supported catalog/drift inspection and was removed by the next verified cold run.

Commands executed (all required validation passed unless explicitly marked as an expected refusal or inherited audit warning):

```text
npm install
npx prisma format
npx prisma validate
npx prisma generate
npm run lint
npm run build
npm test -- --runInBand
npm run test:e2e
npm run test:db
npm run test:db -- --keep
npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
npx prisma migrate diff --from-schema tmp/gf3-audit/default.prisma --to-config-datasource --script
npx prisma migrate diff --from-schema tmp/gf3-audit/required.prisma --to-config-datasource --script
node tmp/gf3-audit/catalog.cjs
npm audit --json
npx jest --config test/jest-integration.json --runInBand --runTestsByPath test/integration/tenant-isolation.integration-spec.ts
  [expected failure with fake-production DATABASE_URL]
docker --context desktop-linux compose --env-file NUL -f docker-compose.yml config --quiet
  [expected failure with missing POSTGRES_PASSWORD]
docker --context desktop-linux compose --env-file NUL -f docker-compose.yml config --format json
  [synthetic password supplied; passes]
docker --context desktop-linux build -t geofence-gf3-audit-api .
docker --context desktop-linux run --rm --network none geofence-gf3-audit-api node -e <artifact-exclusion/client-load assertions>
docker ps -a
docker volume ls
docker network ls
git diff --check
git grep -n -E '^(<<<<<<<|=======|>>>>>>>)'
git status --short
```

The original snapshot was copied using git show at de5acdf into repository-local ignored temporary storage and run with existing locked dependencies. Original migration files/checksums in the working repository were not modified. The baseline fetch/status/revision/merge-base/divergence/log/diff-stat/numstat and full original diff were inspected. Commands requiring Git metadata or Docker access succeeded after sandbox elevation; blocked initial attempts were not reported as passes.

## GF-3 exclusions and disposition

No location-event ingestion, tracked-device API, ST_DWithin evaluation, point-in-circle query, enter/exit/approach state machine, transition persistence, alert workflow, WebSocket, Redis/queue, polygon, background worker, frontend, RBAC expansion, auth redesign or tenant-policy redesign was added. Existing schema-only AlertEvent remains schema-only. No unrelated refactoring was performed.

**READY FOR PUSH AND PR**, with the documented Prisma/manual-migration, inherited dependency and absent-CI caveats. No push, PR or merge was performed.

## Audit-only additions and final branch diff

New audit files: `.dockerignore` (safe build context), the additive `20260908110000_audit_contract_hardening` migration (radius/whitespace), `scripts/disposable-db-identity.js` and its TypeScript declaration (shared guard), `src/prisma/disposable-db-identity.spec.ts` (25 guard regressions), `scripts/start-compose.mjs` (credential encoding), and this evidence report. Changes to existing files are justified in the findings above.

Final origin/main...HEAD totals: **2874 insertions, 522 deletions, 37 files changed**.

| File | Insertions | Deletions |
| --- | ---: | ---: |
| `.dockerignore` | 13 | 0 |
| `.env.example` | 24 | 3 |
| `Dockerfile` | 7 | 1 |
| `README.md` | 96 | 34 |
| `docker-compose.test.yml` | 45 | 0 |
| `docker-compose.yml` | 41 | 9 |
| `docs/database-schema.md` | 209 | 58 |
| `docs/environment-variables.md` | 21 | 3 |
| `docs/gf3-independent-audit.md` | 246 | 0 |
| `docs/project-status.md` | 40 | 22 |
| `docs/testing.md` | 81 | 28 |
| `package-lock.json` | 279 | 55 |
| `package.json` | 15 | 4 |
| `prisma/migrations/20260602200706_init/migration.sql` | 0 | 28 |
| `prisma/migrations/20260805193807_add_identity_tenant_ownership/migration.sql` | 0 | 85 |
| `prisma/migrations/20260908102300_enable_postgis/migration.sql` | 29 | 0 |
| `prisma/migrations/20260908102319_init_postgresql_baseline/migration.sql` | 111 | 0 |
| `prisma/migrations/20260908102400_geofence_spatial_constraints/migration.sql` | 110 | 0 |
| `prisma/migrations/20260908110000_audit_contract_hardening/migration.sql` | 17 | 0 |
| `prisma/migrations/migration_lock.toml` | 1 | 1 |
| `prisma/schema.prisma` | 69 | 35 |
| `scripts/disposable-db-identity.d.ts` | 7 | 0 |
| `scripts/disposable-db-identity.js` | 100 | 0 |
| `scripts/disposable-db-test.mjs` | 240 | 0 |
| `scripts/start-compose.mjs` | 23 | 0 |
| `src/app.service.ts` | 4 | 1 |
| `src/auth/migration.spec.ts` | 0 | 77 |
| `src/config/env.validation.ts` | 8 | 1 |
| `src/prisma/disposable-db-identity.spec.ts` | 127 | 0 |
| `src/prisma/prisma.service.ts` | 17 | 5 |
| `test/integration/database-constraints.integration-spec.ts` | 262 | 0 |
| `test/integration/database-structure.integration-spec.ts` | 295 | 0 |
| `test/integration/spatial-sync.integration-spec.ts` | 202 | 0 |
| `test/integration/support/database.ts` | 30 | 0 |
| `src/auth/tenant-isolation.spec.ts => test/integration/tenant-isolation.integration-spec.ts` | 83 | 72 |
| `test/jest-integration.json` | 11 | 0 |
| `test/jest-setup-env.ts` | 11 | 0 |
