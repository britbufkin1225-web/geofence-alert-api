import type { AlertProducingTransition } from '../../location-events/geofence-alert.policy';

export type { AlertProducingTransition };

/**
 * One durable alert event, as the GF-8 read endpoints expose it.
 *
 * This is the smallest representation that answers the question an alert exists
 * to answer — whose device crossed which geofence, in which direction, when, and
 * from which observation — and nothing beyond it. Every field is copied from a
 * column GF-7 wrote and never rewrites, so two reads of the same committed row
 * are byte-identical.
 *
 * Deliberately absent:
 *
 *   * `severity` and `status`. They are unwritten GF-1 legacy columns sitting at
 *     their defaults; GF-7 never advances them and GF-8 does not manage alerts.
 *     Publishing `"status": "OPEN"` would advertise an acknowledgement workflow
 *     that does not exist and would become a field clients depend on before
 *     anything can move it.
 *   * `eventType`, `message` and `source`. All three are NULL on every row GF-7
 *     writes. A permanently null field is not a contract, and `message` in
 *     particular would look like a notification template for a phase that sends
 *     nothing.
 *   * `latitude` and `longitude`. Also NULL on every alert, and coordinates are
 *     not what an alert records; the source location event owns them.
 *   * `updatedAt`. An alert is immutable, so a second timestamp that always
 *     equals `createdAt` would only invite a client to poll it for changes that
 *     cannot happen.
 *   * The deduplication tuple as such. Its components are all present above as
 *     ordinary provenance, but nothing here is labelled as an internal key, and
 *     `AlertEvent_crossing_key` is not part of the public contract.
 *   * The geofence's name and the device's label. They are current values of
 *     mutable related rows, not a snapshot of the crossing: a geofence renamed
 *     after the fact would make an old alert appear to describe a place it never
 *     described. A client that wants the present name has `geofenceId` and the
 *     geofence endpoints, and gets an answer that is honestly current rather than
 *     one that is ambiguous about which it is.
 */
export interface AlertEventResponseDto {
  /** Stable identifier of the durable alert event. */
  id: string;

  /**
   * Owning tenant.
   *
   * Always the caller's own tenant — it is copied from the verified principal
   * into the query predicate, so it cannot be anything else. It is included
   * because the two other tenant-owned resources this API returns at the top
   * level, geofences and location events, both include it, and a client holding
   * records from several logins benefits from each one naming its own scope. It
   * discloses nothing: the caller proved this value by authenticating.
   */
  tenantId: string;

  /** The crossing this alert records. Only ever `ENTER` or `EXIT`. */
  transition: AlertProducingTransition;

  /**
   * The source's own observation instant, copied by GF-7 from the location event
   * that owns the crossing. This is the authoritative time the alert is ordered
   * and filtered by — never a server clock.
   */
  observedAt: Date;

  /**
   * When this server durably recorded the alert. Server bookkeeping time, and
   * deliberately distinct from `observedAt`: a device that was offline can flush
   * a back-dated observation, so the two can be far apart. Nothing is ordered or
   * filtered by this value.
   */
  createdAt: Date;

  /** The device that crossed. */
  trackedDeviceId: string;

  /** The geofence whose boundary was crossed. */
  geofenceId: string;

  /** The single observation that produced this crossing. */
  sourceLocationEventId: string;
}
