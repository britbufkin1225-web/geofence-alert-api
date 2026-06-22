import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { QueryGeofencesDto } from './dto/query-geofences.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';
import { GeofencesController } from './geofences.controller';
import { GeofencesService } from './geofences.service';

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
    it('should create a geofence', async () => {
      const createGeofenceDto: CreateGeofenceDto = {
        name: 'Test Geofence',
        description: 'Test geofence description',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 10,
        isActive: true,
      };

      mockGeofencesService.create.mockResolvedValue(mockGeofence);

      await expect(controller.create(createGeofenceDto)).resolves.toEqual(
        mockGeofence,
      );

      expect(mockGeofencesService.create).toHaveBeenCalledWith(
        createGeofenceDto,
      );
      expect(mockGeofencesService.create).toHaveBeenCalledTimes(1);
    });

    it('should throw an error when create fails', async () => {
      const createGeofenceDto: CreateGeofenceDto = {
        name: 'Test Geofence',
        latitude: 30.2672,
        longitude: -97.7431,
        radiusMeters: 100,
        isActive: true,
      };

      mockGeofencesService.create.mockRejectedValue(
        new Error('Failed to create geofence'),
      );

      await expect(controller.create(createGeofenceDto)).rejects.toThrow(
        'Failed to create geofence',
      );

      expect(mockGeofencesService.create).toHaveBeenCalledWith(
        createGeofenceDto,
      );
      expect(mockGeofencesService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('findAll', () => {
    it('should return geofences using query filters', async () => {
      const query: QueryGeofencesDto = {
        page: 1,
        limit: 10,
        active: true,
      };

      const result = {
        data: [mockGeofence],
        meta: {
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
        },
      };

      mockGeofencesService.findAll.mockResolvedValue(result);

      await expect(controller.findAll(query)).resolves.toEqual(result);

      expect(mockGeofencesService.findAll).toHaveBeenCalledWith(query);
      expect(mockGeofencesService.findAll).toHaveBeenCalledTimes(1);
    });
  });

  it('should throw an error when findAll fails', async () => {
    const query: QueryGeofencesDto = {
      page: 1,
      limit: 10,
      active: true,
    };

    mockGeofencesService.findAll.mockRejectedValue(
      new Error('Failed to fetch geofences'),
    );

    await expect(controller.findAll(query)).rejects.toThrow(
      'Failed to fetch geofences',
    );

    expect(mockGeofencesService.findAll).toHaveBeenCalledWith(query);
    expect(mockGeofencesService.findAll).toHaveBeenCalledTimes(1);
  });
  describe('findOne', () => {
    it('should return one geofence by id', async () => {
      mockGeofencesService.findOne.mockResolvedValue(mockGeofence);

      await expect(controller.findOne('test-geofence-id')).resolves.toEqual(
        mockGeofence,
      );

      expect(mockGeofencesService.findOne).toHaveBeenCalledWith(
        'test-geofence-id',
      );
      expect(mockGeofencesService.findOne).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when findOne does not find a geofence', async () => {
      const geofenceId = 'missing-geofence-id';

      mockGeofencesService.findOne.mockRejectedValue(
        new NotFoundException(`Geofence with id ${geofenceId} not found`),
      );

      await expect(controller.findOne(geofenceId)).rejects.toThrow(
        NotFoundException,
      );

      expect(mockGeofencesService.findOne).toHaveBeenCalledWith(geofenceId);
      expect(mockGeofencesService.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('should update a geofence by id', async () => {
      const updateGeofenceDto: UpdateGeofenceDto = {
        name: 'Updated Geofence',
        isActive: false,
      };

      const updatedGeofence = {
        ...mockGeofence,
        ...updateGeofenceDto,
      };

      mockGeofencesService.update.mockResolvedValue(updatedGeofence);

      await expect(
        controller.update('test-geofence-id', updateGeofenceDto),
      ).resolves.toEqual(updatedGeofence);

      expect(mockGeofencesService.update).toHaveBeenCalledWith(
        'test-geofence-id',
        updateGeofenceDto,
      );
      expect(mockGeofencesService.update).toHaveBeenCalledTimes(1);
    });

    it('should throw an error when update fails', async () => {
      const geofenceId = 'test-geofence-id';

      const updateGeofenceDto: UpdateGeofenceDto = {
        name: 'Updated Test Geofence',
        isActive: false,
      };

      mockGeofencesService.update.mockRejectedValue(
        new Error('Failed to update geofence'),
      );

      await expect(
        controller.update(geofenceId, updateGeofenceDto),
      ).rejects.toThrow('Failed to update geofence');

      expect(mockGeofencesService.update).toHaveBeenCalledWith(
        geofenceId,
        updateGeofenceDto,
      );
      expect(mockGeofencesService.update).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when update does not find a geofence', async () => {
      const geofenceId = 'missing-geofence-id';

      const updateGeofenceDto: UpdateGeofenceDto = {
        name: 'Updated Test Geofence',
      };

      mockGeofencesService.update.mockRejectedValue(
        new NotFoundException(`Geofence with id ${geofenceId} not found`),
      );

      await expect(
        controller.update(geofenceId, updateGeofenceDto),
      ).rejects.toThrow(NotFoundException);

      expect(mockGeofencesService.update).toHaveBeenCalledWith(
        geofenceId,
        updateGeofenceDto,
      );
      expect(mockGeofencesService.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove', () => {
    it('should remove a geofence by id', async () => {
      mockGeofencesService.remove.mockResolvedValue(mockGeofence);

      await expect(controller.remove('test-geofence-id')).resolves.toEqual(
        mockGeofence,
      );

      expect(mockGeofencesService.remove).toHaveBeenCalledWith(
        'test-geofence-id',
      );
      expect(mockGeofencesService.remove).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when remove does not find a geofence', async () => {
      const geofenceId = 'missing-geofence-id';

      mockGeofencesService.remove.mockRejectedValue(
        new NotFoundException(`Geofence with id ${geofenceId} not found`),
      );

      await expect(controller.remove(geofenceId)).rejects.toThrow(
        NotFoundException,
      );

      expect(mockGeofencesService.remove).toHaveBeenCalledWith(geofenceId);
      expect(mockGeofencesService.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSummary', () => {
    it('should return a geofence summary', async () => {
      const summary = {
        total: 3,
        active: 2,
        inactive: 1,
      };

      mockGeofencesService.getSummary.mockResolvedValue(summary);

      await expect(controller.getSummary()).resolves.toEqual(summary);

      expect(mockGeofencesService.getSummary).toHaveBeenCalledTimes(1);
    });

    it('should throw an error when getSummary fails', async () => {
      mockGeofencesService.getSummary.mockRejectedValue(
        new Error('Failed to fetch geofence summary'),
      );

      await expect(controller.getSummary()).rejects.toThrow(
        'Failed to fetch geofence summary',
      );

      expect(mockGeofencesService.getSummary).toHaveBeenCalledTimes(1);
    });
  });
});
