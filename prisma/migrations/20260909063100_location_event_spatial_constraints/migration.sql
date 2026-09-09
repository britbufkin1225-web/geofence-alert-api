-- GF-4, step 2 of 2: canonical spatial column and database-enforced constraints
-- for location events.
--
-- Hand-authored, like the GF-3 `geofence_spatial_constraints` migration and for
-- the same reason: Prisma has no model for generated columns or CHECK
-- constraints, so it can neither produce nor reproduce any statement below.
-- Future changes that touch them must be written here by hand as well.

-- ---------------------------------------------------------------------------
-- 1. Canonical spatial representation of the observation.
-- ---------------------------------------------------------------------------
-- Identical construction to Geofence."centerPoint": a STORED GENERATED column
-- that PostgreSQL computes from the scalar coordinates and refuses to let anyone
-- write directly. There is therefore no code path — application, worker, or
-- psql session — that can make "observedPoint" disagree with "latitude" and
-- "longitude".
--
-- The column must be dropped and re-added; PostgreSQL has no
-- `ALTER COLUMN ... ADD GENERATED ... STORED`. Nothing is lost: the table is
-- created empty by the preceding migration, and every value is fully derived.
--
-- ST_MakePoint takes (X, Y), so X is LONGITUDE and Y is LATITUDE. SRID 4326
-- (WGS 84) matches the degrees the API accepts, and `geography` makes later
-- ST_DWithin evaluation measure in meters — the same unit as
-- Geofence."radiusMeters". GF-4 issues no spatial query of any kind.

ALTER TABLE "LocationEvent" DROP COLUMN "observedPoint";

ALTER TABLE "LocationEvent" ADD COLUMN "observedPoint" geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography
  ) STORED;

-- Enforced by the database even though Prisma declares the field optional:
-- "latitude" and "longitude" are NOT NULL, so the generated value never can be.
ALTER TABLE "LocationEvent" ALTER COLUMN "observedPoint" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. No spatial index — deliberately.
-- ---------------------------------------------------------------------------
-- Geofence."centerPoint" carries a GiST index because the containment query a
-- later phase will run is "which geofences lie within radius of this point",
-- which probes the *geofence* index once per event. Indexing
-- LocationEvent."observedPoint" would instead serve "which events fall inside
-- this area" — a location-history query API that GF-4 explicitly does not
-- provide and that no committed query path uses. Adding a GiST index over what
-- is expected to be the highest-volume table in the schema, purely on
-- speculation, would cost write throughput and storage for nothing.
--
-- The index is a one-line addition whenever a real query path justifies it. The
-- structural integration test asserts its ABSENCE so that this stays a recorded
-- decision rather than an oversight.

-- ---------------------------------------------------------------------------
-- 3. Database-enforced constraints.
-- ---------------------------------------------------------------------------
-- These mirror the API contract in
-- src/location-events/dto/location-event.constants.ts, duplicated in the
-- database so that writes which bypass the NestJS validation pipe are still
-- bounded. Nothing here invents a limit the API does not already state.

-- Coordinate ranges: WGS 84 domain, identical to the DTO bounds and to the
-- equivalent Geofence constraints.
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_latitude_range_check"
  CHECK ("latitude" >= -90 AND "latitude" <= 90);

ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_longitude_range_check"
  CHECK ("longitude" >= -180 AND "longitude" <= 180);

-- Reported accuracy is a radius in meters. Negative is meaningless; zero is
-- permitted because sources that consider a fix exact (and simulated sources)
-- legitimately report 0. The upper bound mirrors
-- LOCATION_EVENT_ACCURACY_MAX_METERS: past 100 km an "observation" carries no
-- signal about a geofence whose own radius may not exceed 5 km.
--
-- IEEE-754 NaN passes every arithmetic comparison as false, so a bare
-- `>= 0 AND <= 100000` would silently admit it through a direct SQL write.
-- `'NaN'::double precision` is therefore excluded explicitly.
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_accuracyMeters_range_check"
  CHECK (
    "accuracyMeters" >= 0
    AND "accuracyMeters" <= 100000
    AND "accuracyMeters" <> 'NaN'::double precision
  );

-- The same NaN gap exists for coordinates on the Geofence table (GF-3) and is
-- closed here for the new table only; changing the GF-3 constraints is not a
-- GF-4 change and is recorded in docs/database-schema.md instead.
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_coordinates_finite_check"
  CHECK (
    "latitude" <> 'NaN'::double precision
    AND "longitude" <> 'NaN'::double precision
  );

-- Required, non-blank identifiers. The DTOs trim and reject empty strings; the
-- explicit ECMAScript whitespace set reproduces JavaScript's trim() exactly,
-- matching the GF-3 hardening migration (btrim(text) alone strips only ASCII
-- spaces, which would let a tab-only key through).
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_eventKey_not_blank_check"
  CHECK (btrim("eventKey", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '');

ALTER TABLE "TrackedDevice" ADD CONSTRAINT "TrackedDevice_deviceKey_not_blank_check"
  CHECK (btrim("deviceKey", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '');

ALTER TABLE "TrackedDevice" ADD CONSTRAINT "TrackedDevice_name_not_blank_check"
  CHECK (btrim("name", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '');
