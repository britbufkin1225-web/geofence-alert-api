/**
 * The durable alert one accepted crossing produced (GF-7).
 *
 * Present on a transition result only when that result is an `ENTER` or an
 * `EXIT`. A baseline, a stay, a stale observation and a replay that no longer
 * owns its state carry no `alert` key at all, so a client cannot mistake the
 * absence of a crossing for an alert with empty fields.
 *
 * Two fields, and both are here because nothing else in the response carries
 * them:
 *
 *   * `id` is the alert's stable identity. Replaying the same observation, or
 *     retrying after a lost response, returns this same value — that is the
 *     observable form of "one crossing, one alert", and it is what a client
 *     correlates against later.
 *   * `createdAt` is when this server durably recorded the crossing. On a replay
 *     it is the ORIGINAL recording time, not the time of the replay, which is
 *     what distinguishes an idempotent reuse from a second alert.
 *
 * Deliberately absent, because the enclosing transition result and the ingestion
 * response already state them and a second copy could appear to disagree: the
 * geofence, the crossing direction, the device, the tenant and the observation
 * instant. Also absent: the deduplication key, any severity or workflow status,
 * and anything about delivery. GF-7 records the alert; it notifies nobody, and
 * this shape does not claim otherwise.
 */
export interface GeofenceAlertDto {
  /** Stable identifier of the durable alert event. */
  id: string;

  /**
   * When this server recorded the alert. Server bookkeeping time, distinct from
   * the observation instant the crossing was measured at, which the enclosing
   * response reports as `observedAt`.
   */
  createdAt: Date;
}
