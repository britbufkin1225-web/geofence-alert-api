import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationEventDto } from './dto/create-location-event.dto';
import { GeofenceTransitionService } from './geofence-transition.service';
import { LocationEventsService } from './location-events.service';

const TENANT_A = 'ctenantaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'ctenantbbbbbbbbbbbbbbbbbb';
const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';

const OBSERVED_AT_ISO = '2026-09-09T06:00:00.000Z';

const validDto: CreateLocationEventDto = {
  deviceKey: 'device-001',
  eventKey: 'evt-001',
  observedAt: OBSERVED_AT_ISO,
  latitude: 30.2672,
  longitude: -97.7431,
  accuracyMeters: 8.5,
};

const activeDevice = {
  id: DEVICE_ID,
  deviceKey: 'device-001',
  isActive: true,
};

const storedEvent = {
  id: EVENT_ID,
  tenantId: TENANT_A,
  trackedDeviceId: DEVICE_ID,
  eventKey: 'evt-001',
  observedAt: new Date(OBSERVED_AT_ISO),
  receivedAt: new Date('2026-09-09T06:00:02.000Z'),
  latitude: 30.2672,
  longitude: -97.7431,
  accuracyMeters: 8.5,
};

function uniqueViolation(
  index = 'LocationEvent_tenantId_trackedDeviceId_eventKey_key',
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'LocationEvent',
      driverAdapterError: {
        cause: { kind: 'UniqueConstraintViolation', constraint: { index } },
      },
    },
  });
}

