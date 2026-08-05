import type { TransformFnParams } from 'class-transformer';

/**
 * Trims surrounding whitespace from string values.
 *
 * Non-string values are returned unchanged so that type validation
 * (e.g. @IsString) still reports the correct error instead of this
 * transform masking it.
 */
export function trim({ value }: TransformFnParams): unknown {
  if (typeof value === 'string') {
    return value.trim();
  }

  return value;
}
