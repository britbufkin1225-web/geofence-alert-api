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
});
