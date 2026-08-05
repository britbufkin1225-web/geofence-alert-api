import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Validates that a route parameter is a syntactically valid cuid, which is the
 * identifier format used by the Prisma schema (`@default(cuid())`).
 *
 * A cuid is a lowercase string that starts with `c` followed by 24
 * alphanumeric characters. Malformed identifiers are rejected with a 400 so
 * they never reach the service or database layer. A syntactically valid but
 * non-existent id is left for the service to resolve as a 404.
 */
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

@Injectable()
export class ParseCuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !CUID_PATTERN.test(value)) {
      throw new BadRequestException('Invalid geofence id format');
    }

    return value;
  }
}
