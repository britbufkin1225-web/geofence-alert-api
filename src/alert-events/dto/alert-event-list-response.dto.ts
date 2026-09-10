import type {
  AlertEventResponseDto,
  AlertProducingTransition,
} from './alert-event-response.dto';

/**
 * The filters that were actually applied, echoed back.
 *
 * `null` means "not filtered", never "filtered on null". Echoing the applied set
 * is what lets a caller confirm that the `total` it received describes the query
 * it believes it asked — a mistyped filter is rejected by validation, but a
 * filter a caller forgot to send is otherwise invisible in the response.
 */
export interface AlertEventListFiltersDto {
  transition: AlertProducingTransition | null;
  trackedDeviceId: string | null;
  geofenceId: string | null;
  sourceLocationEventId: string | null;
  /** Inclusive lower bound on `observedAt`, as applied. */
  observedFrom: Date | null;
  /** Exclusive upper bound on `observedAt`, as applied. */
  observedBefore: Date | null;
}

/**
 * The total order the page was cut from.
 *
 * Reported as data rather than left to documentation because it is the reason
 * the pages are stable: `observedAt` alone is not unique, and a client that
 * pages through a feed needs to know that a unique tie-breaker is what keeps one
 * alert off two adjacent pages. All three values are constant — GF-8 accepts no
 * caller-chosen ordering — so this block describes the contract, not a choice.
 */
export interface AlertEventListSortDto {
  sortBy: 'observedAt';
  sortOrder: 'desc';
  tieBreaker: 'id';
}

/**
 * `GET /api/v1/alert-events`.
 *
 * The `data` + `meta` envelope is the shape the geofence list endpoint already
 * publishes, extended with `count` (how many items this page actually carries)
 * and with the `sort` block describing a fixed total order rather than a
 * caller-selected one.
 *
 * `total` and `count` answer different questions and are both needed: `total` is
 * how many alerts match the filters across every page, `count` is how many are
 * in this response. On the final partial page they differ, and on a page past
 * the end `count` is `0` while `total` is not.
 */
export interface AlertEventListResponseDto {
  data: AlertEventResponseDto[];

  meta: {
    /** Matching alerts across every page, for this tenant and these filters. */
    total: number;
    /** Items in `data`. Zero past the last page — a success, not a `404`. */
    count: number;
    page: number;
    limit: number;
    /** `0` when nothing matches; there is no page 1 of an empty result. */
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    filters: AlertEventListFiltersDto;
    sort: AlertEventListSortDto;
  };
}
