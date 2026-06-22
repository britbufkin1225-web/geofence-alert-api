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

| Variable | Example Value | Required | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | Yes | Defines the current application environment. |
| `PORT` | `3000` | Yes | The port where the API server runs locally. |
| `DATABASE_URL` | `file:./dev.db` | Yes | Database connection string used by Prisma or the database layer. |
| `API_PREFIX` | `api` | Yes | Base prefix for API routes. |
| `API_VERSION` | `v1` | Yes | API version identifier. |
| `API_KEY` | `dev-geofence-api-key` | Yes | Development API key used for protected routes. |
| `DEFAULT_GEOFENCE_RADIUS_METERS` | `100` | Yes | Default radius used when creating or testing geofences. |
| `MAX_GEOFENCE_RADIUS_METERS` | `5000` | Yes | Maximum allowed geofence radius in meters. |
| `LOG_LEVEL` | `debug` | No | Controls how much logging detail the application outputs. |

## Local Development Example

A local `.env` file may look like this:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL="file:./dev.db"

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
