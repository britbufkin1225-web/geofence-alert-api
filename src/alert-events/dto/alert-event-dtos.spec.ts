import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  ALERT_EVENT_PAGINATION_DEFAULT_LIMIT,
  ALERT_EVENT_PAGINATION_DEFAULT_PAGE,
  ALERT_EVENT_PAGINATION_MAX_LIMIT,
} from './alert-event.constants';
import { QueryAlertEventsDto } from './query-alert-events.dto';

/**
 * Exercises the alert-event query DTO exactly the way the global ValidationPipe
 * does — transform the plain input, then validate — so every bound below is the
 * bound a real request meets. No HTTP server and no database.
 *
 * Express hands repeated query parameters over as arrays and everything else as
 * strings, so the inputs here are strings and arrays rather than numbers.
 */

async function failingProperties(
  plain: Record<string, unknown>,
): Promise<string[]> {
  const instance = plainToInstance(QueryAlertEventsDto, plain);
  const errors = await validate(instance as object);
  return errors.map((error) => error.property);
}

function transform(plain: Record<string, unknown>): QueryAlertEventsDto {
  return plainToInstance(QueryAlertEventsDto, plain);
}

const CUID = 'cdeviceaaaaaaaaaaaaaaaaaa';

describe('QueryAlertEventsDto', () => {
  describe('defaults', () => {
    it('accepts an empty query', async () => {
      await expect(failingProperties({})).resolves.toEqual([]);
    });

    it('defaults to the published page and limit', () => {
      const dto = transform({});
      expect(dto.page).toBe(ALERT_EVENT_PAGINATION_DEFAULT_PAGE);
      expect(dto.limit).toBe(ALERT_EVENT_PAGINATION_DEFAULT_LIMIT);
    });

    it('applies no filter by default', () => {
      const dto = transform({});
      expect(dto.transition).toBeUndefined();
      expect(dto.trackedDeviceId).toBeUndefined();
      expect(dto.geofenceId).toBeUndefined();
      expect(dto.sourceLocationEventId).toBeUndefined();
      expect(dto.observedFrom).toBeUndefined();
      expect(dto.observedBefore).toBeUndefined();
    });
  });

  describe('pagination', () => {
    it('accepts the minimum and the maximum limit', async () => {
      await expect(
        failingProperties({ page: '1', limit: '1' }),
      ).resolves.toEqual([]);
      await expect(
        failingProperties({ limit: String(ALERT_EVENT_PAGINATION_MAX_LIMIT) }),
      ).resolves.toEqual([]);
    });

    it('rejects a limit above the maximum rather than clamping it', async () => {
      const over = String(ALERT_EVENT_PAGINATION_MAX_LIMIT + 1);
      await expect(failingProperties({ limit: over })).resolves.toContain(
        'limit',
      );
      // And the value is not quietly rewritten to the maximum on the way past.
      expect(transform({ limit: over }).limit).toBe(
        ALERT_EVENT_PAGINATION_MAX_LIMIT + 1,
      );
    });

    it('rejects zero', async () => {
      await expect(failingProperties({ page: '0' })).resolves.toContain('page');
      await expect(failingProperties({ limit: '0' })).resolves.toContain(
        'limit',
      );
    });

    it('rejects a negative value', async () => {
      await expect(failingProperties({ page: '-1' })).resolves.toContain(
        'page',
      );
      await expect(failingProperties({ limit: '-5' })).resolves.toContain(
        'limit',
      );
    });

    it('rejects a fractional value', async () => {
      await expect(failingProperties({ page: '1.5' })).resolves.toContain(
        'page',
      );
      await expect(failingProperties({ limit: '2.7' })).resolves.toContain(
        'limit',
      );
    });

    it('rejects a non-numeric value', async () => {
      await expect(failingProperties({ page: 'abc' })).resolves.toContain(
        'page',
      );
      await expect(failingProperties({ limit: 'ten' })).resolves.toContain(
        'limit',
      );
    });

    it('rejects an empty value', async () => {
      await expect(failingProperties({ page: '' })).resolves.toContain('page');
    });

    it('rejects a repeated query parameter rather than picking one', async () => {
      // `?page=1&page=2` reaches the DTO as an array; it must not silently
      // resolve to either value.
      await expect(failingProperties({ page: ['1', '2'] })).resolves.toContain(
        'page',
      );
      await expect(
        failingProperties({ limit: ['10', '100'] }),
      ).resolves.toContain('limit');
    });
  });

  describe('transition filter', () => {
    it('accepts ENTER and EXIT', async () => {
      await expect(failingProperties({ transition: 'ENTER' })).resolves.toEqual(
        [],
      );
      await expect(failingProperties({ transition: 'EXIT' })).resolves.toEqual(
        [],
      );
    });

    it('rejects a transition that exists but is never an alert', async () => {
      for (const value of [
        'BASELINE_INSIDE',
        'BASELINE_OUTSIDE',
        'STAY_INSIDE',
        'STAY_OUTSIDE',
      ]) {
        await expect(
          failingProperties({ transition: value }),
        ).resolves.toContain('transition');
      }
    });

    it('rejects an unknown transition', async () => {
      await expect(
        failingProperties({ transition: 'DWELL' }),
      ).resolves.toContain('transition');
    });

    it('is case sensitive', async () => {
      await expect(
        failingProperties({ transition: 'enter' }),
      ).resolves.toContain('transition');
    });
  });

  describe('identifier filters', () => {
    const identifiers = [
      'trackedDeviceId',
      'geofenceId',
      'sourceLocationEventId',
    ] as const;

    it('accepts a well-formed cuid', async () => {
      for (const property of identifiers) {
        await expect(failingProperties({ [property]: CUID })).resolves.toEqual(
          [],
        );
      }
    });

    it('rejects a malformed identifier', async () => {
      for (const property of identifiers) {
        for (const value of [
          'not-a-cuid',
          '1',
          `${CUID}extra`,
          CUID.toUpperCase(),
          "' OR 1=1 --",
          `${CUID}' --`,
        ]) {
          await expect(
            failingProperties({ [property]: value }),
          ).resolves.toContain(property);
        }
      }
    });
  });

  describe('observation window', () => {
    it('accepts an open-ended window at either end', async () => {
      await expect(
        failingProperties({ observedFrom: '2026-09-09T06:00:00.000Z' }),
      ).resolves.toEqual([]);
      await expect(
        failingProperties({ observedBefore: '2026-09-09T07:00:00.000Z' }),
      ).resolves.toEqual([]);
    });

    it('accepts a numeric offset as well as Z', async () => {
      await expect(
        failingProperties({ observedFrom: '2026-09-09T01:00:00.000-05:00' }),
      ).resolves.toEqual([]);
    });

    it('rejects a timestamp with no timezone designator', async () => {
      await expect(
        failingProperties({ observedFrom: '2026-09-09T06:00:00' }),
      ).resolves.toContain('observedFrom');
    });

    it('rejects a malformed timestamp', async () => {
      for (const value of ['not-a-date', '2026-13-01T00:00:00Z', '', '0']) {
        await expect(
          failingProperties({ observedFrom: value }),
        ).resolves.toContain('observedFrom');
      }
    });

    it('rejects a calendar date that never existed', async () => {
      await expect(
        failingProperties({ observedBefore: '2026-02-30T00:00:00.000Z' }),
      ).resolves.toContain('observedBefore');
    });

    it('accepts a window whose bounds are in order', async () => {
      await expect(
        failingProperties({
          observedFrom: '2026-09-09T06:00:00.000Z',
          observedBefore: '2026-09-09T07:00:00.000Z',
        }),
      ).resolves.toEqual([]);
    });

    it('rejects a reversed window', async () => {
      await expect(
        failingProperties({
          observedFrom: '2026-09-09T07:00:00.000Z',
          observedBefore: '2026-09-09T06:00:00.000Z',
        }),
      ).resolves.toContain('observedBefore');
    });

    it('rejects a window reversed only by an offset', async () => {
      // 06:00Z is later than 06:00+02:00 (which is 04:00Z), so the comparison
      // has to be made on instants rather than on the text.
      await expect(
        failingProperties({
          observedFrom: '2026-09-09T06:00:00.000Z',
          observedBefore: '2026-09-09T06:00:00.000+02:00',
        }),
      ).resolves.toContain('observedBefore');
    });

    it('accepts bounds that meet, which is an empty window and not an error', async () => {
      await expect(
        failingProperties({
          observedFrom: '2026-09-09T06:00:00.000Z',
          observedBefore: '2026-09-09T06:00:00.000Z',
        }),
      ).resolves.toEqual([]);
    });

    it('reports a malformed bound once, not twice', async () => {
      const properties = await failingProperties({
        observedFrom: 'not-a-date',
        observedBefore: '2026-09-09T06:00:00.000Z',
      });

      expect(properties).toEqual(['observedFrom']);
    });
  });
});
