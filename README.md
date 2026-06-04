# GeoFence Alert API

Backend API for managing geofences, location events, and alert workflows using GIS-aware backend design.

## Project Summary

GeoFence Alert API is a backend-focused portfolio project that combines API development, geospatial logic, database design, and alert workflow management.

The project is designed to manage geofence regions, process location events, and prepare alert records when a tracked device enters or exits a defined area.

## Problem It Solves

Many applications rely on location-aware workflows, including delivery tracking, asset monitoring, safety alerts, field operations, and location-based automation.

This project demonstrates how a backend system can organize geofence data, receive location events, evaluate them against defined regions, and prepare structured alert responses.

## Core Features

Current and planned core features include:

- REST API for geofence management
- Health and status endpoints
- Environment-based configuration
- Database-backed geofence records
- DTO-based request validation
- Query-based pagination
- Query-based status filtering
- Geofence summary reporting
- Unit-tested geofence summary logic
- Planned location event tracking
- Planned alert workflow support
- Structured project management using GitHub Projects

## Tech Stack

| Area | Tools |
| --- | --- |
| Backend | NestJS, TypeScript, Node.js |
| Database | PostgreSQL, PostGIS |
| API Testing | Postman or Thunder Client |
| Project Management | GitHub Projects, Issues, Labels |
| Documentation | Markdown, GitHub README |
| Version Control | Git, GitHub |

## Project Architecture

Planned architecture:

```text
Client / Location Source
        |
        v
GeoFence Alert API
        |
        |-- Health / Status Endpoints
        |-- Geofence Management
        |-- Location Event Processing
        |-- Alert Workflow
        |
        v
PostgreSQL + PostGIS
```

Architecture diagrams and screenshots will be added as the project develops.

## API Endpoints

Current implemented geofence endpoints:

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | Check API health | Complete |
| POST | `/geofences` | Create a geofence | Complete |
| GET | `/geofences` | List geofences with pagination and filtering | Complete |
| GET | `/geofences/summary` | Return aggregate geofence summary counts | Complete |
| GET | `/geofences/:id` | Retrieve a geofence by ID | Complete |
| PATCH | `/geofences/:id` | Update a geofence by ID | Complete |
| DELETE | `/geofences/:id` | Delete a geofence by ID | Complete |

Planned future endpoints:

| Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- |
| GET | `/api/v1/alerts` | List alert events | Planned |
| POST | `/api/v1/location-events` | Submit a location event | Planned |

### Geofence Query Parameters

The `GET /geofences` endpoint supports pagination and status filtering.

| Query Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | number | No | Page number for paginated results. Defaults to `1`. |
| `limit` | number | No | Number of records returned per page. |
| `status` | string | No | Filters geofences by status. |

## Database Design

Planned database entities:

| Entity | Purpose |
| --- | --- |
| Geofence | Stores named geofence areas and spatial boundaries |
| Tracked Device | Stores device or location source details |
| Location Event | Stores submitted latitude/longitude events |
| Alert Event | Stores enter/exit alert history |

Detailed schema documentation is available in [Database Schema](docs/database-schema.md).

The schema documentation explains planned tables, relationships, foreign keys, example data flow, backend value, and future database improvements.

## Project Management

Development for the GeoFence Alert API is tracked using GitHub Projects.

The project board organizes work across backend API development, geospatial logic, database design, environment configuration, security, testing, documentation, and portfolio polish.

### Workflow

| Status | Purpose |
| --- | --- |
| Backlog | Future features, ideas, and planned improvements |
| Ready | Defined tasks ready for development |
| In Progress | Work currently being built |
| In Review | Completed work awaiting testing, cleanup, or documentation |
| Done | Fully completed, tested, committed, and documented |

This workflow shows the full development process from planning through implementation, review, and completion.

## Security Considerations

Planned security practices include:

- No committed secrets
- Environment-based configuration
- Input validation
- Clear error handling
- Safe database configuration
- API request validation
- Security documentation through `SECURITY.md`

## Local Development

Local setup instructions will be expanded as the backend is implemented.

Planned setup flow:

```bash
npm install
npm run start:dev
```

Environment variables should be copied from:

```bash
.env.example
```

Real `.env` files should not be committed.

## Testing

This project uses Jest for backend unit testing.

Current test coverage includes:

- Geofence summary service behavior
- Aggregate summary count validation
- Empty-state summary behavior
- Mixed-status summary behavior

Current verified test state:

```text
Test Suites: 1 passed
Tests: 3 passed
```

Additional planned testing includes:

- Geofence CRUD behavior
- Pagination behavior
- Status filtering behavior
- Controller route behavior
- Not-found error handling
- Alert workflow behavior

## Roadmap

| Phase | Focus | Status |
| --- | --- | --- |
| Phase 1 | Project foundation | Complete |
| Phase 2 | Core API endpoints | Complete |
| Phase 3 | Database schema | Complete |
| Phase 4 | Geofence CRUD logic | Complete |
| Phase 5 | DTO validation | Complete |
| Phase 6 | Pagination and filtering | Complete |
| Phase 7 | Geofence summary endpoint | Complete |
| Phase 8 | Unit testing foundation | In Progress |
| Phase 9 | Alert workflow | Planned |
| Phase 10 | Documentation polish | In Progress |
| Phase 11 | Portfolio polish | Planned |

## Portfolio Value

This project is designed to demonstrate:

- Backend API architecture
- TypeScript/NestJS development
- GIS-aware backend design
- Database schema planning
- PostgreSQL/PostGIS concepts
- Secure configuration handling
- API testing and documentation
- Professional GitHub project workflow
