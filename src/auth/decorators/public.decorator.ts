import { SetMetadata } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../auth.constants';

/**
 * Marks a route (or an entire controller) as public, opting it out of the
 * global JWT auth guard. Everything is authenticated by default; a route is
 * only reachable anonymously when it explicitly carries this decorator.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
