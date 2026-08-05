/**
 * Centralized validation limits for the geofence API contract.
 *
 * These bounds are enforced by the DTOs and documented in the README /
 * docs/api.md so the contract, the code, and the documentation stay in sync.
 */

// Geofence name: trimmed, must be non-empty, bounded length.
export const GEOFENCE_NAME_MIN_LENGTH = 1;
export const GEOFENCE_NAME_MAX_LENGTH = 120;

// Optional free-text description.
export const GEOFENCE_DESCRIPTION_MAX_LENGTH = 1000;

// Search term used to filter geofences by name.
export const GEOFENCE_SEARCH_MAX_LENGTH = 100;

// Circular geofence geometry (stored inputs only; no spatial evaluation here).
export const GEOFENCE_LATITUDE_MIN = -90;
export const GEOFENCE_LATITUDE_MAX = 90;
export const GEOFENCE_LONGITUDE_MIN = -180;
export const GEOFENCE_LONGITUDE_MAX = 180;

// Radius in meters. Maximum mirrors MAX_GEOFENCE_RADIUS_METERS in .env.example.
export const GEOFENCE_RADIUS_MIN_METERS = 1;
export const GEOFENCE_RADIUS_MAX_METERS = 5000;

// Pagination bounds for list endpoints.
export const PAGINATION_DEFAULT_PAGE = 1;
export const PAGINATION_DEFAULT_LIMIT = 10;
export const PAGINATION_MIN_LIMIT = 1;
export const PAGINATION_MAX_LIMIT = 100;
