import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { GeofenceContainmentQuery } from './geofence-containment.query';
import {
  GeofenceEvaluationService,
  roundDistanceMeters,
} from './geofence-evaluation.service';

/**
 * Unit coverage for the orchestration and serialization half of GF-5: tenant
 * scoping of the event lookup, the non-disclosing 404, deterministic mapping and
 * the documented distance-rounding rule.
 *
 * The containment predicate itself is deliberately NOT mocked into existence
 * here — boundary semantics, meter-based geography, the active filter, the
 * tenant filter and the ordering are proven against real PostGIS in
 * test/integration/geofence-evaluation.integration-spec.ts. Mocking them would
 * only assert that the mock returns what it was told to.
 */

const TENANT = 'ctenantaaaaaaaaaaaaaaaaaa';
const OTHER_TENANT = 'ctenantbbbbbbbbbbbbbbbbbb';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';
const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';

const storedEvent = {
  id: EVENT_ID,
  trackedDeviceId: DEVICE_ID,
  observedAt: new Date('2026-09-09T06:00:00.000Z'),
  latitude: 30.2672,
  longitude: -97.7431,
};

const row = (overrides: Record<string, unknown> = {}) => ({
  geofenceId: 'cgeoaaaaaaaaaaaaaaaaaaaaa',
  name: 'Warehouse',
  latitude: 30.2672,
  longitude: -97.7431,
  radiusMeters: 500,
  distanceMeters: 12.3456789,
  ...overrides,
});

describe('GeofenceEvaluationService', () => {
  const findFirst = jest.fn();
  const findContainingGeofences = jest.fn();

  const prisma = {
    locationEvent: { findFirst },
  } as unknown as PrismaService;

  const containmentQuery = {
    findContainingGeofences,
  } as unknown as GeofenceContainmentQuery;

  const service = new GeofenceEvaluationService(prisma, containmentQuery);

  beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue(storedEvent);
    findContainingGeofences.mockResolvedValue([]);
  });

  describe('event resolution', () => {
    it('resolves the event with a same-tenant predicate in the query itself', async () => {
      await service.evaluate(EVENT_ID, TENANT);

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EVENT_ID, tenantId: TENANT },
        }),
      );
    });

    it('never selects the derived geography column', async () => {
      await service.evaluate(EVENT_ID, TENANT);

      const [[call]] = findFirst.mock.calls as Array<
        [{ select: Record<string, boolean> }]
      >;
      expect(Object.keys(call.select)).not.toContain('observedPoint');
    });

    it('throws the same 404 for a missing event as for a foreign one', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.evaluate(EVENT_ID, TENANT)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.evaluate(EVENT_ID, OTHER_TENANT)).rejects.toThrow(
        `Location event with id ${EVENT_ID} not found`,
      );
    });

    it('does not run the spatial query when the event does not resolve', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.evaluate(EVENT_ID, TENANT)).rejects.toThrow(
        NotFoundException,
      );
      expect(findContainingGeofences).not.toHaveBeenCalled();
    });
  });

  describe('tenant scoping of the spatial query', () => {
    it('passes the authenticated tenant, not one derived from input', async () => {
      await service.evaluate(EVENT_ID, TENANT);

      expect(findContainingGeofences).toHaveBeenCalledWith(EVENT_ID, TENANT);
    });

    it('passes the resolved event id from the database row', async () => {
      findFirst.mockResolvedValue({ ...storedEvent, id: EVENT_ID });

      await service.evaluate(EVENT_ID, TENANT);

      expect(findContainingGeofences).toHaveBeenCalledWith(
        EVENT_ID,
        expect.any(String),
      );
    });
  });

  describe('response mapping', () => {
    it('reports the stored observation, not request input', async () => {
      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(result).toMatchObject({
        locationEventId: EVENT_ID,
        trackedDeviceId: DEVICE_ID,
        observedAt: storedEvent.observedAt,
        latitude: 30.2672,
        longitude: -97.7431,
      });
    });

    it('returns an empty result rather than an error when nothing matched', async () => {
      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(result.matches).toEqual([]);
      expect(result.matchCount).toBe(0);
    });

    it('derives matchCount from the returned array', async () => {
      findContainingGeofences.mockResolvedValue([
        row({ geofenceId: 'cgeoaaaaaaaaaaaaaaaaaaaaa' }),
        row({ geofenceId: 'cgeobbbbbbbbbbbbbbbbbbbbb' }),
        row({ geofenceId: 'cgeoccccccccccccccccccccc' }),
      ]);

      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(result.matchCount).toBe(result.matches.length);
      expect(result.matchCount).toBe(3);
    });

    it('preserves the order the database returned', async () => {
      findContainingGeofences.mockResolvedValue([
        row({ geofenceId: 'cgeobbbbbbbbbbbbbbbbbbbbb', distanceMeters: 1 }),
        row({ geofenceId: 'cgeoaaaaaaaaaaaaaaaaaaaaa', distanceMeters: 2 }),
      ]);

      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(result.matches.map((match) => match.geofenceId)).toEqual([
        'cgeobbbbbbbbbbbbbbbbbbbbb',
        'cgeoaaaaaaaaaaaaaaaaaaaaa',
      ]);
    });

    it('exposes only the documented match fields', async () => {
      findContainingGeofences.mockResolvedValue([row()]);

      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(Object.keys(result.matches[0]).sort()).toEqual([
        'distanceMeters',
        'geofenceId',
        'latitude',
        'longitude',
        'name',
        'radiusMeters',
      ]);
    });

    it('exposes only the documented top-level fields', async () => {
      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(Object.keys(result).sort()).toEqual([
        'latitude',
        'locationEventId',
        'longitude',
        'matchCount',
        'matches',
        'observedAt',
        'trackedDeviceId',
      ]);
    });

    it('returns an equivalent payload for a repeated evaluation', async () => {
      findContainingGeofences.mockResolvedValue([row()]);

      const first = await service.evaluate(EVENT_ID, TENANT);
      const second = await service.evaluate(EVENT_ID, TENANT);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });

  describe('distance serialization', () => {
    it('rounds the emitted distance to millimeters', async () => {
      findContainingGeofences.mockResolvedValue([
        row({ distanceMeters: 12.3456789 }),
      ]);

      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(result.matches[0].distanceMeters).toBe(12.346);
    });

    it.each([
      [0, 0],
      [0.0004, 0],
      [0.0005, 0.001],
      [499.9999999, 500],
      [1234.5674, 1234.567],
      [1234.5675, 1234.568],
    ])('rounds %p to %p', (raw, expected) => {
      expect(roundDistanceMeters(raw)).toBe(expected);
    });

    it('leaves the configured radius unrounded', async () => {
      findContainingGeofences.mockResolvedValue([
        row({ radiusMeters: 123.456789 }),
      ]);

      const result = await service.evaluate(EVENT_ID, TENANT);

      expect(result.matches[0].radiusMeters).toBe(123.456789);
    });
  });

  describe('read-only guarantee', () => {
    it('calls no write operation on the database client', async () => {
      const writes = {
        create: jest.fn(),
        createMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      };

      const writeAwarePrisma = {
        locationEvent: { findFirst, ...writes },
        geofence: { findFirst: jest.fn(), ...writes },
        alertEvent: { findFirst: jest.fn(), ...writes },
      } as unknown as PrismaService;

      const writeAwareService = new GeofenceEvaluationService(
        writeAwarePrisma,
        containmentQuery,
      );

      await writeAwareService.evaluate(EVENT_ID, TENANT);

      for (const write of Object.values(writes)) {
        expect(write).not.toHaveBeenCalled();
      }
    });
  });
});
