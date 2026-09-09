import { validateSync } from 'class-validator';

import {
  IsNotBeyondFutureSkew,
  IsStrictIsoDateTime,
  parseStrictIsoDateTime,
} from './strict-iso-date-time.decorator';

const SKEW_MS = 5 * 60 * 1000;

class Subject {
  @IsStrictIsoDateTime()
  @IsNotBeyondFutureSkew(SKEW_MS)
  observedAt!: unknown;
}

function constraintsFor(value: unknown): string[] {
  const subject = new Subject();
  subject.observedAt = value;
  return validateSync(subject).flatMap((error) =>
    Object.keys(error.constraints ?? {}),
  );
}

describe('parseStrictIsoDateTime', () => {
  describe('accepts unambiguous instants', () => {
    it.each([
      ['2026-09-09T06:00:00.000Z', '2026-09-09T06:00:00.000Z'],
      ['2026-09-09T06:00:00Z', '2026-09-09T06:00:00.000Z'],
      ['2026-09-09T06:00:00.5Z', '2026-09-09T06:00:00.500Z'],
      ['2026-09-09T06:00:00.05Z', '2026-09-09T06:00:00.050Z'],
      ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
      ['2026-09-09T23:59:00+23:59', '2026-09-09T00:00:00.000Z'],
      ['2026-09-09T00:00:00-23:59', '2026-09-09T23:59:00.000Z'],
      // Offsets resolve to the same absolute instant as their UTC equivalent.
      ['2026-09-09T08:00:00.000+02:00', '2026-09-09T06:00:00.000Z'],
      ['2026-09-09T01:00:00.000-05:00', '2026-09-09T06:00:00.000Z'],
      // Real leap day.
      ['2024-02-29T12:00:00.000Z', '2024-02-29T12:00:00.000Z'],
      // Boundary components.
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      ['2026-12-31T23:59:59.999Z', '2026-12-31T23:59:59.999Z'],
    ])('parses %s', (input, expected) => {
      expect(parseStrictIsoDateTime(input)?.toISOString()).toBe(expected);
    });
  });

  describe('rejects ambiguous or impossible values', () => {
    it.each([
      // No timezone: would silently mean different instants on different hosts.
      ['2026-09-09T06:00:00'],
      ['2026-09-09T06:00:00.000'],
      // Date only.
      ['2026-09-09'],
      // Calendar dates that do not exist. new Date() rolls these forward.
      ['2026-02-30T00:00:00.000Z'],
      ['2025-02-29T00:00:00.000Z'],
      ['1900-02-29T00:00:00Z'],
      ['2026-04-31T00:00:00.000Z'],
      ['2026-13-01T00:00:00.000Z'],
      ['2026-00-10T00:00:00.000Z'],
      ['2026-09-00T00:00:00.000Z'],
      ['2026-09-32T00:00:00.000Z'],
      // Out-of-range time components.
      ['2026-09-09T24:00:00.000Z'],
      ['2026-09-09T06:60:00.000Z'],
      ['2026-09-09T06:00:60.000Z'],
      // Out-of-range offsets.
      ['2026-09-09T06:00:00.000+25:00'],
      ['2026-09-09T06:00:00+24:00'],
      ['2026-09-09T06:00:00-24:00'],
      ['2026-09-09T06:00:00.000+02:60'],
      // Precision beyond what the column stores.
      ['2026-09-09T06:00:00.000000Z'],
      [`2026-09-09T06:00:00.${'0'.repeat(10000)}Z`],
      // Non-ISO formats that Date happily accepts.
      ['September 9, 2026 06:00:00 UTC'],
      ['2026/09/09 06:00:00'],
      ['1789253000000'],
      // Structurally malformed.
      [''],
      ['   '],
      ['not-a-date'],
      ['2026-09-09T06:00:00.000ZZ'],
      ['2026-9-9T6:00:00Z'],
    ])('rejects %s', (input) => {
      expect(parseStrictIsoDateTime(input)).toBeNull();
    });

    it.each([
      [null],
      [undefined],
      [123],
      [true],
      [{}],
      [[]],
      [new Date('2026-09-09T06:00:00.000Z')],
    ])('rejects the non-string %p', (input) => {
      expect(parseStrictIsoDateTime(input)).toBeNull();
    });
  });

  it('does not roll an impossible date forward the way Date does', () => {
    // Guards the exact behavior this parser exists to prevent.
    expect(new Date('2026-02-30T00:00:00.000Z').toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );
    expect(parseStrictIsoDateTime('2026-02-30T00:00:00.000Z')).toBeNull();
  });
});

describe('IsStrictIsoDateTime / IsNotBeyondFutureSkew', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-09T06:00:00Z'));
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    '2026-09-09T06:05:00Z',
    '2026-09-09T08:05:00+02:00',
    '2026-09-09T01:05:00-05:00',
  ])('accepts the exact five-minute boundary as %s', (value) => {
    expect(constraintsFor(value)).toEqual([]);
  });

  it.each([
    '2026-09-09T06:05:00.001Z',
    '2026-09-09T08:05:00.001+02:00',
    '2026-09-09T01:05:00.001-05:00',
  ])('rejects one millisecond beyond the boundary as %s', (value) => {
    expect(constraintsFor(value)).toEqual(['isNotBeyondFutureSkew']);
  });

  it('accepts a valid instant in the past', () => {
    expect(constraintsFor('2026-09-09T06:00:00.000Z')).toEqual([]);
  });

  it('reports only the format failure for a malformed value', () => {
    // The skew check must not double-report on input it cannot parse.
    expect(constraintsFor('2026-02-30T00:00:00.000Z')).toEqual([
      'isStrictIsoDateTime',
    ]);
  });

  it('accepts an instant inside the future-skew allowance', () => {
    const nearFuture = new Date(Date.now() + SKEW_MS - 30_000).toISOString();
    expect(constraintsFor(nearFuture)).toEqual([]);
  });

  it('rejects an instant beyond the future-skew allowance', () => {
    const farFuture = new Date(Date.now() + SKEW_MS + 60_000).toISOString();
    expect(constraintsFor(farFuture)).toEqual(['isNotBeyondFutureSkew']);
  });

  it('rejects an instant far in the future', () => {
    expect(constraintsFor('2099-01-01T00:00:00.000Z')).toEqual([
      'isNotBeyondFutureSkew',
    ]);
  });

  it('accepts a heavily back-dated instant (retention is out of scope)', () => {
    expect(constraintsFor('1999-01-01T00:00:00.000Z')).toEqual([]);
  });
});
