import { GeofenceTransition } from '@prisma/client';

/**
 * Which transition classifications are alerts (GF-7).
 *
 * This is the whole of the alert policy, and it is deliberately a list rather
 * than a rule engine: two of the six classifications are boundary crossings, and
 * the other four are not.
 *
 *   * `ENTER` and `EXIT` are crossings. The device was on one side of the
 *     boundary at the previous accepted observation and is on the other side
 *     now, and the system watched it happen.
 *   * `BASELINE_INSIDE` and `BASELINE_OUTSIDE` are the first thing known about a
 *     device and geofence — the first observation ever, or the first after a
 *     reactivation. Nothing is known about where the device was before, so there
 *     is no crossing to alert on. A device that is simply already inside a new
 *     geofence never entered it while anyone was watching.
 *   * `STAY_INSIDE` and `STAY_OUTSIDE` are the absence of a crossing. The same
 *     value is also what a stale, superseded observation is told, which is the
 *     second reason it can never be an alert: an observation older than the
 *     stored state is not evidence of a crossing that the state it would have to
 *     be compared against has already moved past.
 *
 * The same two values are written into the `AlertEvent_transition_crossing_check`
 * CHECK constraint (see the `geofence_alert_events` migration). This constant is
 * where the application decides; the constraint is where PostgreSQL refuses. A
 * non-crossing label is rejected by PostgreSQL. This CHECK does not verify
 * spatial history: application classification and the transaction establish it.
 *
 * Dwell has no entry here. GF-6 declares no dwell classification and GF-7
 * invents none: a timer that fires without an observation is a different kind of
 * fact, and it belongs to the phase that implements it.
 */
export const ALERT_PRODUCING_TRANSITIONS: readonly GeofenceTransition[] = [
  GeofenceTransition.ENTER,
  GeofenceTransition.EXIT,
];

/**
 * `true` when the authoritative classification of an observation against one
 * geofence is a durable alert.
 *
 * The argument must be the classification the database produced (see
 * `classifyTransition`), never a value taken from a request. Note what this
 * function does NOT need to check: whether the observation advanced state.
 * `ENTER` and `EXIT` are only ever reported for an observation that owns the
 * current state of its geofence — an advancing observation gets the value the
 * upsert computed, a replay of the state-owning event gets that event's stored
 * value back, and everything older is reported as a `STAY_*`. So the crossing
 * type alone already carries the ownership.
 */
export function isAlertProducingTransition(
  transition: GeofenceTransition,
): transition is AlertProducingTransition {
  return ALERT_PRODUCING_TRANSITIONS.includes(transition);
}

/**
 * The two labels a stored alert's `transition` can carry.
 *
 * Additive: it narrows nothing that already existed and changes no runtime
 * value. It exists so the GF-8 read contract can state, in its own types, that
 * an alert is only ever an `ENTER` or an `EXIT` — the same restriction
 * `ALERT_PRODUCING_TRANSITIONS` applies at persistence and
 * `AlertEvent_transition_crossing_check` enforces in PostgreSQL. Declaring it
 * here rather than beside the read contract is what keeps the read and the write
 * reading from one definition of what an alert is.
 */
export type AlertProducingTransition =
  | typeof GeofenceTransition.ENTER
  | typeof GeofenceTransition.EXIT;