describe('LocationEventsService', () => {
  let service: LocationEventsService;

  const prisma = {
    trackedDevice: { findUnique: jest.fn() },
    locationEvent: { findUnique: jest.fn(), create: jest.fn() },
  };

  // GF-6 transition detection is a collaborator here, not the subject. Its own
  // classification, ordering and concurrency behavior are proven against real
  // PostgreSQL/PostGIS in
  // test/integration/geofence-transition.integration-spec.ts; these tests only
  // assert how ingestion calls it and what it contributes to the response.
  const geofenceTransitions = { evaluate: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationEventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: GeofenceTransitionService, useValue: geofenceTransitions },
      ],
    }).compile();

    service = module.get(LocationEventsService);

    prisma.trackedDevice.findUnique.mockResolvedValue(activeDevice);
    prisma.locationEvent.findUnique.mockResolvedValue(null);
    prisma.locationEvent.create.mockResolvedValue(storedEvent);
    geofenceTransitions.evaluate.mockResolvedValue([]);
  });

  describe('device resolution', () => {
    it('looks the device up with a tenant-qualified predicate', async () => {
      await service.ingest(validDto, TENANT_A);

      expect(prisma.trackedDevice.findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_deviceKey: {
            tenantId: TENANT_A,
            deviceKey: 'device-001',
          },
        },
        select: { id: true, deviceKey: true, isActive: true },
      });
    });

    it('never issues an unscoped device lookup', async () => {
      await service.ingest(validDto, TENANT_A);

      const [[call]] = prisma.trackedDevice.findUnique.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >;
      expect(JSON.stringify(call.where)).toContain(TENANT_A);
    });

    it('returns 404 when the tenant owns no such device', async () => {
      prisma.trackedDevice.findUnique.mockResolvedValue(null);

      await expect(service.ingest(validDto, TENANT_B)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('does not disclose the foreign tenant in the not-found message', async () => {
      prisma.trackedDevice.findUnique.mockResolvedValue(null);

      await expect(service.ingest(validDto, TENANT_B)).rejects.toThrow(
        'Tracked device not found',
      );
    });

    it('refuses ingestion for an inactive device', async () => {
      prisma.trackedDevice.findUnique.mockResolvedValue({
        ...activeDevice,
        isActive: false,
      });

      await expect(service.ingest(validDto, TENANT_A)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.locationEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('first write', () => {
    it('persists the server-derived tenant and the resolved device', async () => {
      const result = await service.ingest(validDto, TENANT_A);

      expect(prisma.locationEvent.create).toHaveBeenCalledWith({
        data: {
          tenantId: TENANT_A,
          trackedDeviceId: DEVICE_ID,
          eventKey: 'evt-001',
          observedAt: new Date(OBSERVED_AT_ISO),
          latitude: 30.2672,
          longitude: -97.7431,
          accuracyMeters: 8.5,
        },
      });
      expect(result.replayed).toBe(false);
      expect(result.tenantId).toBe(TENANT_A);
    });

    it('never writes a client-supplied tenant, id, receipt time or point', async () => {
      const hostile = {
        ...validDto,
        tenantId: TENANT_B,
        id: 'cforgedaaaaaaaaaaaaaaaaaa',
        receivedAt: '1999-01-01T00:00:00.000Z',
        observedPoint: 'POINT(0 0)',
      } as unknown as CreateLocationEventDto;

      await service.ingest(hostile, TENANT_A);

      const [[call]] = prisma.locationEvent.create.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(call.data.tenantId).toBe(TENANT_A);
      expect(call.data).not.toHaveProperty('id');
      expect(call.data).not.toHaveProperty('receivedAt');
      expect(call.data).not.toHaveProperty('observedPoint');
    });

    it('returns the stored resource shape without the geography column', async () => {
      const result = await service.ingest(validDto, TENANT_A);

      expect(result).toEqual({
        id: EVENT_ID,
        tenantId: TENANT_A,
        trackedDeviceId: DEVICE_ID,
        deviceKey: 'device-001',
        eventKey: 'evt-001',
        observedAt: new Date(OBSERVED_AT_ISO),
        receivedAt: new Date('2026-09-09T06:00:02.000Z'),
        latitude: 30.2672,
        longitude: -97.7431,
        accuracyMeters: 8.5,
        replayed: false,
        geofenceTransitions: [],
      });
    });

    it('fails closed if an unvalidated timestamp reaches the service', async () => {
      const bypassed = { ...validDto, observedAt: '2026-02-30T00:00:00.000Z' };

      await expect(service.ingest(bypassed, TENANT_A)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(prisma.locationEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotent replay', () => {
    it('returns the existing event without creating a second row', async () => {
      prisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      const result = await service.ingest(validDto, TENANT_A);

      expect(result.replayed).toBe(true);
      expect(result.id).toBe(EVENT_ID);
      expect(prisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('scopes the replay lookup by tenant and device', async () => {
      prisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      await service.ingest(validDto, TENANT_A);

      expect(prisma.locationEvent.findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_trackedDeviceId_eventKey: {
            tenantId: TENANT_A,
            trackedDeviceId: DEVICE_ID,
            eventKey: 'evt-001',
          },
        },
      });
    });

    it.each([
      ['coordinates', { latitude: 31.5 }],
      ['longitude', { longitude: -96.1 }],
      ['timestamp', { observedAt: '2026-09-09T07:00:00.000Z' }],
      ['accuracy', { accuracyMeters: 42 }],
    ])('conflicts when the replay changes %s', async (_label, override) => {
      prisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      await expect(
        service.ingest({ ...validDto, ...override }, TENANT_A),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.locationEvent.create).not.toHaveBeenCalled();
    });

    it('treats an equal instant written with a different offset as a replay', async () => {
      prisma.locationEvent.findUnique.mockResolvedValue(storedEvent);

      const result = await service.ingest(
        { ...validDto, observedAt: '2026-09-09T08:00:00.000+02:00' },
        TENANT_A,
      );

      expect(result.replayed).toBe(true);
    });
  });

  describe('concurrent duplicate submissions', () => {
    it.each(['LocationEvent_pkey', 'some_other_unique_index'])(
      'does not classify %s as a replay even when a matching row exists',
      async (index) => {
        prisma.locationEvent.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(storedEvent);
        const error = uniqueViolation(index);
        prisma.locationEvent.create.mockRejectedValue(error);
        await expect(service.ingest(validDto, TENANT_A)).rejects.toBe(error);
        expect(prisma.locationEvent.findUnique).toHaveBeenCalledTimes(1);
      },
    );

    it('fails closed when P2002 has no constraint metadata', async () => {
      const error = new Prisma.PrismaClientKnownRequestError('Unknown unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.locationEvent.create.mockRejectedValue(error);
      await expect(service.ingest(validDto, TENANT_A)).rejects.toBe(error);
      expect(prisma.locationEvent.findUnique).toHaveBeenCalledTimes(1);
    });

    it('re-reads the winning row and reports a replay', async () => {
      prisma.locationEvent.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedEvent);
      prisma.locationEvent.create.mockRejectedValue(uniqueViolation());

      const result = await service.ingest(validDto, TENANT_A);

      expect(result.replayed).toBe(true);
      expect(result.id).toBe(EVENT_ID);
      expect(result.receivedAt).toEqual(storedEvent.receivedAt);
      expect(prisma.locationEvent.findUnique).toHaveBeenNthCalledWith(2, {
        where: {
          tenantId_trackedDeviceId_eventKey: {
            tenantId: TENANT_A,
            trackedDeviceId: DEVICE_ID,
            eventKey: validDto.eventKey,
          },
        },
      });
    });

    it('reports a conflict when the winning row holds different data', async () => {
      prisma.locationEvent.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...storedEvent, latitude: 10 });
      prisma.locationEvent.create.mockRejectedValue(uniqueViolation());

      await expect(service.ingest(validDto, TENANT_A)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rethrows the original error when the winner cannot be re-read', async () => {
      prisma.locationEvent.findUnique.mockResolvedValue(null);
      prisma.locationEvent.create.mockRejectedValue(uniqueViolation());

      await expect(service.ingest(validDto, TENANT_A)).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
    });

    it('does not swallow unrelated database errors', async () => {
      prisma.locationEvent.create.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(service.ingest(validDto, TENANT_A)).rejects.toThrow(
        'connection reset',
      );
    });
  });
});
