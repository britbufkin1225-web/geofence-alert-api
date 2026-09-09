import {
  BadRequestException,
  Injectable,
  Optional,
  PipeTransform,
} from '@nestjs/common';

/**
 * Validates that a route parameter is a syntactically valid cuid, which is the
 * identifier format used by the Prisma schema (`@default(cuid())`).
 *
 * A cuid is a lowercase string that starts with `c` followed by 24
 * alphanumeric characters. Malformed identifiers are rejected with a 400 so
 * they never reach the service or database layer. A syntactically valid but
 * non-existent id is left for the service to resolve as a 404.
 *
 * The rejection message names the resource whose id was malformed. It defaults
 * to `geofence`, which is the only resource that had an id route parameter when
 * the pipe was written, so `@Param('id', ParseCuidPipe)` keeps its exact
 * existing contract; routes for other resources pass their own label
 * (`@Param('x', new ParseCuidPipe('location event'))`) rather than reporting a
 * geofence error for a different resource.
 *
 * The label is `@Optional()` because Nest instantiates a pipe referenced by
 * class and would otherwise try to resolve the constructor parameter as an
 * injectable `String` provider. Marked optional, Nest passes nothing and the
 * default applies, so the existing class-reference call sites keep working
 * unchanged.
 */
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

@Injectable()
export class ParseCuidPipe implements PipeTransform<string, string> {
  constructor(@Optional() private readonly resource: string = 'geofence') {}

  transform(value: string): string {
    if (typeof value !== 'string' || !CUID_PATTERN.test(value)) {
      throw new BadRequestException(`Invalid ${this.resource} id format`);
    }

    return value;
  }
}
