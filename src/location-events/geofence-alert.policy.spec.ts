import { GeofenceTransition } from '@prisma/client';

import {
  ALERT_PRODUCING_TRANSITIONS,
  isAlertProducingTransition,
} from './geofence-alert.policy';

/**
 * The alert policy of GF-7, on its own.
 *
 * It is a pure decision over the six GF-6 classifications, so it is worth
 * pinning exhaustively and cheaply: every one of the six is asserted by name
 * below, which means adding a seventh classification to the enum without
 * deciding whether it alerts breaks this suite rather than silently defaulting.
 */
describe('GF-7 alert policy', () => {
  const CROSSINGS: GeofenceTransition[] = ['ENTER', 'EXIT'];
  const SILENT: GeofenceTransition[] = [
    'BASELINE_INSIDE',
    'BASELINE_OUTSIDE',
    'STAY_INSIDE',
    'STAY_OUTSIDE',
  ];

  it.each(CROSSINGS.map((transition) => [transition]))(
    'treats %s as a durable alert',
    (transition) => {
      expect(isAlertProducingTransition(transition)).toBe(true);
    },
  );

  it.each(SILENT.map((transition) => [transition]))(
    'records nothing for %s',
    (transition) => {
      expect(isAlertProducingTransition(transition)).toBe(false);
    },
  );

  it('covers every classification the schema declares', () => {
    // A new GeofenceTransition value must be classified deliberately, not
    // inherited by whichever branch happens to catch it.
    expect([...CROSSINGS, ...SILENT].sort()).toEqual(
      Object.values(GeofenceTransition).sort(),
    );
  });

  it('is the same pair the database CHECK constraint enforces', () => {
    expect([...ALERT_PRODUCING_TRANSITIONS]).toEqual(['ENTER', 'EXIT']);
  });
});
