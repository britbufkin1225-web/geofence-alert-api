/**
 * Centralized identity/authentication limits and security constants.
 *
 * Bounds are enforced by the auth DTOs and mirrored in the documentation so the
 * contract, the code, and the docs stay in sync.
 */

// Canonical login identity (email). RFC 5321 caps an address at 254 chars.
export const EMAIL_MAX_LENGTH = 254;

// Password policy. Passwords are never trimmed or otherwise transformed.
export const PASSWORD_MIN_LENGTH = 8;

// bcrypt only considers the first 72 bytes of input; anything longer would be
// silently truncated (so two different long passwords could collide). We reject
// input beyond this bound rather than allow that ambiguity.
export const PASSWORD_MAX_LENGTH = 72;
export const PASSWORD_MAX_BYTES = 72;

// bcrypt cost factor. 10 is a defensible development default; tune via ops as
// hardware allows.
export const PASSWORD_SALT_ROUNDS = 10;

// Human-readable tenant name.
export const TENANT_NAME_MIN_LENGTH = 1;
export const TENANT_NAME_MAX_LENGTH = 120;

// Only HMAC-SHA256 is accepted. Pinning the algorithm on both sign and verify
// prevents algorithm-confusion / "alg: none" attacks.
export const JWT_ALGORITHM = 'HS256' as const;

// Metadata key used by the @Public() decorator to opt a route out of the global
// JWT auth guard.
export const IS_PUBLIC_KEY = 'isPublic';
