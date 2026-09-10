import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { parseStrictIsoDateTime } from '../common/validators/strict-iso-date-time.decorator';
import {
  isAlertProducingTransition,
  type AlertProducingTransition,
} from '../location-events/geofence-alert.policy';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AlertEventListFiltersDto,
  AlertEventListResponseDto,
} from './dto/alert-event-list-response.dto';
import type { AlertEventResponseDto } from './dto/alert-event-response.dto';
import {
  ALERT_EVENT_PAGINATION_DEFAULT_LIMIT,
  ALERT_EVENT_PAGINATION_DEFAULT_PAGE,
  ALERT_EVENT_SORT_BY,
  ALERT_EVENT_SORT_ORDER,
  ALERT_EVENT_SORT_TIE_BREAKER,
} from './dto/alert-event.constants';
import { QueryAlertEventsDto } from './dto/query-alert-events.dto';

/**
 * Exactly the columns the public representation is built from.
 *
 * A `select` rather than a default `findMany`: with no `select`, Prisma returns
 * every column of the row, and the eight fields the API publishes would then be
 * whatever the mapper below happened to copy out of a larger object. Naming them
 * here means a column added to `AlertEvent` later — an acknowledgement flag, a
 * delivery timestamp — is not fetched at all, let alone returned, until someone
 * adds it deliberately. The explicit mapper is the second half of the same
 * guarantee; neither alone would survive a careless spread.
 */
export const ALERT_EVENT_SELECTION = {
  id: true,
  tenantId: true,
  transition: true,
  observedAt: true,
  createdAt: true,
  trackedDeviceId: true,
  geofenceId: true,
  sourceLocationEventId: true,
} satisfies Prisma.AlertEventSelect;

/** One row as selected above, before it becomes a public representation. */
export type AlertEventRow = Prisma.AlertEventGetPayload<{
  select: typeof ALERT_EVENT_SELECTION;
}>;

/**
 * The total order, applied in the database and never in memory.
 *
 * Newest observation first, ties broken by the primary key descending. The
 * second clause is not decoration: one observation crosses several geofences at
 * one instant, and two devices can report the same instant, so `observedAt`
 * alone leaves the order within a tie to whatever plan PostgreSQL chooses. That
 * is the defect that puts one alert on two adjacent pages and hides another
 * entirely, and it is invisible until a tie exists.
 *
 * Exported so tests can assert the production statement carries exactly this,
 * rather than asserting that some ordering was applied.
 */
export const ALERT_EVENT_ORDER_BY: Prisma.AlertEventOrderByWithRelationInput[] =
  [{ observedAt: 'desc' }, { id: 'desc' }];

/** The fixed `sort` block every list response reports. */
const ALERT_EVENT_SORT = {
  sortBy: ALERT_EVENT_SORT_BY,
  sortOrder: ALERT_EVENT_SORT_ORDER,
  tieBreaker: ALERT_EVENT_SORT_TIE_BREAKER,
} as const;

/**
 * Converts a validated bound to the instant it names.
 *
 * The DTO already refused anything `parseStrictIsoDateTime` cannot read, so a
 * `null` here means the value reached the service without passing the pipe. That
 * is a wiring defect, not client input, and it fails closed as a sanitized 500
 * rather than quietly dropping the bound and answering a wider query than the
 * one that was asked for.
 */
function requireInstant(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseStrictIsoDateTime(value);
  if (!parsed) {
    throw new InternalServerErrorException();
  }

  return parsed;
}

/** The filters a request actually carries, as instants rather than strings. */
export interface ResolvedAlertEventFilters {
  transition?: AlertProducingTransition;
  trackedDeviceId?: string;
  geofenceId?: string;
  sourceLocationEventId?: string;
  observedFrom?: Date;
  observedBefore?: Date;
}

/** Parses the validated query into the filters the where clause is built from. */
export function resolveAlertEventFilters(
  query: QueryAlertEventsDto,
): ResolvedAlertEventFilters {
  return {
    transition: query.transition,
    trackedDeviceId: query.trackedDeviceId,
    geofenceId: query.geofenceId,
    sourceLocationEventId: query.sourceLocationEventId,
    observedFrom: requireInstant(query.observedFrom),
    observedBefore: requireInstant(query.observedBefore),
  };
}

/**
 * The single where clause both statements of a list request use.
 *
 * `tenantId` is assigned first and unconditionally, from the authenticated
 * principal, and no filter below can reach it: every optional property is a
 * different key, and the object is never merged with anything caller-shaped.
 * Scope is therefore part of the SQL predicate itself, not a check performed on
 * rows the database already returned.
 *
 * Building it once and handing the SAME object to `findMany` and to `count` is
 * what makes the page and the total describe one filter set. Two separately
 * constructed clauses could drift — a filter applied to the items but not the
 * count reports a `total` for a query nobody asked — and no test of the items
 * alone would notice.
 *
 * Every value is bound by Prisma as a parameter; nothing here is interpolated
 * into statement text, and the DTO has already constrained each one to a cuid, a
 * crossing label or an ISO instant.
 *
 * Exported so tests can read exactly the predicate production builds.
 */
