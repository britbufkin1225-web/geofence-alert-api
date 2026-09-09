import { InternalServerErrorException } from '@nestjs/common';
import { GeofenceTransition, Prisma } from '@prisma/client';

import {
  GeofenceAlertQuery,
  GeofenceAlertRow,
  alertsForCrossingsStatement,
} from './geofence-alert.query';
import { GeofenceAlertService } from './geofence-alert.service';
import {
  GeofenceStoredStateRow,
  GeofenceTransitionRow,
} from './geofence-transition.query';

/**
 * Unit coverage for the half of GF-7 that is not the database: which
 * authoritative classifications become alert candidates, what is copied onto
 * them, what the response is allowed to say, and what happens when the stored
 * result does not match what was accepted.
 *
 * Deduplication itself is deliberately NOT mocked into existence here. The
 * unique constraint, the conflict-safe insert, the transaction boundary, replay
 * convergence and controlled concurrency are decided by PostgreSQL and are
 * proven against a real disposable PostgreSQL/PostGIS database in
 * test/integration/geofence-alert.integration-spec.ts. Asserting them against a
 * mock would only assert that the mock returned what it was told to.
 */

const TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';
const OTHER_EVENT_ID = 'ceventbbbbbbbbbbbbbbbbbbb';
const GEOFENCE_A = 'cgeoaaaaaaaaaaaaaaaaaaaaa';
const GEOFENCE_B = 'cgeobbbbbbbbbbbbbbbbbbbbb';
const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';
const OBSERVED_AT = new Date('2026-09-09T06:00:00.000Z');
const CREATED_AT = new Date('2026-09-09T06:00:01.500Z');

