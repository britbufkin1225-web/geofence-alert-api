/**
 * Bounds for the alert-event read contract (GF-8).
 *
 * The pagination values deliberately repeat the numbers the geofence list
 * endpoint already publishes rather than introducing a second, differently
 * bounded pagination philosophy for a second collection. They are declared here
 * instead of imported from `geofences/dto/geofence.constants` because they are
 * this endpoint's published contract, and a later change to the geofence
 * endpoint's page size must not silently move this one; the shared value is the
 * convention, not the constant.
 */

// Pagination bounds. Identical to the geofence list endpoint's published
// contract: default page 1, default limit 10, minimum 1, maximum 100.
export const ALERT_EVENT_PAGINATION_DEFAULT_PAGE = 1;
export const ALERT_EVENT_PAGINATION_DEFAULT_LIMIT = 10;
export const ALERT_EVENT_PAGINATION_MIN_LIMIT = 1;
export const ALERT_EVENT_PAGINATION_MAX_LIMIT = 100;

/**
 * The column the list is totally ordered by, and the unique tie-breaker.
 *
 * `observedAt` is the authoritative source observation instant GF-7 copied from
 * the location event that owns the crossing — the same value the time filters
 * apply to. It is not unique: one observation can cross several geofences at the
 * same instant, and independent devices can report the same instant, so ordering
 * by it alone leaves the order of a tie up to the plan PostgreSQL happens to
 * choose. `id` is the primary key, so appending it makes the order total, and a
 * total order is what stops the same alert appearing on two adjacent pages.
 *
 * Both descend: newest first is what a caller reading an alert feed wants, and
 * the tie-breaker descends with it so a single index can satisfy the whole
 * ordering in one direction.
 */
export const ALERT_EVENT_SORT_BY = 'observedAt';
export const ALERT_EVENT_SORT_ORDER = 'desc';
export const ALERT_EVENT_SORT_TIE_BREAKER = 'id';
