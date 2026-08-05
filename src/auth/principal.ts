import type { Request } from 'express';

/**
 * Minimal, typed representation of the authenticated caller. Derived only from
 * a verified JWT and used as the single source of authorization context for
 * downstream services. It deliberately carries no email, password hash, or
 * other PII — only the ids required to scope data access.
 */
export interface AuthenticatedPrincipal {
  userId: string;
  tenantId: string;
  membershipId: string;
}

/**
 * Verified JWT claims. `sub` is the user id, `tid` the authorized tenant id and
 * `mid` the membership id. No secrets, password hashes, or unnecessary PII are
 * ever placed in the token.
 */
export interface JwtClaims {
  sub: string;
  tid: string;
  mid: string;
  iat?: number;
  exp?: number;
}

/** Express request augmented with the verified principal by the auth guard. */
export interface RequestWithPrincipal extends Request {
  principal?: AuthenticatedPrincipal;
}
