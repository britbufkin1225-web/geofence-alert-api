import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { GeofencesService } from './geofences.service';

describe('GeofencesService', () => {
  let service: GeofencesService;

  const mockPrismaService = {
    geofence: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
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
    it('should create a geofence', async () => {
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
        ...createGeofenceDto,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.create.mockResolvedValue(createdGeofence);

      await expect(service.create(createGeofenceDto)).resolves.toEqual(
        createdGeofence,
      );

      expect(mockPrismaService.geofence.create).toHaveBeenCalledWith({
        data: createGeofenceDto,
      });
    });
  });

  describe('findAll', () => {
    it('should return paginated geofences with default query values', async () => {
      const geofences = [
        {
          id: 'geofence-1',
          name: 'Test Zone 1',
          description: 'First test geofence',
          latitude: 30.2672,
          longitude: -97.7431,
          radiusMeters: 100,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'geofence-2',
          name: 'Test Zone 2',
          description: 'Second test geofence',
          latitude: 30.2673,
          longitude: -97.7432,
          radiusMeters: 200,
          isActive: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaService.geofence.findMany.mockResolvedValue(geofences);
      mockPrismaService.geofence.count.mockResolvedValue(2);
      mockPrismaService.$transaction.mockResolvedValue([geofences, 2]);

      const result = await service.findAll({});

      expect(result).toEqual({
        data: geofences,
        meta: {
          total: 2,
          page: 1,
          limit: 10,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
          filters: {
            active: null,
            search: null,
          },
          sort: {
            sortBy: 'createdAt',
            sortOrder: 'desc',
          },
        },
      });

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 10,
        orderBy: {
          createdAt: 'desc',
        },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenCalledWith({
        where: {},
      });
    });

    it('should filter geofences by active status', async () => {
      const geofences = [
        {
          id: 'geofence-1',
          name: 'Active Zone',
          description: 'Active test geofence',
          latitude: 30.2672,
          longitude: -97.7431,
          radiusMeters: 100,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaService.geofence.findMany.mockResolvedValue(geofences);
      mockPrismaService.geofence.count.mockResolvedValue(1);
      mockPrismaService.$transaction.mockResolvedValue([geofences, 1]);

      const result = await service.findAll({
        active: true,
      });

      expect(result).toEqual({
        data: geofences,
        meta: {
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
          filters: {
            active: true,
            search: null,
          },
          sort: {
            sortBy: 'createdAt',
            sortOrder: 'desc',
          },
        },
      });

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledWith({
        where: {
          isActive: true,
        },
        skip: 0,
        take: 10,
        orderBy: {
          createdAt: 'desc',
        },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenCalledWith({
        where: {
          isActive: true,
        },
      });
    });

    it('should apply pagination values', async () => {
      const geofences = [
        {
          id: 'geofence-3',
          name: 'Paginated Zone',
          description: 'Paginated test geofence',
          latitude: 30.2674,
          longitude: -97.7433,
          radiusMeters: 300,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaService.geofence.findMany.mockResolvedValue(geofences);
      mockPrismaService.geofence.count.mockResolvedValue(11);
      mockPrismaService.$transaction.mockResolvedValue([geofences, 11]);

      const result = await service.findAll({
        page: 2,
        limit: 5,
      });

      expect(result).toEqual({
        data: geofences,
        meta: {
          total: 11,
          page: 2,
          limit: 5,
          totalPages: 3,
          hasNextPage: true,
          hasPreviousPage: true,
          filters: {
            active: null,
            search: null,
          },
          sort: {
            sortBy: 'createdAt',
            sortOrder: 'desc',
          },
        },
      });

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 5,
        take: 5,
        orderBy: {
          createdAt: 'desc',
        },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenCalledWith({
        where: {},
      });
    });

    it('should filter geofences by search term', async () => {
      const geofences = [
        {
          id: 'geofence-4',
          name: 'Warehouse Zone',
          description: 'Searchable geofence',
          latitude: 30.2675,
          longitude: -97.7434,
          radiusMeters: 400,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaService.geofence.findMany.mockResolvedValue(geofences);
      mockPrismaService.geofence.count.mockResolvedValue(1);
      mockPrismaService.$transaction.mockResolvedValue([geofences, 1]);

      const result = await service.findAll({
        search: 'Warehouse',
      });

      expect(result).toEqual({
        data: geofences,
        meta: {
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
          filters: {
            active: null,
            search: 'Warehouse',
          },
          sort: {
            sortBy: 'createdAt',
            sortOrder: 'desc',
          },
        },
      });

      expect(mockPrismaService.geofence.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.geofence.count).toHaveBeenCalledTimes(1);
    });
  });

  describe('findAll', () => {
    // your 4 findAll tests
  });

  describe('findOne', () => {
    it('should return a geofence when it exists', async () => {
      const geofence = {
        id: 'geofence-1',
        name: 'Test Zone',
        description: 'Test geofence area',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.findUnique.mockResolvedValue(geofence);

      const result = await service.findOne('geofence-1');

      expect(result).toEqual(geofence);

      expect(mockPrismaService.geofence.findUnique).toHaveBeenCalledWith({
        where: {
          id: 'geofence-1',
        },
      });
    });
  });

  it('should throw NotFoundException when geofence does not exist', async () => {
    mockPrismaService.geofence.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing-geofence')).rejects.toThrow(
      NotFoundException,
    );

    expect(mockPrismaService.geofence.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'missing-geofence',
      },
    });
  });

  describe('findOne', () => {
    // existing tests
  });

  describe('update', () => {
    // new tests go here
  });

  describe('getSummary', () => {
    // existing tests
  });

  describe('update', () => {
    it('should update a geofence when it exists', async () => {
      const existingGeofence = {
        id: 'geofence-1',
        name: 'Old Zone',
        description: 'Old description',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updateGeofenceDto = {
        name: 'Updated Zone',
        radiusMeters: 250,
      };

      const updatedGeofence = {
        ...existingGeofence,
        ...updateGeofenceDto,
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.findUnique.mockResolvedValue(existingGeofence);
      mockPrismaService.geofence.update.mockResolvedValue(updatedGeofence);

      const result = await service.update('geofence-1', updateGeofenceDto);

      expect(result).toEqual(updatedGeofence);

      expect(mockPrismaService.geofence.findUnique).toHaveBeenCalledWith({
        where: {
          id: 'geofence-1',
        },
      });

      expect(mockPrismaService.geofence.update).toHaveBeenCalledWith({
        where: {
          id: 'geofence-1',
        },
        data: updateGeofenceDto,
      });
    });
  });

  it('should throw NotFoundException when updating a missing geofence', async () => {
    mockPrismaService.geofence.findUnique.mockResolvedValue(null);

    await expect(
      service.update('missing-geofence', {
        name: 'Updated Zone',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(mockPrismaService.geofence.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'missing-geofence',
      },
    });

    expect(mockPrismaService.geofence.update).not.toHaveBeenCalled();
  });

  describe('remove', () => {
    it('should delete a geofence when it exists', async () => {
      const existingGeofence = {
        id: 'geofence-1',
        name: 'Delete Zone',
        description: 'Geofence to delete',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.geofence.findUnique.mockResolvedValue(existingGeofence);
      mockPrismaService.geofence.delete.mockResolvedValue(existingGeofence);

      const result = await service.remove('geofence-1');

      expect(result).toEqual(existingGeofence);

      expect(mockPrismaService.geofence.findUnique).toHaveBeenCalledWith({
        where: {
          id: 'geofence-1',
        },
      });

      expect(mockPrismaService.geofence.delete).toHaveBeenCalledWith({
        where: {
          id: 'geofence-1',
        },
      });
    });
  });

  it('should throw NotFoundException when deleting a missing geofence', async () => {
    mockPrismaService.geofence.findUnique.mockResolvedValue(null);

    await expect(service.remove('missing-geofence')).rejects.toThrow(
      NotFoundException,
    );

    expect(mockPrismaService.geofence.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'missing-geofence',
      },
    });

    expect(mockPrismaService.geofence.delete).not.toHaveBeenCalled();
  });

  describe('getSummary', () => {
    it('should return total, active, inactive, and radius summary values', async () => {
      mockPrismaService.geofence.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);

      mockPrismaService.geofence.aggregate.mockResolvedValue({
        _min: {
          radiusMeters: 100,
        },
        _max: {
          radiusMeters: 500,
        },
        _avg: {
          radiusMeters: 300,
        },
      });

      const result = await service.getSummary();

      expect(result).toEqual({
        total: 3,
        active: 2,
        inactive: 1,
        radius: {
          min: 100,
          max: 500,
          average: 300,
        },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenCalledTimes(3);

      expect(mockPrismaService.geofence.count).toHaveBeenNthCalledWith(1);

      expect(mockPrismaService.geofence.count).toHaveBeenNthCalledWith(2, {
        where: {
          isActive: true,
        },
      });

      expect(mockPrismaService.geofence.count).toHaveBeenNthCalledWith(3, {
        where: {
          isActive: false,
        },
      });

      expect(mockPrismaService.geofence.aggregate).toHaveBeenCalledWith({
        _min: {
          radiusMeters: true,
        },
        _max: {
          radiusMeters: true,
        },
        _avg: {
          radiusMeters: true,
        },
      });
    });

    it('should return fallback radius values when the database is empty', async () => {
      mockPrismaService.geofence.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      mockPrismaService.geofence.aggregate.mockResolvedValue({
        _min: {
          radiusMeters: null,
        },
        _max: {
          radiusMeters: null,
        },
        _avg: {
          radiusMeters: null,
        },
      });

      const result = await service.getSummary();

      expect(result).toEqual({
        total: 0,
        active: 0,
        inactive: 0,
        radius: {
          min: 0,
          max: 0,
          average: 0,
        },
      });
    });
  });
});