export function buildAlertEventWhere(
  tenantId: string,
  filters: ResolvedAlertEventFilters,
): Prisma.AlertEventWhereInput {
  const where: Prisma.AlertEventWhereInput = { tenantId };

  if (filters.transition !== undefined) {
    where.transition = filters.transition;
  }

  if (filters.trackedDeviceId !== undefined) {
    where.trackedDeviceId = filters.trackedDeviceId;
  }

  if (filters.geofenceId !== undefined) {
    where.geofenceId = filters.geofenceId;
  }

  if (filters.sourceLocationEventId !== undefined) {
    where.sourceLocationEventId = filters.sourceLocationEventId;
  }

  // Half-open [observedFrom, observedBefore): `gte` on the lower bound, `lt` on
  // the upper. Both bounds land on `observedAt` — the source observation instant
  // — and never on `createdAt`. Mixing the two would filter a device's own
  // timeline by when this server happened to write it down, which for a
  // back-dated flush from an offline device is a different window entirely.
  if (
    filters.observedFrom !== undefined ||
    filters.observedBefore !== undefined
  ) {
    where.observedAt = {
      ...(filters.observedFrom !== undefined
        ? { gte: filters.observedFrom }
        : {}),
      ...(filters.observedBefore !== undefined
        ? { lt: filters.observedBefore }
        : {}),
    };
  }

  return where;
}

/**
 * The one place a stored row becomes a public representation.
 *
 * Field by field, with no spread of the row and no spread of a related record.
 * Both read endpoints call it, so a list item and the detail response for the
 * same alert are the same object by construction rather than by two mappers that
 * are expected to agree.
 */
export function toAlertEventResponse(
  row: AlertEventRow,
): AlertEventResponseDto {
  // The database refuses a non-crossing label through
  // `AlertEvent_transition_crossing_check`, so this is unreachable while that
  // constraint stands. It is asserted rather than assumed because the failure it
  // guards is silent: a row inserted by a direct write around the constraint
  // would otherwise be published as an alert for something that is not a
  // crossing, and the narrowed response type would be a lie.
  if (!isAlertProducingTransition(row.transition)) {
    throw new InternalServerErrorException();
  }

  return {
    id: row.id,
    tenantId: row.tenantId,
    transition: row.transition,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    trackedDeviceId: row.trackedDeviceId,
    geofenceId: row.geofenceId,
    sourceLocationEventId: row.sourceLocationEventId,
  };
}

/** Normalizes the applied filters into the `meta.filters` block. */
function echoFilters(
  filters: ResolvedAlertEventFilters,
): AlertEventListFiltersDto {
  return {
    transition: filters.transition ?? null,
    trackedDeviceId: filters.trackedDeviceId ?? null,
    geofenceId: filters.geofenceId ?? null,
    sourceLocationEventId: filters.sourceLocationEventId ?? null,
    observedFrom: filters.observedFrom ?? null,
    observedBefore: filters.observedBefore ?? null,
  };
}

/**
 * Read-only, tenant-scoped access to the durable alert events GF-7 records
 * (GF-8).
 *
 * Both methods take an authoritative `tenantId` derived from the verified
 * principal — never from a body, query parameter, path segment or header — and
 * put it in the database predicate. An alert owned by another tenant is
 * therefore not "found and then rejected": it is not selected at all, which is
 * what makes it indistinguishable from one that does not exist.
 *
 * Nothing here writes. There is no lazy alert creation, no backfill, no
 * transition evaluation and no repair: a GET that could manufacture an alert
 * would make the alert table a function of who happened to read it. Reading a
 * tenant that has never crossed a boundary returns an empty page, not a page
 * that reading brought into existence.
 */
@Injectable()
export class AlertEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One bounded, filtered, totally ordered page of the caller tenant's alerts.
   *
   * The items and the count run as two statements inside one
   * `$transaction([...])`, which is the pattern the geofence list endpoint
   * already uses. Being honest about what that does and does not buy: the pair
   * is atomic in the sense that both run on one connection in one transaction,
   * but the transaction is READ COMMITTED, so each statement takes its own
   * snapshot. An ingestion that commits a new alert between them can make
   * `total` describe one instant and `data` another. The window is small and the
   * consequence is a count that is off by the number of alerts recorded during
   * it — not a wrong page, a duplicate or a missing row, because the ordering is
   * total and the two statements share one predicate. Closing it entirely would
   * mean REPEATABLE READ for a read endpoint, and GF-8 does not take that on.
   */
  async findAll(
    query: QueryAlertEventsDto,
    tenantId: string,
  ): Promise<AlertEventListResponseDto> {
    const page = query.page ?? ALERT_EVENT_PAGINATION_DEFAULT_PAGE;
    const limit = query.limit ?? ALERT_EVENT_PAGINATION_DEFAULT_LIMIT;
    const skip = (page - 1) * limit;

    const filters = resolveAlertEventFilters(query);
    const where = buildAlertEventWhere(tenantId, filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.alertEvent.findMany({
        where,
        select: ALERT_EVENT_SELECTION,
        orderBy: ALERT_EVENT_ORDER_BY,
        skip,
        take: limit,
      }),
      this.prisma.alertEvent.count({ where }),
    ]);

    const data = rows.map(toAlertEventResponse);

    return {
      data,
      meta: {
        total,
        count: data.length,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
        filters: echoFilters(filters),
        sort: ALERT_EVENT_SORT,
      },
    };
  }

  /**
   * One alert of the caller's tenant.
   *
   * `findFirst` with an `id` + `tenantId` predicate, never a `findUnique` by id
   * followed by an ownership comparison. The difference is the whole tenant
   * boundary: the second form has already read another tenant's row into this
   * process before deciding what to do with it, and any later refactor that
   * forgets the comparison leaks it. A foreign id and an id that was never
   * issued both select nothing and both raise the same 404 with the same
   * message, so neither response confirms that the other tenant's alert exists.
   */
  async findOne(id: string, tenantId: string): Promise<AlertEventResponseDto> {
    const row = await this.prisma.alertEvent.findFirst({
      where: { id, tenantId },
      select: ALERT_EVENT_SELECTION,
    });

    if (!row) {
      throw new NotFoundException(`Alert event with id ${id} not found`);
    }

    return toAlertEventResponse(row);
  }
}
