import { GeofenceContainmentState, GeofenceTransition } from '@prisma/client';

import {
  GeofenceStoredStateRow,
  GeofenceTransitionQuery,
  GeofenceTransitionRow,
  evaluateAndAdvanceStatement,
  storedStateStatement,
} from './geofence-transition.query';
import { GeofenceTransitionService } from './geofence-transition.service';

/**
 * Unit coverage for the half of GF-6 that is not the database: what a
 * non-advancing observation is told, how rows are serialized, and that neither
 * statement can carry an identifier anywhere except a bound parameter.
 *
 * Classification of advancing observations, boundary semantics, ordering,
 * stale-event rejection and concurrency are deliberately NOT mocked into
 * existence here — they are decided by PostgreSQL in one statement and are
 * proven against real PostgreSQL/PostGIS in
 * test/integration/geofence-transition.integration-spec.ts. Mocking them would
 * only assert that the mock returned what it was told to.
 */

const TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';
const OTHER_EVENT_ID = 'ceventbbbbbbbbbbbbbbbbbbb';
const GEOFENCE_A = 'cgeoaaaaaaaaaaaaaaaaaaaaa';
const GEOFENCE_B = 'cgeobbbbbbbbbbbbbbbbbbbbb';

const row = (
  overrides: Partial<GeofenceTransitionRow> = {},
): GeofenceTransitionRow => ({
  geofenceId: GEOFENCE_A,
  name: 'Warehouse Zone',
  radiusMeters: 250,
  distanceMeters: 12.3456789,
  state: 'INSIDE',
  advancedTransition: 'BASELINE_INSIDE',
  ...overrides,
});

const storedRow = (
  overrides: Partial<GeofenceStoredStateRow> = {},
): GeofenceStoredStateRow => ({
  geofenceId: GEOFENCE_A,
  lastTransition: 'ENTER',
  lastLocationEventId: EVENT_ID,
  ...overrides,
});

describe('GeofenceTransitionService', () => {
  const evaluateAndAdvance = jest.fn();

  const transitionQuery = {
    evaluateAndAdvance,
  } as unknown as GeofenceTransitionQuery;

  const service = new GeofenceTransitionService(transitionQuery);

  beforeEach(() => {
    jest.clearAllMocks();
    evaluateAndAdvance.mockResolvedValue({ rows: [], stored: [] });
  });

  describe('delegation', () => {
    it('passes the event and the authoritative tenant through unchanged', async () => {
      await service.evaluate(EVENT_ID, TENANT);

      expect(evaluateAndAdvance).toHaveBeenCalledWith(EVENT_ID, TENANT);
    });

    it('treats a tenant with no applicable geofence as a successful evaluation', async () => {
      await expect(service.evaluate(EVENT_ID, TENANT)).resolves.toEqual([]);
    });
  });

  describe('advancing observations', () => {
    it('reports the classification the database computed, and marks it advanced', async () => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [row({ advancedTransition: 'ENTER' })],
        stored: [],
      });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      expect(transition.transition).toBe('ENTER');
      expect(transition.stateAdvanced).toBe(true);
    });

    it.each<[GeofenceTransition]>([
      ['BASELINE_INSIDE'],
      ['BASELINE_OUTSIDE'],
      ['ENTER'],
      ['EXIT'],
      ['STAY_INSIDE'],
      ['STAY_OUTSIDE'],
    ])('never rewrites a %s decision', async (advancedTransition) => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [row({ advancedTransition })],
        stored: [],
      });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      expect(transition.transition).toBe(advancedTransition);
    });
  });

  describe('non-advancing observations', () => {
    it('repeats the stored classification when the event is the one that wrote it', async () => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [row({ advancedTransition: null })],
        stored: [storedRow({ lastTransition: 'ENTER' })],
      });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      // A replay describes the same crossing it described the first time; it
      // does not re-report it as a fresh ENTER, and it does not advance.
      expect(transition.transition).toBe('ENTER');
      expect(transition.stateAdvanced).toBe(false);
    });

    it.each<[GeofenceContainmentState, GeofenceTransition]>([
      ['INSIDE', 'STAY_INSIDE'],
      ['OUTSIDE', 'STAY_OUTSIDE'],
    ])(
      'reports a stale %s observation as %s and never as a crossing',
      async (state, expected) => {
        evaluateAndAdvance.mockResolvedValue({
          rows: [row({ state, advancedTransition: null })],
          stored: [
            storedRow({
              lastTransition: 'EXIT',
              lastLocationEventId: OTHER_EVENT_ID,
            }),
          ],
        });

        const [transition] = await service.evaluate(EVENT_ID, TENANT);

        expect(transition.transition).toBe(expected);
        expect(transition.stateAdvanced).toBe(false);
      },
    );

    it('claims no crossing when the state row was retired between statements', async () => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [row({ state: 'OUTSIDE', advancedTransition: null })],
        stored: [],
      });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      expect(transition.transition).toBe('STAY_OUTSIDE');
      expect(transition.stateAdvanced).toBe(false);
    });

    it('does not borrow another geofence stored classification', async () => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [row({ state: 'OUTSIDE', advancedTransition: null })],
        stored: [storedRow({ geofenceId: GEOFENCE_B, lastTransition: 'EXIT' })],
      });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      expect(transition.transition).toBe('STAY_OUTSIDE');
    });
  });

  describe('serialization', () => {
    it('rounds the displayed distance by the GF-5 rule and nothing else', async () => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [row({ distanceMeters: 12.3456789 })],
        stored: [],
      });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      expect(transition.distanceMeters).toBe(12.346);
      expect(transition.radiusMeters).toBe(250);
    });

    it('returns only the documented fields', async () => {
      evaluateAndAdvance.mockResolvedValue({ rows: [row()], stored: [] });

      const [transition] = await service.evaluate(EVENT_ID, TENANT);

      expect(Object.keys(transition).sort()).toEqual([
        'distanceMeters',
        'geofenceId',
        'name',
        'radiusMeters',
        'state',
        'stateAdvanced',
        'transition',
      ]);
    });

    it('preserves the row order the database produced', async () => {
      evaluateAndAdvance.mockResolvedValue({
        rows: [
          row({ geofenceId: GEOFENCE_A, distanceMeters: 1 }),
          row({ geofenceId: GEOFENCE_B, distanceMeters: 2 }),
        ],
        stored: [],
      });

      const transitions = await service.evaluate(EVENT_ID, TENANT);

      expect(transitions.map((entry) => entry.geofenceId)).toEqual([
        GEOFENCE_A,
        GEOFENCE_B,
      ]);
    });
  });
});

