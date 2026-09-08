-- GF-3, step 3 of 3: canonical spatial column, spatial index, and
-- database-enforced constraints.
--
-- This migration is hand-authored. Prisma has no model for generated columns,
-- CHECK constraints or GiST indexes, so it cannot produce or reproduce any of
-- the statements below; future schema changes that touch them must be written
-- here by hand as well (see docs/database-schema.md).

-- ---------------------------------------------------------------------------
-- 1. Canonical spatial representation of the circle center.
-- ---------------------------------------------------------------------------
-- The baseline migration created "centerPoint" as an ordinary nullable
-- geography column, because that is all Prisma can express for an
-- `Unsupported(...)` field. Here it is replaced by a STORED GENERATED column.
--
-- Why generated rather than a trigger:
--   A generated column is computed by PostgreSQL itself and cannot be written
--   directly — `UPDATE "Geofence" SET "centerPoint" = ...` fails with
--   "column can only be updated to DEFAULT". Divergence between the scalar
--   latitude/longitude and the spatial point is therefore not merely unlikely,
--   it is impossible: there is no code path, application or SQL, that can set
--   one without the other. A BEFORE trigger would have achieved the same
--   ordinary-path result but could still be bypassed (ALTER TABLE ... DISABLE
--   TRIGGER, or a session with triggers disabled) and would need matching
--   INSERT and UPDATE handling.
--
-- The column must be dropped and re-added: PostgreSQL has no
-- `ALTER COLUMN ... ADD GENERATED ... STORED`. Dropping loses no information,
-- because every value is fully derived from "longitude"/"latitude" and is
-- recomputed for all existing rows when the column is re-added.
--
-- Coordinate order is the PostGIS convention and is asserted by the integration
-- tests: ST_MakePoint takes (X, Y), so X is LONGITUDE and Y is LATITUDE.
-- SRID 4326 (WGS 84) matches the degrees the API already accepts, and the
-- `geography` type makes future ST_DWithin evaluation measure in meters — the
-- same unit as "radiusMeters". No such evaluation is added in GF-3.

ALTER TABLE "Geofence" DROP COLUMN "centerPoint";

ALTER TABLE "Geofence" ADD COLUMN "centerPoint" geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography
  ) STORED;

-- Enforced by the database even though Prisma declares the field optional:
-- "latitude" and "longitude" are NOT NULL, so the generated value never can be.
ALTER TABLE "Geofence" ALTER COLUMN "centerPoint" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Spatial index.
-- ---------------------------------------------------------------------------
-- GiST is the index type PostGIS uses for geography predicates. It is created
-- now so the spatial foundation is complete; GF-3 itself issues no spatial
-- queries.

CREATE INDEX "Geofence_centerPoint_gist_idx" ON "Geofence" USING GIST ("centerPoint");

-- ---------------------------------------------------------------------------
-- 3. Database-enforced constraints.
-- ---------------------------------------------------------------------------
-- These mirror limits that already exist in the API contract
-- (src/geofences/dto/geofence.constants.ts). They are duplicated in the
-- database so that data written outside the NestJS validation pipe — a manual
-- psql session, a future worker, a bad migration — still cannot violate them.
--
-- Nothing here invents a new business limit. Where the application has no
-- documented bound (User."passwordHash", every AlertEvent string), no
-- constraint is added.

-- Coordinate ranges: WGS 84 domain, identical to the DTO bounds.
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_latitude_range_check"
  CHECK ("latitude" >= -90 AND "latitude" <= 90);

ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_longitude_range_check"
  CHECK ("longitude" >= -180 AND "longitude" <= 180);

-- A circle with a non-positive radius is not a circle. This is the geometric
-- invariant, deliberately stated as "> 0" rather than the API's ">= 1 metre":
-- the 1 m floor is product policy that may be retuned without a migration,
-- whereas zero and negative radii can never be meaningful.
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_radiusMeters_positive_check"
  CHECK ("radiusMeters" > 0);

-- Upper bound mirrors GEOFENCE_RADIUS_MAX_METERS / MAX_GEOFENCE_RADIUS_METERS.
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_radiusMeters_max_check"
  CHECK ("radiusMeters" <= 5000);

-- Required, non-blank names. The DTOs trim and reject empty strings; btrim()
-- reproduces exactly that rule without depending on locale or case folding.
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_name_not_blank_check"
  CHECK (btrim("name") <> '');

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_name_not_blank_check"
  CHECK (btrim("name") <> '');

-- Canonical login identity: non-blank and free of surrounding whitespace,
-- matching normalizeEmail(). The lowercase half of that canonicalization is
-- deliberately NOT asserted here — PostgreSQL's lower() is locale-dependent and
-- does not always agree with JavaScript's toLowerCase() on non-ASCII input, so
-- a CHECK could reject addresses the API legitimately accepts.
ALTER TABLE "User" ADD CONSTRAINT "User_email_not_blank_check"
  CHECK (btrim("email") <> '' AND "email" = btrim("email"));

-- AlertEvent coordinates are optional (no ingestion exists yet), but when
-- present they describe the same WGS 84 domain as a geofence center.
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_latitude_range_check"
  CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));

ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_longitude_range_check"
  CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
