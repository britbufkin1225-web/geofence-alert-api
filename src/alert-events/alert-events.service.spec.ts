import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import {
  ALERT_EVENT_ORDER_BY,
  ALERT_EVENT_SELECTION,
  AlertEventsService,
  buildAlertEventWhere,
  resolveAlertEventFilters,
  toAlertEventResponse,
} from './alert-events.service';
import type { AlertEventRow } from './alert-events.service';
import { QueryAlertEventsDto } from './dto/query-alert-events.dto';

/**
 * Service-level proof for the GF-8 read contract.
 *
 * What is proven here is the shape of the statements the service sends: that
 * tenant scope is in the predicate rather than applied to results afterwards,
 * that the ordering is total, that the items and the count are built from one
 * predicate, and that the response is mapped explicitly. Real tenant isolation,
 * real ordering under equal timestamps, real pagination boundaries and the proof
 * that a read writes nothing are in
 * test/integration/alert-retrieval.integration-spec.ts, against PostgreSQL.
 */

const TENANT_A = 'ctenantaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'ctenantbbbbbbbbbbbbbbbbbb';
const DEVICE_ID = 'cdeviceaaaaaaaaaaaaaaaaaa';
const GEOFENCE_ID = 'cgeofenceaaaaaaaaaaaaaaaa';
const EVENT_ID = 'ceventaaaaaaaaaaaaaaaaaaa';
const ALERT_ID = 'calertaaaaaaaaaaaaaaaaaaa';

const OBSERVED_AT = new Date('2026-09-09T06:00:00.000Z');
const CREATED_AT = new Date('2026-09-09T06:00:02.000Z');

const storedRow: AlertEventRow = {
  id: ALERT_ID,
  tenantId: TENANT_A,
  transition: 'ENTER',
  observedAt: OBSERVED_AT,
  createdAt: CREATED_AT,
  trackedDeviceId: DEVICE_ID,
  geofenceId: GEOFENCE_ID,
  sourceLocationEventId: EVENT_ID,
};

/** A query as the ValidationPipe would hand it to the controller. */
function query(overrides: Partial<QueryAlertEventsDto> = {}) {
  return Object.assign(new QueryAlertEventsDto(), overrides);
}

