import {
  ValidateBy,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * ISO-8601 date-time with an explicit UTC designator or numeric offset.
 *
 * Fractional seconds are optional and bounded to milliseconds, which is the
 * precision the database columns store; accepting more digits would silently
 * discard them and make a stored value disagree with the one submitted.
 *
 * A timezone-free value such as `2026-09-09T06:00:00` is deliberately NOT
 * matched. `new Date()` would interpret it in the *server's* local zone, so the
 * same payload would mean different instants on different hosts — for an
 * observation timestamp supplied by a remote source that is never acceptable.
 */
const ISO_8601_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return DAYS_IN_MONTH[month - 1];
}

/**
 * Parses a strict ISO-8601 instant, returning `null` for anything this contract
 * does not accept.
 *
 * `new Date(value)` alone is not sufficient. V8 silently rolls impossible
 * calendar dates forward (`2026-02-30` becomes 2 March) and accepts a long tail
 * of non-ISO formats, so a caller could submit a date that never existed and
 * have a different one persisted. Every component is therefore range-checked
 * against the real calendar before the value is handed to `Date`.
 */
export function parseStrictIsoDateTime(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = ISO_8601_INSTANT.exec(value);
  if (!match) {
    return null;
  }

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, , offset] =
    match;

  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);

  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  // 24:00 and leap seconds are valid ISO-8601 but not representable as a
  // distinct JavaScript instant, so they are refused rather than normalized.
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) {
      return null;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Validates that a property is a strict ISO-8601 instant (see
 * {@link parseStrictIsoDateTime}). The value stays a string on the DTO; callers
 * convert it once, in the service, using the same parser.
 */
export function IsStrictIsoDateTime(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isStrictIsoDateTime',
      validator: {
        validate(value: unknown): boolean {
          return parseStrictIsoDateTime(value) !== null;
        },
        defaultMessage(): string {
          return 'must be an ISO-8601 date-time with an explicit UTC designator or offset (e.g. 2026-09-09T06:00:00.000Z)';
        },
      },
    },
    validationOptions,
  );
}

/**
 * Rejects instants more than `maxSkewMs` ahead of the server clock.
 *
 * A source with a badly wrong clock, or a caller backdating the future, would
 * otherwise be able to store observations arbitrarily far ahead and poison any
 * ordering built on `observedAt` later. A bounded allowance (rather than "must
 * not be in the future") is what keeps ordinary clock skew and network latency
 * from failing legitimate submissions.
 *
 * There is deliberately no lower bound: back-dated events are accepted, and
 * retention policy is out of scope for this phase.
 */
export function IsNotBeyondFutureSkew(
  maxSkewMs: number,
  validationOptions?: ValidationOptions,
) {
  return ValidateBy(
    {
      name: 'isNotBeyondFutureSkew',
      constraints: [maxSkewMs],
      validator: {
        validate(value: unknown): boolean {
          const parsed = parseStrictIsoDateTime(value);
          if (!parsed) {
            // Format is reported by IsStrictIsoDateTime; do not double-report.
            return true;
          }
          return parsed.getTime() <= Date.now() + maxSkewMs;
        },
        defaultMessage(): string {
          return `must not be more than ${Math.floor(
            maxSkewMs / 1000,
          )} seconds in the future`;
        },
      },
    },
    validationOptions,
  );
}

/**
 * Rejects an instant that is earlier than the instant held by a sibling
 * property — the upper bound of a time window, checked against its lower bound.
 *
 * A reversed window is a caller mistake, not a query that legitimately matches
 * nothing: `from` after `to` describes an interval that cannot exist, and
 * answering it with an empty page would hide the mistake behind a successful
 * response. It is therefore refused by the same validation pipe, in the same
 * error envelope, as a malformed timestamp.
 *
 * An equal pair is NOT refused. With a half-open window the two bounds meeting
 * describes a genuinely empty interval, which is what a caller stepping through
 * adjacent windows produces at a boundary, and an empty page is the honest
 * answer to it.
 *
 * When either value is absent or is not a strict ISO-8601 instant the check
 * passes: an open-ended window is valid, and a malformed bound is already
 * reported by {@link IsStrictIsoDateTime} on the property that owns it. Adding a
 * second complaint about the same value would only make the error harder to act
 * on.
 */
export function IsNotBeforeInstantProperty(
  lowerBoundProperty: string,
  validationOptions?: ValidationOptions,
) {
  return ValidateBy(
    {
      name: 'isNotBeforeInstantProperty',
      constraints: [lowerBoundProperty],
      validator: {
        validate(value: unknown, args?: ValidationArguments): boolean {
          const upper = parseStrictIsoDateTime(value);
          if (!upper) {
            return true;
          }

          const sibling = (
            args?.object as Record<string, unknown> | undefined
          )?.[lowerBoundProperty];
          const lower = parseStrictIsoDateTime(sibling);
          if (!lower) {
            return true;
          }

          return upper.getTime() >= lower.getTime();
        },
        defaultMessage(): string {
          return `must not be earlier than ${lowerBoundProperty}`;
        },
      },
    },
    validationOptions,
  );
}
