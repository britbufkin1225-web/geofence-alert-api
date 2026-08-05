# Environment Variables

This document describes the environment variables used by the GeoFence Alert API.

Environment variables allow the application to be configured without hardcoding values directly into the source code.

## Environment File Overview

The project uses two main environment files during local development:

| File | Purpose | Should Be Committed? |
| --- | --- | --- |
| `.env` | Stores local development values and secrets | No |
| `.env.example` | Documents required environment variables with safe example values | Yes |

## Variables

The **Consumed by code** column reflects what the current application actually
reads. Variables marked "No" are documented for the planned roadmap but are not
yet referenced anywhere in the codebase.

| Variable | Example Value | Consumed by code | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db` | Yes | SQLite connection string used by the Prisma service. Falls back to `file:./dev.db` if unset. |
| `PORT` | `3000` | Yes | Port the API listens on. Falls back to `3000` if unset. |
| `NODE_ENV` | `development` | Yes | Reported by the `/status` endpoint. Defaults to `development`. |
| `JWT_SECRET` | `replace-with-a-long-random-secret-at-least-32-chars` | Yes (**required**) | Signing secret for auth tokens. Validated at startup: must be present and ≥ 32 characters. The application **fails closed** (refuses to boot) if it is missing or too short. No fallback secret exists. |
| `JWT_EXPIRES_IN` | `1h` | Yes | Access-token lifetime (e.g. `15m`, `1h`, `7d`). Defaults to `1h`. |
| `API_PREFIX` | `api` | Reported only | Echoed by the `/status` endpoint as metadata. The actual route prefix (`api/v1`) is currently hardcoded in `setupApp`, not derived from this variable. |
| `API_VERSION` | `v1` | No | Documented for the roadmap; not read by code. |
| `API_KEY` | `change-this-development-api-key` | No | Legacy placeholder. Authentication now uses JWT (`JWT_SECRET`); this variable is not read by code. |
| `DEFAULT_GEOFENCE_RADIUS_METERS` | `100` | No | Documented default; not read by code. |
| `MAX_GEOFENCE_RADIUS_METERS` | `5000` | No | Documents the intended max radius. The `5000` limit is currently enforced as a constant in the DTO layer, not read from this variable. |
| `LOG_LEVEL` | `debug` | No | Documented for the roadmap; not read by code. |

## Local Development Example

A local `.env` file may look like this:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL="file:./dev.db"

JWT_SECRET=replace-with-a-long-random-secret-at-least-32-chars
JWT_EXPIRES_IN=1h

API_PREFIX=api
API_VERSION=v1

API_KEY=dev-geofence-api-key

DEFAULT_GEOFENCE_RADIUS_METERS=100
MAX_GEOFENCE_RADIUS_METERS=5000

LOG_LEVEL=debug
```

## Security Notes

The `.env` file should never be committed to GitHub because it may contain secrets, credentials, or local-only configuration values.

The `.env.example` file should be committed because it helps other developers understand which variables are needed to run the project.

## Validation Checklist

Before running the application, confirm that:

- `.env` exists locally.
- `.env` is listed in `.gitignore`.
- `.env.example` exists and contains safe placeholder values.
- No real secrets are committed to the repository.
- The application starts successfully with `npm run start:dev`.

## Related Files

| File | Description |
| --- | --- |
| `.env` | Local environment values. |
| `.env.example` | Safe template for required environment variables. |
| `.gitignore` | Prevents sensitive/local files from being committed. |
| `README.md` | Main project overview and setup guide. |
| `docs/project-status.md` | Tracks current project progress. |
