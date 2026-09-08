import type { TransformFnParams } from 'class-transformer';

/**
 * Canonicalizes an email login identity by trimming surrounding whitespace and
 * lowercasing it, so the same account cannot be created or logged into under
 * case/whitespace variants. Non-string values are returned unchanged so that
 * @IsEmail reports the correct error instead of this transform masking it.
 */
export function normalizeEmail({ value }: TransformFnParams): unknown {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }

  return value;
}