const row = (
  overrides: Partial<GeofenceTransitionRow> = {},
): GeofenceTransitionRow => ({
  geofenceId: GEOFENCE_A,
  name: 'Warehouse Zone',
  radiusMeters: 250,
  distanceMeters: 12.3456789,
  state: 'INSIDE',
  advancedTransition: 'ENTER',
  trackedDeviceId: DEVICE_ID,
  observedAt: OBSERVED_AT,
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

const alertRow = (
  overrides: Partial<GeofenceAlertRow> = {},
): GeofenceAlertRow => ({
  id: 'calertaaaaaaaaaaaaaaaaaaa',
  geofenceId: GEOFENCE_A,
  transition: 'ENTER',
  createdAt: CREATED_AT,
  ...overrides,
});

describe('GeofenceAlertService', () => {
  const persistAndRead = jest.fn();

  const alertQuery = {
    persistAndRead,
  } as unknown as GeofenceAlertQuery;

  const service = new GeofenceAlertService(alertQuery);

  // The transition query hands its own transaction client down. Nothing in this
  // service opens one, so an opaque token is enough to prove it is passed
  // through untouched.
  const tx = {
    marker: 'transition-transaction',
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    jest.clearAllMocks();
    persistAndRead.mockResolvedValue([]);
  });

  const record = (
    rows: GeofenceTransitionRow[],
    stored: GeofenceStoredStateRow[] = [],
  ) => service.record(tx, TENANT, EVENT_ID, rows, stored);

  describe('which classifications are recorded', () => {
    it.each<[GeofenceTransition]>([['ENTER'], ['EXIT']])(
      'records a %s that advanced state',
      async (advancedTransition) => {
        persistAndRead.mockResolvedValue([
          alertRow({ transition: advancedTransition }),
        ]);

        await record([row({ advancedTransition })]);

        expect(persistAndRead).toHaveBeenCalledWith(tx, TENANT, EVENT_ID, [
          {
            geofenceId: GEOFENCE_A,
            trackedDeviceId: DEVICE_ID,
            transition: advancedTransition,
            observedAt: OBSERVED_AT,
          },
        ]);
      },
    );

    it.each<[GeofenceTransition]>([
      ['BASELINE_INSIDE'],
      ['BASELINE_OUTSIDE'],
      ['STAY_INSIDE'],
      ['STAY_OUTSIDE'],
    ])('records nothing for a %s that advanced state', async (transition) => {
      await record([row({ advancedTransition: transition })]);

      // Not "called with an empty list": not called at all. A baseline must not
      // even reach the alert table.
      expect(persistAndRead).toHaveBeenCalledWith(tx, TENANT, EVENT_ID, []);
    });

    it('records nothing for a stale observation, whichever side it is on', async () => {
      await record(
        [
          row({ state: 'INSIDE', advancedTransition: null }),
          row({
            geofenceId: GEOFENCE_B,
            state: 'OUTSIDE',
            advancedTransition: null,
          }),
        ],
        [
          storedRow({ lastLocationEventId: OTHER_EVENT_ID }),
          storedRow({
            geofenceId: GEOFENCE_B,
            lastTransition: 'EXIT',
            lastLocationEventId: OTHER_EVENT_ID,
          }),
        ],
      );

      // The stored state belongs to a later observation. This one is evidence of
      // nothing, and the crossing it would otherwise borrow is not its own.
      expect(persistAndRead).toHaveBeenCalledWith(tx, TENANT, EVENT_ID, []);
    });

    it('records the crossing again when the event that owns it is replayed', async () => {
      persistAndRead.mockResolvedValue([alertRow()]);

      await record(
        [row({ advancedTransition: null })],
        [storedRow({ lastTransition: 'ENTER' })],
      );

      // Offering the row a second time is what repairs an alert lost between
      // attempts; the conflict-safe insert makes the ordinary case a no-op.
      expect(persistAndRead).toHaveBeenCalledWith(tx, TENANT, EVENT_ID, [
        expect.objectContaining({ transition: 'ENTER' }),
      ]);
    });

    it('does not record a replayed baseline', async () => {
      await record(
        [row({ advancedTransition: null })],
        [storedRow({ lastTransition: 'BASELINE_INSIDE' })],
      );

      expect(persistAndRead).toHaveBeenCalledWith(tx, TENANT, EVENT_ID, []);
    });

    it('records one candidate per geofence a single event genuinely crossed', async () => {
      persistAndRead.mockResolvedValue([
        alertRow(),
        alertRow({
          id: 'calertbbbbbbbbbbbbbbbbbbb',
          geofenceId: GEOFENCE_B,
          transition: 'EXIT',
        }),
      ]);

      await record([
        row({ advancedTransition: 'ENTER' }),
        row({ geofenceId: GEOFENCE_B, advancedTransition: 'EXIT' }),
        row({
          geofenceId: 'cgeoccccccccccccccccccccc',
          advancedTransition: 'STAY_INSIDE',
        }),
      ]);

      const [[, , , candidates]] = persistAndRead.mock.calls as Array<
        [unknown, string, string, Array<{ geofenceId: string }>]
      >;
      expect(candidates.map((entry) => entry.geofenceId)).toEqual([
        GEOFENCE_A,
        GEOFENCE_B,
      ]);
    });
  });

  describe('what is recorded', () => {
    it('takes the tenant from the caller and everything else from the database row', async () => {
      persistAndRead.mockResolvedValue([alertRow()]);

      await record([
        row({
          trackedDeviceId: 'cdevicebbbbbbbbbbbbbbbbbb',
          observedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ]);

      expect(persistAndRead).toHaveBeenCalledWith(tx, TENANT, EVENT_ID, [
        {
          geofenceId: GEOFENCE_A,
          trackedDeviceId: 'cdevicebbbbbbbbbbbbbbbbbb',
          transition: 'ENTER',
          observedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
    });

    it('persists inside the transaction it was handed, never one of its own', async () => {
      persistAndRead.mockResolvedValue([alertRow()]);

      await record([row()]);

      const [[handed]] = persistAndRead.mock.calls as Array<[unknown]>;
      expect(handed).toBe(tx);
    });
  });

  describe('refusing to report what was not stored', () => {
    it('fails when an accepted crossing has no stored alert', async () => {
      persistAndRead.mockResolvedValue([]);

      await expect(
        record([row({ advancedTransition: 'ENTER' })]),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('fails when only some accepted crossings came back', async () => {
      persistAndRead.mockResolvedValue([alertRow()]);

      await expect(
        record([
          row({ advancedTransition: 'ENTER' }),
          row({ geofenceId: GEOFENCE_B, advancedTransition: 'EXIT' }),
        ]),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('fails when the read-back returned more rows than were accepted', async () => {
      // A second alert for the same geofence means the read-back matched
      // something other than the crossing just accepted. Picking one of them
      // would name the wrong alert; the request fails instead.
      persistAndRead.mockResolvedValue([
        alertRow(),
        alertRow({ id: 'calertbbbbbbbbbbbbbbbbbbb' }),
      ]);

      await expect(
        record([row({ advancedTransition: 'ENTER' })]),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('succeeds with an empty index when nothing was a crossing', async () => {
      await expect(
        record([row({ advancedTransition: 'BASELINE_INSIDE' })]),
      ).resolves.toEqual(new Map());
    });
  });

  describe('what the response may say', () => {
    const index = new Map<string, GeofenceAlertRow>([[GEOFENCE_A, alertRow()]]);

    it('exposes only the alert identity and its original recording time', () => {
      expect(service.describe(GEOFENCE_A, 'ENTER', index)).toEqual({
        id: 'calertaaaaaaaaaaaaaaaaaaa',
        createdAt: CREATED_AT,
      });
    });

    it.each<[GeofenceTransition]>([
      ['BASELINE_INSIDE'],
      ['BASELINE_OUTSIDE'],
      ['STAY_INSIDE'],
      ['STAY_OUTSIDE'],
    ])('exposes nothing for a %s, even if a row exists', (transition) => {
      // The index deliberately holds an alert for this geofence. Policy, not
      // availability, decides what the response may claim.
      expect(service.describe(GEOFENCE_A, transition, index)).toBeUndefined();
    });

    it('never borrows another geofence alert', () => {
      expect(() => service.describe(GEOFENCE_B, 'ENTER', index)).toThrow(
        InternalServerErrorException,
      );
    });

    it('refuses an alert whose direction disagrees with the crossing', () => {
      expect(() => service.describe(GEOFENCE_A, 'EXIT', index)).toThrow(
        InternalServerErrorException,
      );
    });
  });
});

describe('alertsForCrossingsStatement', () => {
  const statement = alertsForCrossingsStatement(TENANT, EVENT_ID, [
    GEOFENCE_A,
    GEOFENCE_B,
  ]);

  it('binds every identifier as a parameter instead of interpolating it', () => {
    expect(statement.text).not.toContain(TENANT);
    expect(statement.text).not.toContain(EVENT_ID);
    expect(statement.text).not.toContain(GEOFENCE_A);
    expect(statement.values).toContain(TENANT);
    expect(statement.values).toContain(EVENT_ID);
    expect(statement.values).toContain(GEOFENCE_A);
    expect(statement.values).toContain(GEOFENCE_B);
  });

  it('requires the stored transition state to agree on the whole identity', () => {
    const joined = statement.text.replace(/\s+/g, ' ');

    for (const condition of [
      '"state"."tenantId" = "alert"."tenantId"',
      '"state"."trackedDeviceId" = "alert"."trackedDeviceId"',
      '"state"."geofenceId" = "alert"."geofenceId"',
      '"state"."lastLocationEventId" = "alert"."sourceLocationEventId"',
      '"state"."lastTransition" = "alert"."transition"',
    ]) {
      expect(joined).toContain(condition);
    }
  });

  it('qualifies the alert by tenant and by the event being ingested', () => {
    const joined = statement.text.replace(/\s+/g, ' ');

    expect(joined).toContain('"alert"."tenantId" =');
    expect(joined).toContain('"alert"."sourceLocationEventId" =');
  });

  it('reads without writing', () => {
    expect(statement.text).not.toContain('INSERT');
    expect(statement.text).not.toContain('UPDATE');
    expect(statement.text).not.toContain('DELETE');
  });

  it('never exposes a coordinate, a distance or a message', () => {
    const selected = statement.text.split('FROM')[0];

    expect(selected).not.toContain('latitude');
    expect(selected).not.toContain('longitude');
    expect(selected).not.toContain('message');
    expect(selected).not.toContain('severity');
    expect(selected).not.toContain('status');
  });
});
