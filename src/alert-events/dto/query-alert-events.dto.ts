import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { CUID_PATTERN } from '../../common/pipes/parse-cuid.pipe';
import {
  IsNotBeforeInstantProperty,
  IsStrictIsoDateTime,
} from '../../common/validators/strict-iso-date-time.decorator';
import {
  ALERT_PRODUCING_TRANSITIONS,
  type AlertProducingTransition,
} from '../../location-events/geofence-alert.policy';
import {
  ALERT_EVENT_PAGINATION_DEFAULT_LIMIT,
  ALERT_EVENT_PAGINATION_DEFAULT_PAGE,
  ALERT_EVENT_PAGINATION_MAX_LIMIT,
  ALERT_EVENT_PAGINATION_MIN_LIMIT,
} from './alert-event.constants';

/**
 * The complete query contract for `GET /api/v1/alert-events` (GF-8).
 *
 * Every property here is a bounded, exact, indexed filter over columns the
 * stored alert already has. What is deliberately absent is most of what a query
 * DTO could offer:
 *
 *   * no `tenantId`, `userId`, `membershipId` or any other ownership value. The
 *     tenant comes from the verified principal, and because the global pipe runs
 *     with `whitelist` + `forbidNonWhitelisted`, a caller that sends one gets a
 *     400 naming the offending property rather than having it silently ignored.
 *     A scope override cannot be *ignored* into existence.
 *   * no `sortBy` / `sortOrder`. The list has exactly one total order (see
 *     `alert-event.constants.ts`), so there is no ordering for a caller to
 *     choose and no non-unique sort column for one to select.
 *   * no free-text search, field selection, relation expansion, raw filter
 *     object or spatial predicate. Each of those turns a fixed statement into a
 *     caller-shaped one, and none of them is needed to read an alert feed.
 *
 * Numbers are converted with `@Type(() => Number)` and then validated as
 * integers, which is the same treatment `PaginationQueryDto` gives them. Every
 * malformed form therefore fails validation rather than being coerced into
 * something plausible: `abc` and a repeated `?page=1&page=2` both become `NaN`,
 * an empty value becomes `0`, and `1.5` stays fractional — `@IsInt` and `@Min`
 * reject all four. A `limit` above the maximum is REJECTED rather than clamped,
 * matching the geofence list endpoint: silently returning a different page size
 * than the one asked for makes a client's own pagination arithmetic wrong.
 */
export class QueryAlertEventsDto {
  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ALERT_EVENT_PAGINATION_MIN_LIMIT)
  page?: number = ALERT_EVENT_PAGINATION_DEFAULT_PAGE;

  /** Page size, bounded to `ALERT_EVENT_PAGINATION_MAX_LIMIT`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ALERT_EVENT_PAGINATION_MIN_LIMIT)
  @Max(ALERT_EVENT_PAGINATION_MAX_LIMIT)
  limit?: number = ALERT_EVENT_PAGINATION_DEFAULT_LIMIT;

  /**
   * Crossing direction.
   *
   * The accepted values are `ALERT_PRODUCING_TRANSITIONS` — the same constant
   * GF-7 persistence and the `AlertEvent_transition_crossing_check` CHECK
   * constraint are written from — rather than the full `GeofenceTransition`
   * enum. Accepting `STAY_INSIDE` here would be accepting a filter that can only
   * ever match nothing, and it would let the read contract drift away from the
   * write policy the moment either changed.
   */
  @IsOptional()
  @IsIn(ALERT_PRODUCING_TRANSITIONS)
  transition?: AlertProducingTransition;

  /** Exact tracked-device id. Resolved within the caller's tenant only. */
  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN, { message: 'trackedDeviceId must be a valid cuid' })
  trackedDeviceId?: string;

  /** Exact geofence id. Resolved within the caller's tenant only. */
  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN, { message: 'geofenceId must be a valid cuid' })
  geofenceId?: string;

  /**
   * Exact source location-event id — every alert one ingestion produced.
   *
   * Included because it is exactly the lookup
   * `AlertEvent_tenantId_sourceLocationEventId_idx` already exists to serve, and
   * because it is the correlation a client that has just ingested an observation
   * actually has in hand.
   */
  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN, {
    message: 'sourceLocationEventId must be a valid cuid',
  })
  sourceLocationEventId?: string;

  /**
   * Inclusive lower bound on the source observation instant.
   *
   * Kept as a string on the DTO and converted once in the service with the same
   * strict parser the validator uses, which is the convention ingestion already
   * follows: there is no second, looser parse anywhere on the path. A value
   * without an explicit `Z` or numeric offset is rejected, so the window a
   * caller asks for cannot mean different instants on different hosts.
   */
  @IsOptional()
  @IsString()
  @IsStrictIsoDateTime()
  observedFrom?: string;

  /**
   * EXCLUSIVE upper bound on the source observation instant.
   *
   * Exclusive, and named `observedBefore` so the wire contract says so without
   * anyone having to consult documentation. A half-open `[from, before)` window
   * is the deliberate choice because adjacent windows then tile exactly: the
   * caller who reads `[09:00, 10:00)` and then `[10:00, 11:00)` sees every alert
   * once, with no gap and no alert counted twice. An inclusive upper bound
   * cannot do that — the shared endpoint belongs to both windows — and it also
   * hides a truncation trap, because `observedAt` is stored to millisecond
   * precision and an `...T10:00:00Z` bound would silently exclude nothing while
   * appearing to name a clean hour boundary.
   *
   * A window whose upper bound is earlier than its lower bound is rejected as
   * invalid input rather than answered with an empty page.
   */
  @IsOptional()
  @IsString()
  @IsStrictIsoDateTime()
  @IsNotBeforeInstantProperty('observedFrom')
  observedBefore?: string;
}
