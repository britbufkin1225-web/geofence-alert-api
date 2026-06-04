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
});
