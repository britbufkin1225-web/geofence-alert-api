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
