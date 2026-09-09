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
}
