import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/principal';
import { ParseCuidPipe } from '../common/pipes/parse-cuid.pipe';
import { CreateLocationEventDto } from './dto/create-location-event.dto';
import { GeofenceEvaluationResponseDto } from './dto/geofence-evaluation-response.dto';
import { LocationEventResponseDto } from './dto/location-event-response.dto';
import { GeofenceEvaluationService } from './geofence-evaluation.service';
import { LocationEventsService } from './location-events.service';

// Protected by the global JwtAuthGuard. The tenant is taken from the verified
// principal and passed to the service; it is never read from the body, query,
// params or a client-supplied header.
@Controller('location-events')
export class LocationEventsController {
  constructor(
    private readonly locationEventsService: LocationEventsService,
    private readonly geofenceEvaluationService: GeofenceEvaluationService,
  ) {}

  /**
   * Ingests one observation.
   *
   * Responds `201 Created` when the event was stored and `200 OK` when an
   * identical event with the same key already existed. `@Res({ passthrough })`
   * is used only to select between the two — the body is still returned from
   * the handler and serialized by Nest as usual, and the global exception
   * filter still owns every error path. A fixed 201 would report a creation
   * that did not happen; a fixed 200 would hide one that did.
   */
  @Post()
  async ingest(
    @Body() dto: CreateLocationEventDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationEventResponseDto> {
    const result = await this.locationEventsService.ingest(
      dto,
      principal.tenantId,
    );

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);

    return result;
  }

  /**
   * Evaluates one stored observation against the caller tenant's active
   * geofences (GF-5).
   *
   * The handler contributes nothing to the answer beyond authentication context
   * and a validated identifier: it accepts no coordinates, no radius, no tenant,
   * no ordering and no pagination, so the only thing a caller chooses is which
   * of its own events to evaluate. The evaluation is read-only and returns `200`
   * whether or not anything matched — an observation outside every geofence is a
   * successful evaluation with an empty result, not a `404`.
   */
  @Get(':locationEventId/geofence-evaluation')
  evaluateGeofences(
    @Param('locationEventId', new ParseCuidPipe('location event'))
    locationEventId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<GeofenceEvaluationResponseDto> {
    return this.geofenceEvaluationService.evaluate(
      locationEventId,
      principal.tenantId,
    );
  }
}
