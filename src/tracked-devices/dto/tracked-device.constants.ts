/**
 * Validation limits for the tracked-device contract (GF-4).
 *
 * Mirrored by the database CHECK constraints and `VarChar` bounds added in the
 * `location_event_spatial_constraints` migration, so the contract, the code, the
 * database and the documentation stay in sync.
 */

/**
 * External device key: the stable identifier a location source reports about
 * itself. Unique within a tenant, never used to look a device up across
 * tenants.
 *
 * The charset is restricted rather than left free-form. The key is an opaque
 * correlation token, so nothing legitimate needs whitespace, control characters
 * or punctuation that tends to be interpreted downstream (in a log line, a CSV
 * export, a URL). Restricting it here is cheaper than sanitizing everywhere it
 * is later read.
 */
export const DEVICE_KEY_MIN_LENGTH = 1;
export const DEVICE_KEY_MAX_LENGTH = 128;
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Human-readable label. Bounded identically to Tenant/Geofence names. */
export const DEVICE_NAME_MIN_LENGTH = 1;
export const DEVICE_NAME_MAX_LENGTH = 120;
