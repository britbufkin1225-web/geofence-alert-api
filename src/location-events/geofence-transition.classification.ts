import { GeofenceContainmentState, GeofenceTransition } from '@prisma/client';

import {
  GeofenceStoredStateRow,
  GeofenceTransitionRow,
} from './geofence-transition.query';

/**
 * The authoritative classification of one evaluated geofence for one
 * observation (GF-6).
 *
 * Extracted from GeofenceTransitionService in GF-7 without a change of
 * behaviour. Two callers now need the identical answer and must not be able to
 * disagree about it: the service, which serializes it into the response, and the
 * alert boundary, which decides inside the transition transaction whether the
 * crossing is durable. Duplicating the rule in the second caller is exactly the
 * defect that would let an alert describe a different crossing from the one the
 * API reported, so there is one function and both call it.
 *
 * It is a pure function of rows the database already produced. It reads no
 * clock, performs no I/O and accepts nothing from a caller except the id of the
 * event being classified.
 */
export function classifyTransition(
  row: GeofenceTransitionRow,
  locationEventId: string,
  stored: GeofenceStoredStateRow | undefined,
): GeofenceTransition {
  // The database already classified every observation that advanced state, from
  // the row it overwrote.
  if (row.advancedTransition !== null) {
    return row.advancedTransition;
  }

  // A replay of the event that wrote the current state answers with that event's
  // own stored classification, so ingesting the same event twice cannot describe
  // one crossing two different ways.
  if (stored?.lastLocationEventId === locationEventId) {
    return stored.lastTransition;
  }

  // Anything else is an observation older than the current state. It is reported
  // as a `STAY_*` at its own containment, never as `ENTER` or `EXIT`: it is not
  // evidence that the device crossed anything, and the state it would have to be
  // compared against belongs to a later observation.
  return row.state === GeofenceContainmentState.INSIDE
    ? GeofenceTransition.STAY_INSIDE
    : GeofenceTransition.STAY_OUTSIDE;
}
