import { GeofenceTransitionDto } from './geofence-transition-response.dto';

/**
 * The ingestion response.
 *
 * `observedPoint` is intentionally absent: the scalar coordinates are the
 * application-facing contract, and the geography column is a derived storage
 * detail that Prisma Client never selects.
 */
export interface LocationEventResponseDto {
  id: string;
  tenantId: string;
  trackedDeviceId: string;
  deviceKey: string;
  eventKey: string;
  observedAt: Date;
  receivedAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters: number;

  /**
   * `false` when this request created the event (HTTP 201), `true` when an
   * event with the same key already existed and carried identical observation
   * data (HTTP 200). A replay with *different* data is a 409 and never reaches
   * this shape.
   */
  replayed: boolean;

  /**
   * How this observation classifies against every active geofence of the
   * caller's tenant, and whether it advanced the stored device state (GF-6).
   *
   * Additive: every field above keeps the meaning and the value it had before
   * GF-6, so an existing client that ignores this array is unaffected.
   *
   * One entry per active geofence — not only the containing ones, because an
   * `EXIT` can only be reported for a geofence the device has left. Ordered by
   * ascending distance and then ascending `geofenceId`, the same total order the
   * GF-5 evaluation endpoint uses. Empty when the tenant has no active geofence.
   *
   * These are containment classifications only. GF-6 generates no alert and
   * delivers no notification, so nothing here asserts that anyone was told.
   */
  geofenceTransitions: GeofenceTransitionDto[];
}
