import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import type { AuthenticatedPrincipal } from '../auth/principal';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { QueryGeofencesDto } from './dto/query-geofences.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';
import { GeofencesController } from './geofences.controller';
import { GeofencesService } from './geofences.service';

const principal: AuthenticatedPrincipal = {
  userId: 'cuseraaaaaaaaaaaaaaaaaaaa',
  tenantId: 'ctenantaaaaaaaaaaaaaaaaaa',
  membershipId: 'cmembaaaaaaaaaaaaaaaaaaaa',
};

describe('GeofencesController', () => {
  let controller: GeofencesController;

  const mockGeofencesService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    getSummary: jest.fn(),
  };

  const mockGeofence = {
    id: 'test-geofence-id',
    tenantId: principal.tenantId,
    name: 'Test Geofence',
    description: 'Test geofence description',
    latitude: 30.2672,
    longitude: -97.7431,
    radiusMeters: 10,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GeofencesController],
      providers: [
        {
          provide: GeofencesService,
          useValue: mockGeofencesService,
        },
      ],
    }).compile();

    controller = module.get<GeofencesController>(GeofencesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('passes the principal tenant to the service', async () => {
      const dto: CreateGeofenceDto = {
        name: 'Test Geofence',
        description: 'Test geofence description',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 10,
        isActive: true,
      };

      mockGeofencesService.create.mockResolvedValue(mockGeofence);

      await expect(controller.create(dto, principal)).resolves.toEqual(
        mockGeofence,
      );

      expect(mockGeofencesService.create).toHaveBeenCalledWith(
        dto,
        principal.tenantId,
      );
    });

    it('propagates errors from the service', async () => {
      const dto: CreateGeofenceDto = {
        name: 'Test Geofence',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
      };

      mockGeofencesService.create.mockRejectedValue(
        new Error('Failed to create geofence'),
      );

      await expect(controller.create(dto, principal)).rejects.toThrow(
        'Failed to create geofence',
      );
    });
  });

  describe('findAll', () => {
    it('passes query and tenant to the service', async () => {
      const query: QueryGeofencesDto = { page: 1, limit: 10, active: true };
      const result = { data: [mockGeofence], meta: { total: 1 } };

      mockGeofencesService.findAll.mockResolvedValue(result);

      await expect(controller.findAll(query, principal)).resolves.toEqual(
        result,
      );

      expect(mockGeofencesService.findAll).toHaveBeenCalledWith(
        query,
        principal.tenantId,
      );
    });
  });

  describe('findOne', () => {
    it('passes id and tenant to the service', async () => {
      mockGeofencesService.findOne.mockResolvedValue(mockGeofence);

      await expect(
        controller.findOne('test-geofence-id', principal),
      ).resolves.toEqual(mockGeofence);

      expect(mockGeofencesService.findOne).toHaveBeenCalledWith(
        'test-geofence-id',
        principal.tenantId,
      );
    });

    it('surfaces NotFoundException (cross-tenant or missing)', async () => {
      mockGeofencesService.findOne.mockRejectedValue(
        new NotFoundException('Geofence with id x not found'),
      );

      await expect(
        controller.findOne('missing-geofence-id', principal),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('passes id, dto and tenant to the service', async () => {
      const dto: UpdateGeofenceDto = {
        name: 'Updated Geofence',
        isActive: false,
      };
      const updated = { ...mockGeofence, ...dto };

      mockGeofencesService.update.mockResolvedValue(updated);

      await expect(
        controller.update('test-geofence-id', dto, principal),
      ).resolves.toEqual(updated);

      expect(mockGeofencesService.update).toHaveBeenCalledWith(
        'test-geofence-id',
        dto,
        principal.tenantId,
      );
    });

    it('surfaces NotFoundException (cross-tenant or missing)', async () => {
      mockGeofencesService.update.mockRejectedValue(
        new NotFoundException('Geofence with id x not found'),
      );

      await expect(
        controller.update('missing-geofence-id', { name: 'x' }, principal),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('passes id and tenant to the service', async () => {
      mockGeofencesService.remove.mockResolvedValue(mockGeofence);

      await expect(
        controller.remove('test-geofence-id', principal),
      ).resolves.toEqual(mockGeofence);

      expect(mockGeofencesService.remove).toHaveBeenCalledWith(
        'test-geofence-id',
        principal.tenantId,
      );
    });

    it('surfaces NotFoundException (cross-tenant or missing)', async () => {
      mockGeofencesService.remove.mockRejectedValue(
        new NotFoundException('Geofence with id x not found'),
      );

      await expect(
        controller.remove('missing-geofence-id', principal),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSummary', () => {
    it('passes the tenant to the service', async () => {
      const summary = { total: 3, active: 2, inactive: 1 };

      mockGeofencesService.getSummary.mockResolvedValue(summary);

      await expect(controller.getSummary(principal)).resolves.toEqual(summary);

      expect(mockGeofencesService.getSummary).toHaveBeenCalledWith(
        principal.tenantId,
      );
    });
  });
});
