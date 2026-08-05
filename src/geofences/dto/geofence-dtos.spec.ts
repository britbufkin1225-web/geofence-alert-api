import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateGeofenceDto } from './create-geofence.dto';
import {
  GEOFENCE_NAME_MAX_LENGTH,
  GEOFENCE_RADIUS_MAX_METERS,
  PAGINATION_MAX_LIMIT,
} from './geofence.constants';
import { QueryGeofencesDto } from './query-geofences.dto';
import { UpdateGeofenceDto } from './update-geofence.dto';

/**
 * These specs exercise the DTO validation rules the same way the global
 * ValidationPipe does: transform the plain input, then validate. They cover
 * every new bound (names, coordinates, radius, pagination) without any HTTP
 * server or database.
 */

async function validationErrors<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance as object);
  return errors.map((error) => error.property);
}

const validCreate = {
  name: 'Warehouse Zone',
  latitude: 30.2672,
  longitude: -97.7431,
  radiusMeters: 100,
};

describe('CreateGeofenceDto', () => {
  it('accepts a valid payload', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, validCreate),
    ).resolves.toEqual([]);
  });

  it('trims the name and rejects whitespace-only names', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, name: '   ' }),
    ).resolves.toContain('name');
  });

  it('rejects an empty name', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, name: '' }),
    ).resolves.toContain('name');
  });

  it('rejects an overlong name', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, {
        ...validCreate,
        name: 'a'.repeat(GEOFENCE_NAME_MAX_LENGTH + 1),
      }),
    ).resolves.toContain('name');
  });

  it('accepts the exact latitude boundaries', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, latitude: 90 }),
    ).resolves.toEqual([]);
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, latitude: -90 }),
    ).resolves.toEqual([]);
  });

  it('rejects out-of-range latitude', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, latitude: 90.1 }),
    ).resolves.toContain('latitude');
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, latitude: -91 }),
    ).resolves.toContain('latitude');
  });

  it('accepts the exact longitude boundaries', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, longitude: 180 }),
    ).resolves.toEqual([]);
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, longitude: -180 }),
    ).resolves.toEqual([]);
  });

  it('rejects out-of-range longitude', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, longitude: 181 }),
    ).resolves.toContain('longitude');
  });

  it('accepts the radius minimum and maximum boundaries', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, radiusMeters: 1 }),
    ).resolves.toEqual([]);
    await expect(
      validationErrors(CreateGeofenceDto, {
        ...validCreate,
        radiusMeters: GEOFENCE_RADIUS_MAX_METERS,
      }),
    ).resolves.toEqual([]);
  });

  it('rejects zero, negative and excessive radius', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, radiusMeters: 0 }),
    ).resolves.toContain('radiusMeters');
    await expect(
      validationErrors(CreateGeofenceDto, { ...validCreate, radiusMeters: -5 }),
    ).resolves.toContain('radiusMeters');
    await expect(
      validationErrors(CreateGeofenceDto, {
        ...validCreate,
        radiusMeters: GEOFENCE_RADIUS_MAX_METERS + 1,
      }),
    ).resolves.toContain('radiusMeters');
  });

  it('rejects a numeric string for radius (no implicit coercion)', async () => {
    await expect(
      validationErrors(CreateGeofenceDto, {
        ...validCreate,
        radiusMeters: '100',
      }),
    ).resolves.toContain('radiusMeters');
  });
});

describe('UpdateGeofenceDto', () => {
  it('accepts a valid partial update', async () => {
    await expect(
      validationErrors(UpdateGeofenceDto, { name: 'Renamed Zone' }),
    ).resolves.toEqual([]);
  });

  it('rejects an empty body', async () => {
    const errors = await validate(plainToInstance(UpdateGeofenceDto, {}));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a whitespace-only name', async () => {
    await expect(
      validationErrors(UpdateGeofenceDto, { name: '   ' }),
    ).resolves.toContain('name');
  });

  it('keeps omitted fields undefined for a partial update', () => {
    const instance = plainToInstance(UpdateGeofenceDto, { isActive: false });
    expect(instance.name).toBeUndefined();
    expect(instance.radiusMeters).toBeUndefined();
    expect(instance.isActive).toBe(false);
  });
});

describe('QueryGeofencesDto', () => {
  it('applies defaults when nothing is provided', () => {
    const instance = plainToInstance(QueryGeofencesDto, {});
    expect(instance.page).toBe(1);
    expect(instance.limit).toBe(10);
  });

  it('accepts the maximum limit boundary', async () => {
    await expect(
      validationErrors(QueryGeofencesDto, {
        limit: String(PAGINATION_MAX_LIMIT),
      }),
    ).resolves.toEqual([]);
  });

  it('rejects a limit above the maximum', async () => {
    await expect(
      validationErrors(QueryGeofencesDto, {
        limit: String(PAGINATION_MAX_LIMIT + 1),
      }),
    ).resolves.toContain('limit');
  });

  it('rejects zero, negative, fractional and malformed pagination values', async () => {
    await expect(
      validationErrors(QueryGeofencesDto, { limit: '0' }),
    ).resolves.toContain('limit');
    await expect(
      validationErrors(QueryGeofencesDto, { page: '-1' }),
    ).resolves.toContain('page');
    await expect(
      validationErrors(QueryGeofencesDto, { limit: '2.5' }),
    ).resolves.toContain('limit');
    await expect(
      validationErrors(QueryGeofencesDto, { limit: 'abc' }),
    ).resolves.toContain('limit');
  });

  it('rejects an overlong search term', async () => {
    await expect(
      validationErrors(QueryGeofencesDto, { search: 'a'.repeat(101) }),
    ).resolves.toContain('search');
  });
});
