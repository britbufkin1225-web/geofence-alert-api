import { Test, TestingModule } from '@nestjs/testing';
import { GeofencesService } from './geofences.service';

describe('GeofencesService', () => {
  let service: GeofencesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GeofencesService],
    }).compile();

    service = module.get<GeofencesService>(GeofencesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
