import { Controller, Get, Param, Query } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/principal';
import { ParseCuidPipe } from '../common/pipes/parse-cuid.pipe';
import { AlertEventsService } from './alert-events.service';
import type { AlertEventListResponseDto } from './dto/alert-event-list-response.dto';
import type { AlertEventResponseDto } from './dto/alert-event-response.dto';
import { QueryAlertEventsDto } from './dto/query-alert-events.dto';

/**
 * Read-only access to the durable alert events GF-7 records (GF-8).
 *
 * Two routes, both `GET`. There is deliberately no `POST`, `PATCH`, `PUT` or
 * `DELETE` here: an alert is created only by an accepted crossing on the
 * ingestion path, and acknowledgement, resolution, dismissal and deletion belong
 * to a phase that does not exist yet. A route that accepted one of them would be
 * a management surface with no policy behind it.
 *
 * The resource is `alert-events`, matching the `AlertEvent` model the way
 * `geofences`, `tracked-devices` and `location-events` match theirs, and it is
 * the path this repository's own API design already reserved for alert history.
 * Served under the application's `/api/v1` prefix like every other application
 * route.
 *
 * Protected by the global JwtAuthGuard. The tenant is taken from the verified
 * principal and passed to the service; it is never read from the body, query,
 * params or a client-supplied header. The handlers below contribute nothing to
 * the answer beyond that context and a validated query or identifier — no
 * ordering, no scope, no predicate of their own.
 */
@Controller('alert-events')
export class AlertEventsController {
  constructor(private readonly alertEventsService: AlertEventsService) {}

  /**
   * Lists the caller tenant's alerts, newest observation first.
   *
   * Always `200`, including for a tenant that has recorded no crossing at all:
   * an empty page with a zero total is a successful answer to a valid question,
   * and a `404` would claim the collection itself is missing.
   */
  @Get()
  findAll(
    @Query() query: QueryAlertEventsDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<AlertEventListResponseDto> {
    return this.alertEventsService.findAll(query, principal.tenantId);
  }

  /**
   * Retrieves one alert of the caller's tenant.
   *
   * A malformed id is rejected as `400` by the pipe before it reaches the
   * service or the database. A well-formed id that names another tenant's alert
   * and one that names nothing at all both return the same `404`.
   */
  @Get(':id')
  findOne(
    @Param('id', new ParseCuidPipe('alert event')) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<AlertEventResponseDto> {
    return this.alertEventsService.findOne(id, principal.tenantId);
  }
}
