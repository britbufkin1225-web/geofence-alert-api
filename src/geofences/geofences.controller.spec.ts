import { Test, TestingModule } from '@nestjs/testing';

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

  describe('getSummary', () => {
    it('should return geofence summary data', async () => {
      const summary = {
        total: 3,
        active: 2,
        inactive: 1,
        radius: {
          min: 100,
          max: 500,
          average: 300,
        },
      };

      mockGeofencesService.getSummary.mockResolvedValue(summary);

      const result = await controller.getSummary();

      expect(result).toEqual(summary);
      expect(mockGeofencesService.getSummary).toHaveBeenCalledTimes(1);
    });
  });
});