describe('AlertEventsService', () => {
  let service: AlertEventsService;

  const mockPrisma = {
    alertEvent: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      // Present only so the specs below can assert they are never reached.
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };

  /** Every method that could change a row, by the name the service would use. */
  const writeMethods = [
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
  ] as const;

  const expectNoWrites = () => {
    for (const method of writeMethods) {
      expect(mockPrisma.alertEvent[method]).not.toHaveBeenCalled();
    }
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertEventsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = moduleRef.get(AlertEventsService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.alertEvent.findMany.mockResolvedValue([storedRow]);
    mockPrisma.alertEvent.count.mockResolvedValue(1);
    mockPrisma.alertEvent.findFirst.mockResolvedValue(storedRow);
    mockPrisma.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
  });

  describe('tenant scope', () => {
    it('puts the authenticated tenant in the list predicate', async () => {
      await service.findAll(query(), TENANT_A);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where.tenantId).toBe(TENANT_A);
    });

    it('puts the authenticated tenant in the count predicate too', async () => {
      await service.findAll(query(), TENANT_A);

      const [args] = mockPrisma.alertEvent.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where.tenantId).toBe(TENANT_A);
    });

    it('gives findMany and count the identical predicate object', async () => {
      await service.findAll(
        query({ transition: 'EXIT', geofenceId: GEOFENCE_ID }),
        TENANT_A,
      );

      const [listArgs] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { where: unknown },
      ];
      const [countArgs] = mockPrisma.alertEvent.count.mock.calls[0] as [
        { where: unknown },
      ];

      // Same object, not merely equal: a filter cannot be applied to the page
      // and forgotten on the total.
      expect(listArgs.where).toBe(countArgs.where);
    });

    it('scopes the detail lookup by id AND tenant in one predicate', async () => {
      await service.findOne(ALERT_ID, TENANT_A);

      expect(mockPrisma.alertEvent.findFirst).toHaveBeenCalledWith({
        where: { id: ALERT_ID, tenantId: TENANT_A },
        select: ALERT_EVENT_SELECTION,
      });
    });

    it('never looks an alert up by id alone', async () => {
      await service.findOne(ALERT_ID, TENANT_A);

      const findUnique = (
        mockPrisma.alertEvent as unknown as Record<string, unknown>
      ).findUnique;
      expect(findUnique).toBeUndefined();

      const [args] = mockPrisma.alertEvent.findFirst.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(Object.keys(args.where).sort()).toEqual(['id', 'tenantId']);
    });

    it('cannot be widened by a caller-supplied tenant-like value', () => {
      // The DTO has no tenant property at all, so even an object carrying one
      // contributes nothing to the predicate.
      const rogue = Object.assign(new QueryAlertEventsDto(), {
        tenantId: TENANT_B,
        userId: 'cuseraaaaaaaaaaaaaaaaaaaaa',
      }) as QueryAlertEventsDto;

      const where = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(rogue),
      );

      expect(where.tenantId).toBe(TENANT_A);
      expect(where).not.toHaveProperty('userId');
    });
  });

  describe('ordering', () => {
    it('orders by observedAt desc then id desc, in the database', async () => {
      await service.findAll(query(), TENANT_A);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { orderBy: unknown },
      ];
      expect(args.orderBy).toEqual([{ observedAt: 'desc' }, { id: 'desc' }]);
    });

    it('declares the same total order it reports in meta.sort', async () => {
      const result = await service.findAll(query(), TENANT_A);

      expect(result.meta.sort).toEqual({
        sortBy: 'observedAt',
        sortOrder: 'desc',
        tieBreaker: 'id',
      });
      expect(ALERT_EVENT_ORDER_BY).toEqual([
        { [result.meta.sort.sortBy]: result.meta.sort.sortOrder },
        { [result.meta.sort.tieBreaker]: result.meta.sort.sortOrder },
      ]);
    });
  });

  describe('filters', () => {
    it('applies no filter beyond tenant when none is supplied', () => {
      const where = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(query()),
      );
      expect(where).toEqual({ tenantId: TENANT_A });
    });

    it('composes every filter conjunctively with tenant scope', () => {
      const where = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(
          query({
            transition: 'ENTER',
            trackedDeviceId: DEVICE_ID,
            geofenceId: GEOFENCE_ID,
            sourceLocationEventId: EVENT_ID,
            observedFrom: '2026-09-09T06:00:00.000Z',
            observedBefore: '2026-09-09T07:00:00.000Z',
          }),
        ),
      );

      // A flat object is an AND in Prisma; there is no OR, NOT or nested
      // boolean anywhere in the predicate.
      expect(where).toEqual({
        tenantId: TENANT_A,
        transition: 'ENTER',
        trackedDeviceId: DEVICE_ID,
        geofenceId: GEOFENCE_ID,
        sourceLocationEventId: EVENT_ID,
        observedAt: {
          gte: new Date('2026-09-09T06:00:00.000Z'),
          lt: new Date('2026-09-09T07:00:00.000Z'),
        },
      });
    });

    it('treats the lower time bound as inclusive and the upper as exclusive', () => {
      const where = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(
          query({ observedFrom: '2026-09-09T06:00:00.000Z' }),
        ),
      );
      expect(where.observedAt).toEqual({
        gte: new Date('2026-09-09T06:00:00.000Z'),
      });

      const upper = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(
          query({ observedBefore: '2026-09-09T07:00:00.000Z' }),
        ),
      );
      expect(upper.observedAt).toEqual({
        lt: new Date('2026-09-09T07:00:00.000Z'),
      });
    });

    it('bounds the observation instant and never the recording instant', () => {
      const where = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(
          query({
            observedFrom: '2026-09-09T06:00:00.000Z',
            observedBefore: '2026-09-09T07:00:00.000Z',
          }),
        ),
      );

      expect(where).toHaveProperty('observedAt');
      expect(where).not.toHaveProperty('createdAt');
    });

    it('preserves the exact instant of an offset timestamp', () => {
      const where = buildAlertEventWhere(
        TENANT_A,
        resolveAlertEventFilters(
          query({ observedFrom: '2026-09-09T01:00:00.000-05:00' }),
        ),
      );

      expect(where.observedAt).toEqual({
        gte: new Date('2026-09-09T06:00:00.000Z'),
      });
    });

    it('echoes the applied filters, with null for the absent ones', async () => {
      const result = await service.findAll(
        query({ transition: 'EXIT', geofenceId: GEOFENCE_ID }),
        TENANT_A,
      );

      expect(result.meta.filters).toEqual({
        transition: 'EXIT',
        trackedDeviceId: null,
        geofenceId: GEOFENCE_ID,
        sourceLocationEventId: null,
        observedFrom: null,
        observedBefore: null,
      });
    });
  });

  describe('pagination', () => {
    it('defaults to page 1 and limit 10', async () => {
      const result = await service.findAll(query(), TENANT_A);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { skip: number; take: number },
      ];
      expect(args).toMatchObject({ skip: 0, take: 10 });
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
    });

    it('translates page and limit into skip and take', async () => {
      await service.findAll(query({ page: 4, limit: 25 }), TENANT_A);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { skip: number; take: number },
      ];
      expect(args).toMatchObject({ skip: 75, take: 25 });
    });

    it('reports zero metadata for a tenant with no alerts', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([]);
      mockPrisma.alertEvent.count.mockResolvedValue(0);

      const result = await service.findAll(query(), TENANT_A);

      expect(result.data).toEqual([]);
      expect(result.meta).toMatchObject({
        total: 0,
        count: 0,
        page: 1,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('reports one full page as one page with no next', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([storedRow]);
      mockPrisma.alertEvent.count.mockResolvedValue(1);

      const result = await service.findAll(query({ limit: 1 }), TENANT_A);

      expect(result.meta).toMatchObject({
        total: 1,
        count: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('reports an exact final page without claiming another follows', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([storedRow, storedRow]);
      mockPrisma.alertEvent.count.mockResolvedValue(4);

      const result = await service.findAll(
        query({ page: 2, limit: 2 }),
        TENANT_A,
      );

      expect(result.meta).toMatchObject({
        total: 4,
        count: 2,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });

    it('reports a partial final page by count, not by limit', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([storedRow]);
      mockPrisma.alertEvent.count.mockResolvedValue(5);

      const result = await service.findAll(
        query({ page: 3, limit: 2 }),
        TENANT_A,
      );

      expect(result.meta).toMatchObject({
        total: 5,
        count: 1,
        limit: 2,
        totalPages: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });

    it('answers a page past the end with an empty collection, not a 404', async () => {
      mockPrisma.alertEvent.findMany.mockResolvedValue([]);
      mockPrisma.alertEvent.count.mockResolvedValue(3);

      const result = await service.findAll(
        query({ page: 99, limit: 10 }),
        TENANT_A,
      );

      expect(result.data).toEqual([]);
      expect(result.meta).toMatchObject({
        total: 3,
        count: 0,
        page: 99,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });
  });

  describe('response mapping', () => {
    it('selects exactly the eight published columns', async () => {
      await service.findAll(query(), TENANT_A);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      expect(args.select).toEqual(ALERT_EVENT_SELECTION);
      expect(Object.keys(args.select).sort()).toEqual([
        'createdAt',
        'geofenceId',
        'id',
        'observedAt',
        'sourceLocationEventId',
        'tenantId',
        'trackedDeviceId',
        'transition',
      ]);
    });

    it('never selects an unwritten legacy or workflow column', async () => {
      await service.findAll(query(), TENANT_A);

      const [args] = mockPrisma.alertEvent.findMany.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      for (const column of [
        'severity',
        'status',
        'eventType',
        'message',
        'source',
        'latitude',
        'longitude',
        'updatedAt',
      ]) {
        expect(args.select).not.toHaveProperty(column);
      }
    });

    it('drops any column a widened selection would have returned', () => {
      // If the select were ever relaxed, the explicit mapper is the second
      // barrier: it copies named fields and cannot pass an extra one through.
      const contaminated = {
        ...storedRow,
        status: 'ACKNOWLEDGED',
        severity: 'CRITICAL',
        message: 'internal note',
        updatedAt: new Date(),
      } as unknown as AlertEventRow;

      const mapped = toAlertEventResponse(contaminated);

      expect(Object.keys(mapped).sort()).toEqual([
        'createdAt',
        'geofenceId',
        'id',
        'observedAt',
        'sourceLocationEventId',
        'tenantId',
        'trackedDeviceId',
        'transition',
      ]);
    });

    it('maps a list item and the detail response identically', async () => {
      const list = await service.findAll(query(), TENANT_A);
      const detail = await service.findOne(ALERT_ID, TENANT_A);

      expect(list.data).toHaveLength(1);
      expect(list.data[0]).toEqual(detail);
    });

    it('refuses to publish a row whose transition is not a crossing', () => {
      const notACrossing = {
        ...storedRow,
        transition: 'STAY_INSIDE',
      } as unknown as AlertEventRow;

      expect(() => toAlertEventResponse(notACrossing)).toThrow();
    });
  });

  describe('detail not-found policy', () => {
    it('raises 404 when the tenant owns no such alert', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);

      await expect(service.findOne(ALERT_ID, TENANT_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports a foreign alert exactly as it reports a missing one', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);
      const foreign = await service
        .findOne(ALERT_ID, TENANT_B)
        .catch((error: NotFoundException) => error);

      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);
      const missing = await service
        .findOne(ALERT_ID, TENANT_A)
        .catch((error: NotFoundException) => error);

      expect((foreign as NotFoundException).getStatus()).toBe(
        (missing as NotFoundException).getStatus(),
      );
      expect((foreign as NotFoundException).message).toBe(
        (missing as NotFoundException).message,
      );
    });

    it('does not name the tenant in the not-found message', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);

      const error = (await service
        .findOne(ALERT_ID, TENANT_A)
        .catch((caught: NotFoundException) => caught)) as NotFoundException;

      expect(error.message).not.toContain(TENANT_A);
    });
  });

  describe('read-only', () => {
    it('performs no write while listing', async () => {
      await service.findAll(
        query({ transition: 'ENTER', page: 2, limit: 5 }),
        TENANT_A,
      );
      expectNoWrites();
    });

    it('performs no write while retrieving one alert', async () => {
      await service.findOne(ALERT_ID, TENANT_A);
      expectNoWrites();
    });

    it('performs no write when the alert is not found', async () => {
      mockPrisma.alertEvent.findFirst.mockResolvedValue(null);
      await expect(service.findOne(ALERT_ID, TENANT_A)).rejects.toThrow();
      expectNoWrites();
    });

    it('returns identical data for a repeated read of unchanged state', async () => {
      const first = await service.findAll(query(), TENANT_A);
      const second = await service.findAll(query(), TENANT_A);

      expect(second).toEqual(first);
    });
  });
});
