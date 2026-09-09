/**
 * Validation limits for the location-event ingestion contract (GF-4).
 *
 * Mirrored by the database CHECK constraints added in the
 * `location_event_spatial_constraints` migration, so a write that bypasses the
 * NestJS validation pipe is still bounded.
 */

// WGS 84 domain. Identical to the geofence bounds; both are stored as
// geography(Point, 4326).
export const LOCATION_EVENT_LATITUDE_MIN = -90;
export const LOCATION_EVENT_LATITUDE_MAX = 90;
export const LOCATION_EVENT_LONGITUDE_MIN = -180;
export const LOCATION_EVENT_LONGITUDE_MAX = 180;

/**
 * Reported horizontal accuracy, as a radius in meters.
 *
 * Zero is allowed: the W3C Geolocation contract that most sources follow defines
 * accuracy as non-negative, and a source that considers its fix exact (or a
 * simulated source) legitimately reports 0. Rejecting it would force clients to
 * lie.
 *
 * The 100 km ceiling is ingestion policy, not a geometric guarantee. Accuracy
 * is recorded as metadata in GF-4; nothing evaluates or filters on it yet.
 */
export const LOCATION_EVENT_ACCURACY_MIN_METERS = 0;
export const LOCATION_EVENT_ACCURACY_MAX_METERS = 100_000;

/**
 * How far ahead of the server clock an `observedAt` may be.
 *
 * Devices and servers do not share a clock, and a submission takes time to
 * arrive, so a strict "not in the future" rule would reject legitimate events.
 * Five minutes absorbs ordinary skew while keeping the bound tight enough that
 * a wrong or hostile clock cannot park observations far in the future and
 * distort any ordering built on `observedAt` later.
 *
 * There is deliberately no lower bound. Back-dated events are accepted so a
 * source that was offline can flush its buffer; retention limits are a separate
 * concern and are deferred beyond GF-4.
 */
export const LOCATION_EVENT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Client-supplied idempotency key. Uniqueness is scoped to
 * (tenantId, trackedDeviceId, eventKey).
 *
 * The charset is restricted for the same reason as the device key: it is an
 * opaque correlation token that is later read in logs and exports, so nothing
 * legitimate needs whitespace or control characters in it. It comfortably
 * admits the formats sources actually use (UUIDs, cuids, ULIDs, `<device>:<seq>`
 * pairs).
 */
export const EVENT_KEY_MIN_LENGTH = 1;
export const EVENT_KEY_MAX_LENGTH = 200;
export const EVENT_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
