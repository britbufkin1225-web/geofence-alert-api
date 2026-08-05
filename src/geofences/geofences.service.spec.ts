import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { GeofencesService } from './geofences.service';

const TENANT_A = 'ctenantaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'ctenantbbbbbbbbbbbbbbbbbb';

describe('GeofencesService', () => {
  let service: GeofencesService;

  const mockPrismaService = {
    geofence: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeofencesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<GeofencesService>(GeofencesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('sets tenant ownership server-side and never from the DTO', async () => {
      const createGeofenceDto = {
        name: 'Test Zone',
        description: 'Test geofence area',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
      };

      const createdGeofence = {
        id: 'geofence-1',
        tenantId: TENANT_A,
        ...createGeofenceDto,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.create.mockResolvedValue(createdGeofence);

      await expect(
        service.create(createGeofenceDto, TENANT_A),
      ).resolves.toEqual(createdGeofence);

      expect(mockPrismaService.geofence.create).toHaveBeenCalledWith({
        data: {
          ...createGeofenceDto,
          tenant: { connect: { id: TENANT_A } },
        },
      });
    });
  });

  describe('findAll', () => {
    it('always scopes the query by tenant', async () => {
      const geofences = [
        {
          id: 'geofence-1',
          tenantId: TENANT_A,
          name: 'Test Zone 1',
          description: 'First test geofence',
          latitude: 30.2672,
          longitude: -97.7431,
          radiusMeters: 100,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaService.$transaction.mockResolvedValue([geofences, 1]);

      const result = await service.findAll({}, TENANT_A);

      expect(result.data).toEqual(geofences);
      expect(result.meta.total).toBe(1);

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT_A },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT_A },
      });
    });

    it('combines tenant scope with active and search filters', async () => {
      mockPrismaService.$transaction.mockResolvedValue([[], 0]);

      await service.findAll({ active: true, search: 'Warehouse' }, TENANT_B);

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_B,
          isActive: true,
          name: { contains: 'Warehouse' },
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_B,
          isActive: true,
          name: { contains: 'Warehouse' },
        },
      });
    });

    it('applies pagination while keeping the tenant predicate', async () => {
      mockPrismaService.$transaction.mockResolvedValue([[], 11]);

      const result = await service.findAll({ page: 2, limit: 5 }, TENANT_A);

      expect(result.meta).toEqual(
        expect.objectContaining({
          total: 11,
          page: 2,
          limit: 5,
          totalPages: 3,
          hasNextPage: true,
          hasPreviousPage: true,
        }),
      );

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT_A },
        skip: 5,
        take: 5,
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findOne', () => {
    it('scopes the lookup by id AND tenant', async () => {
      const geofence = {
        id: 'geofence-1',
        tenantId: TENANT_A,
        name: 'Test Zone',
        description: 'Test geofence area',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.findFirst.mockResolvedValue(geofence);

      const result = await service.findOne('geofence-1', TENANT_A);

      expect(result).toEqual(geofence);
      expect(mockPrismaService.geofence.findFirst).toHaveBeenCalledWith({
        where: { id: 'geofence-1', tenantId: TENANT_A },
      });
    });

    it('throws NotFound when the id belongs to another tenant (no cross-tenant read)', async () => {
      // The tenant-scoped predicate returns null for a foreign-owned id.
      mockPrismaService.geofence.findFirst.mockResolvedValue(null);

      await expect(
        service.findOne('geofence-owned-by-B', TENANT_A),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrismaService.geofence.findFirst).toHaveBeenCalledWith({
        where: { id: 'geofence-owned-by-B', tenantId: TENANT_A },
      });
    });
  });

  describe('update', () => {
    it('verifies tenant ownership before updating by id', async () => {
      const existing = {
        id: 'geofence-1',
        tenantId: TENANT_A,
        name: 'Old Zone',
        description: 'Old description',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const dto = { name: 'Updated Zone', radiusMeters: 250 };
      const updated = { ...existing, ...dto, updatedAt: new Date() };

      mockPrismaService.geofence.findFirst.mockResolvedValue(existing);
      mockPrismaService.geofence.update.mockResolvedValue(updated);

      const result = await service.update('geofence-1', dto, TENANT_A);

      expect(result).toEqual(updated);
      expect(mockPrismaService.geofence.findFirst).toHaveBeenCalledWith({
        where: { id: 'geofence-1', tenantId: TENANT_A },
      });
      // Ownership is never part of the update payload.
      expect(mockPrismaService.geofence.update).toHaveBeenCalledWith({
        where: { id: 'geofence-1', tenantId: TENANT_A },
        data: dto,
      });
    });

    it('does not update a geofence owned by another tenant', async () => {
      mockPrismaService.geofence.findFirst.mockResolvedValue(null);

      await expect(
        service.update('geofence-owned-by-B', { name: 'x' }, TENANT_A),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrismaService.geofence.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('verifies tenant ownership before deleting by id', async () => {
      const existing = {
        id: 'geofence-1',
        tenantId: TENANT_A,
        name: 'Delete Zone',
        description: 'Geofence to delete',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.findFirst.mockResolvedValue(existing);
      mockPrismaService.geofence.delete.mockResolvedValue(existing);

      const result = await service.remove('geofence-1', TENANT_A);

      expect(result).toEqual(existing);
      expect(mockPrismaService.geofence.findFirst).toHaveBeenCalledWith({
        where: { id: 'geofence-1', tenantId: TENANT_A },
      });
      expect(mockPrismaService.geofence.delete).toHaveBeenCalledWith({
        where: { id: 'geofence-1', tenantId: TENANT_A },
      });
    });

    it('does not delete a geofence owned by another tenant', async () => {
      mockPrismaService.geofence.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('geofence-owned-by-B', TENANT_A),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrismaService.geofence.delete).not.toHaveBeenCalled();
    });
  });

  describe('getSummary', () => {
    it('scopes every count/aggregate by tenant', async () => {
      mockPrismaService.geofence.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);

      mockPrismaService.geofence.aggregate.mockResolvedValue({
        _min: { radiusMeters: 100 },
        _max: { radiusMeters: 500 },
        _avg: { radiusMeters: 300 },
      });

      const result = await service.getSummary(TENANT_A);

      expect(result).toEqual({
        total: 3,
        active: 2,
        inactive: 1,
        radius: { min: 100, max: 500, average: 300 },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenNthCalledWith(1, {
        where: { tenantId: TENANT_A },
      });
      expect(mockPrismaService.geofence.count).toHaveBeenNthCalledWith(2, {
        where: { tenantId: TENANT_A, isActive: true },
      });
      expect(mockPrismaService.geofence.count).toHaveBeenNthCalledWith(3, {
        where: { tenantId: TENANT_A, isActive: false },
      });
      expect(mockPrismaService.geofence.aggregate).toHaveBeenCalledWith({
        where: { tenantId: TENANT_A },
        _min: { radiusMeters: true },
        _max: { radiusMeters: true },
        _avg: { radiusMeters: true },
      });
    });

    it('returns fallback radius values when the tenant has no geofences', async () => {
      mockPrismaService.geofence.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      mockPrismaService.geofence.aggregate.mockResolvedValue({
        _min: { radiusMeters: null },
        _max: { radiusMeters: null },
        _avg: { radiusMeters: null },
      });

      const result = await service.getSummary(TENANT_A);

      expect(result).toEqual({
        total: 0,
        active: 0,
        inactive: 0,
        radius: { min: 0, max: 0, average: 0 },
      });
    });
  });
});