describe('GF-6 statements', () => {
  describe('evaluateAndAdvanceStatement', () => {
    const statement = evaluateAndAdvanceStatement(EVENT_ID, TENANT);

    it('binds every identifier as a parameter instead of interpolating it', () => {
      expect(statement.text).not.toContain(EVENT_ID);
      expect(statement.text).not.toContain(TENANT);
      expect(statement.values).toContain(EVENT_ID);
      expect(statement.values).toContain(TENANT);
    });

    it('scopes the event, the geofence join and the written row by tenant', () => {
      // Three tenant bindings: the geofence join, the event lookup and the
      // inserted row. A single one would leave a path unqualified.
      const tenantBindings = statement.values.filter(
        (value) => value === TENANT,
      );
      expect(tenantBindings).toHaveLength(3);
    });

    it('considers only active geofences', () => {
      expect(statement.text).toContain('"geofence"."isActive" = TRUE');
    });

    it('decides containment with the shared boundary-inclusive predicate', () => {
      expect(statement.text).toContain(
        'ST_Distance("geofence"."centerPoint", "event"."observedPoint") <= "geofence"."radiusMeters"',
      );
    });

    it('does not apply the GF-5 containment prefilter, which would hide exits', () => {
      expect(statement.text).not.toContain('ST_DWithin');
    });

    it('advances state only on a strictly newer observation', () => {
      const guard = statement.text.replace(/\s+/g, ' ');

      expect(guard).toContain(
        'WHERE (EXCLUDED."lastObservedAt", EXCLUDED."lastLocationEventId") > ("GeofenceDeviceState"."lastObservedAt", "GeofenceDeviceState"."lastLocationEventId")',
      );
    });

    it('orders by distance and then by geofence id, as GF-5 does', () => {
      expect(statement.text).toContain(
        'ORDER BY "distanceMeters" ASC, "geofenceId" ASC',
      );
    });

    it('never consults server receipt time', () => {
      expect(statement.text).not.toContain('receivedAt');
    });

    it('writes nothing but the transition-state row', () => {
      const inserts = statement.text.match(/INSERT INTO "(\w+)"/g) ?? [];

      expect(inserts).toEqual(['INSERT INTO "GeofenceDeviceState"']);
      expect(statement.text).not.toContain('AlertEvent');
    });

    it('does not persist a distance', () => {
      const insertColumns = statement.text
        .split('ON CONFLICT')[0]
        .split('INSERT INTO')[1];

      expect(insertColumns).not.toContain('distanceMeters');
    });
  });

  describe('storedStateStatement', () => {
    const statement = storedStateStatement(EVENT_ID, TENANT, [
      GEOFENCE_A,
      GEOFENCE_B,
    ]);

    it('binds the geofence list rather than building an IN clause by hand', () => {
      expect(statement.text).not.toContain(GEOFENCE_A);
      expect(statement.values).toContain(GEOFENCE_A);
      expect(statement.values).toContain(GEOFENCE_B);
    });

    it('derives the device from the event instead of accepting one', () => {
      expect(statement.text).toContain(
        '"event"."trackedDeviceId" = "state"."trackedDeviceId"',
      );
    });

    it('qualifies both the event and the state row by tenant', () => {
      expect(statement.text).toContain('"event"."tenantId" =');
      expect(statement.text).toContain('"state"."tenantId" =');
    });

    it('reads without writing', () => {
      expect(statement.text).not.toContain('INSERT');
      expect(statement.text).not.toContain('UPDATE');
      expect(statement.text).not.toContain('DELETE');
    });
  });
});
