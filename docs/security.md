# Security Architecture (GF-2)

This note describes the authentication and tenant-isolation model implemented in
Phase GF-2. Every property below is enforced by executable code and covered by
tests (see [testing.md](testing.md)). It is a concise architecture note, not a
compliance document.

## Authentication flow

1. `POST /api/v1/auth/register` — creates a `User`, a `Tenant`, and the
   `Membership` linking them, **atomically** in a single transaction, then
   returns a signed JWT. Identity state is never left partially created.
2. `POST /api/v1/auth/login` — verifies email + password and returns a signed
   JWT.
3. Authenticated requests send `Authorization: Bearer <token>`. A global guard
  verifies the token, requires an expiry, revalidates the exact
  membership/user/tenant tuple, and attaches a typed principal to the request.
4. `GET /api/v1/auth/me` — returns the identity resolved from the verified
   principal, re-validated against the database.

## Password storage

- Passwords are hashed with **bcrypt** (`bcryptjs`, cost 10). Plaintext is never
  stored, returned in any response, or logged.
- Bounds: 8–72 characters and at most 72 UTF-8 bytes. Passwords are never trimmed or transformed. Input
  beyond bcrypt's 72-byte limit is rejected rather than silently truncated.
- Password hashes are never serialized into user/principal objects returned to
  clients.

## Token validation

- Algorithm is pinned to **HS256** on both signing and verification. Unsigned
  (`alg: none`) and wrong-algorithm tokens are rejected (algorithm-confusion
  defense).
- Signature verification and an explicit expiry (`JWT_EXPIRES_IN`, default `1h`) are
  required. Missing, malformed, altered, and expired tokens all collapse to the
  same generic `401`.
- Claims contain only ids: `sub` (user), `tid` (tenant), `mid` (membership). No
  passwords, hashes, secrets, or unnecessary PII are placed in the token.

## Secret management

- The signing secret comes from `JWT_SECRET` (environment/config only) and must
  be at least 32 characters.
- There is **no insecure fallback secret**. Startup fails closed (the app refuses
  to boot) when `JWT_SECRET` is absent or too short, enforced by the config
  validation schema.
- `.env` is git-ignored; `.env.example` ships a placeholder only. Secrets are
  never printed in tests or diagnostics.

## Tenant derivation

- The authoritative tenant is derived from the verified token's `tid` claim
  after the guard confirms the exact `mid`/`sub`/`tid` tuple still exists in
  the database, exposed as a typed
  `AuthenticatedPrincipal { userId, tenantId, membershipId }`.
- Tenant identity is **never** read from the request body, query string, URL
  parameter, or a client-supplied header.

## Tenant query scoping (IDOR/BOLA mitigation)

- Every geofence query is scoped by `tenantId` in the database predicate itself
  (e.g. `findFirst({ where: { id, tenantId } })`, `findMany({ where: { tenantId,
  ... } })`, counts, and aggregates). Authorization is not a post-fetch
  comparison.
- Create sets ownership server-side (`tenant.connect`) from the principal.
- Update/delete confirm tenant ownership via a scoped read before mutating by id,
  and the update payload can never contain `tenantId`, so ownership cannot be
  reassigned (mass-assignment safe).

## Cross-tenant object policy

- A geofence that exists but belongs to another tenant is reported as
  **`404 Not Found`**, identical to a non-existent id. The API does not confirm
  the existence of resources outside the caller's tenant, and never leaks a
  foreign tenant id, foreign user data, or internal authorization mechanics.

## User-enumeration resistance

- Login returns a single generic `401 Invalid credentials` for both wrong
  passwords and unknown accounts, and performs a dummy bcrypt comparison when the
  account does not exist to keep timing similar.
- (Registration intentionally returns `409` on a duplicate email, per the
  required error contract.)

## Error sanitization

- A catch-all exception filter returns a stable JSON shape
  (`{ statusCode, error, message, path, timestamp }`) and never leaks stack
  traces, SQL, Prisma error structures, filesystem paths, or secrets.
- Duplicate registration is mapped from Prisma's `P2002` to a clean `409` with no
  Prisma internals in the response.

## Public vs protected routes

- Public: `/health`, `/status`, `GET /api/v1` (static banner), `auth/register`,
  `auth/login`.
- Protected (Bearer): `auth/me`, `/api/v1/db/status`, and all geofence routes.
- The guard is registered globally, so any route added later is authenticated by
  default (fail-closed) unless explicitly marked `@Public()`.

## Deferred security controls (not in GF-2)

Refresh-token rotation, password reset, MFA, OAuth/social login, API-key
management, full RBAC/ABAC, rate limiting, and account lockout are intentionally
out of scope for this phase and remain future work.
