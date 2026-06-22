import { GeofenceResponseDto } from './geofence-response.dto';

export type GeofenceSortBy =
  | 'name'
  | 'createdAt'
  | 'updatedAt'
  | 'radiusMeters'
  | 'isActive';

export type SortOrder = 'asc' | 'desc';

export class GeofenceListResponseDto {
  data!: GeofenceResponseDto[];

  meta!: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    filters: {
      active: boolean | null;
      search: string | null;
    };
    sort: {
      sortBy: GeofenceSortBy;
      sortOrder: SortOrder;
    };
  };
}
