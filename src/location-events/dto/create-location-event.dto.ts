import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trim } from '../../common/transforms/trim.transform';
import {
  IsNotBeyondFutureSkew,
  IsStrictIsoDateTime,
} from '../../common/validators/strict-iso-date-time.decorator';
import {
  DEVICE_KEY_MAX_LENGTH,
  DEVICE_KEY_MIN_LENGTH,
  DEVICE_KEY_PATTERN,
} from '../../tracked-devices/dto/tracked-device.constants';
import {
  EVENT_KEY_MAX_LENGTH,
  EVENT_KEY_MIN_LENGTH,
  EVENT_KEY_PATTERN,
  LOCATION_EVENT_ACCURACY_MAX_METERS,
  LOCATION_EVENT_ACCURACY_MIN_METERS,
  LOCATION_EVENT_LATITUDE_MAX,
  LOCATION_EVENT_LATITUDE_MIN,
  LOCATION_EVENT_LONGITUDE_MAX,
  LOCATION_EVENT_LONGITUDE_MIN,
  LOCATION_EVENT_MAX_FUTURE_SKEW_MS,
} from './location-event.constants';

/**
 * The complete ingestion contract. Every property here is client-supplied data
 * about an observation; nothing about ownership is.
 *
 * There is deliberately no `tenantId`, no `trackedDeviceId`, no `id`, no
 * `receivedAt` and no `observedPoint`. Tenant comes from the verified principal,
 * the device is resolved within that tenant, the id and receipt time are
 * assigned by the server, and the spatial point is computed by PostgreSQL.
 * Because the global pipe runs with `whitelist` + `forbidNonWhitelisted`, a
 * client that sends any of them gets a 400 naming the offending property rather
 * than having it silently ignored.
 *
 * `@IsNumber()` defaults to rejecting NaN and Infinity, and the pipe does not
 * enable implicit conversion, so numeric *strings* ("30.2672") are rejected too:
 * the transport contract is JSON numbers.
 */
export class CreateLocationEventDto {
  /** External key of a tracked device owned by the authenticated tenant. */
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MinLength(DEVICE_KEY_MIN_LENGTH)
  @MaxLength(DEVICE_KEY_MAX_LENGTH)
  @Matches(DEVICE_KEY_PATTERN, {
    message:
      'deviceKey may contain only letters, digits, dot, underscore, colon and hyphen',
  })
  deviceKey!: string;

  /** Client-generated idempotency key for this observation. */
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MinLength(EVENT_KEY_MIN_LENGTH)
  @MaxLength(EVENT_KEY_MAX_LENGTH)
  @Matches(EVENT_KEY_PATTERN, {
    message:
      'eventKey may contain only letters, digits, dot, underscore, colon and hyphen',
  })
  eventKey!: string;

  /**
   * When the source took the fix. Kept as a string on the DTO and converted once
   * in the service with the same strict parser the validator uses, so there is
   * no second, looser parse anywhere in the path.
   */
  @IsString()
  @IsStrictIsoDateTime()
  @IsNotBeyondFutureSkew(LOCATION_EVENT_MAX_FUTURE_SKEW_MS)
  observedAt!: string;

  @IsNumber()
  @Min(LOCATION_EVENT_LATITUDE_MIN)
  @Max(LOCATION_EVENT_LATITUDE_MAX)
  latitude!: number;

  @IsNumber()
  @Min(LOCATION_EVENT_LONGITUDE_MIN)
  @Max(LOCATION_EVENT_LONGITUDE_MAX)
  longitude!: number;

  @IsNumber()
  @Min(LOCATION_EVENT_ACCURACY_MIN_METERS)
  @Max(LOCATION_EVENT_ACCURACY_MAX_METERS)
  accuracyMeters!: number;
}
