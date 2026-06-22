# Database Schema

The GeoFence Alert API uses a relational database structure to store users, geofence zones, and alert events. The schema is designed to support backend API workflows involving location-based monitoring, event logging, and geofence-triggered alerts.

## Schema Overview

The database is organized around three main entities:

| Table | Purpose |
| --- | --- |
| `users` | Stores application users or account owners |
| `geofences` | Stores named geographic zones created by users |
| `alert_events` | Stores alert records triggered when a location enters or exits a geofence |

## Entity Relationship Summary

A user can create multiple geofences.

A geofence can generate multiple alert events.

Each alert event belongs to one geofence.

```text
users
  └── geofences
        └── alert_events
```

## Users Table

The `users` table stores basic information about users who own geofences.

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID / Primary Key | Unique identifier for each user |
| `name` | String | User display name |
| `email` | String | User email address |
| `created_at` | Timestamp | Date and time the user record was created |
| `updated_at` | Timestamp | Date and time the user record was last updated |

### Users Table Purpose

The `users` table allows the API to associate geofence records with a specific account or owner.

## Geofences Table

The `geofences` table stores geographic zones that can trigger alerts.

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID / Primary Key | Unique identifier for each geofence |
| `user_id` | UUID / Foreign Key | References the user who owns the geofence |
| `name` | String | Human-readable name for the geofence |
| `description` | String / Nullable | Optional description of the geofence |
| `latitude` | Decimal | Center latitude of the geofence |
| `longitude` | Decimal | Center longitude of the geofence |
| `radius_meters` | Integer | Radius of the geofence in meters |
| `is_active` | Boolean | Indicates whether the geofence is currently active |
| `created_at` | Timestamp | Date and time the geofence was created |
| `updated_at` | Timestamp | Date and time the geofence was last updated |

### Geofences Table Purpose

The `geofences` table defines monitored geographic areas. Each record represents a circular geofence using latitude, longitude, and radius.

## Alert Events Table

The `alert_events` table stores events generated when a tracked location interacts with a geofence.

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID / Primary Key | Unique identifier for each alert event |
| `geofence_id` | UUID / Foreign Key | References the geofence that triggered the alert |
| `event_type` | String | Type of event, such as `ENTER` or `EXIT` |
| `latitude` | Decimal | Latitude where the event occurred |
| `longitude` | Decimal | Longitude where the event occurred |
| `message` | String | Human-readable alert message |
| `created_at` | Timestamp | Date and time the alert event was created |

### Alert Events Table Purpose

The `alert_events` table provides a historical log of geofence activity. This allows the API to return recent alerts, audit location-based events, and support dashboard or reporting features later.

## Relationships

| Relationship | Type | Description |
| --- | --- | --- |
| `users` → `geofences` | One-to-many | One user can own many geofences |
| `geofences` → `alert_events` | One-to-many | One geofence can generate many alert events |

## Foreign Keys

| Table | Foreign Key | References |
| --- | --- | --- |
| `geofences` | `user_id` | `users.id` |
| `alert_events` | `geofence_id` | `geofences.id` |

## Example Data Flow

1. A user creates a geofence called `Warehouse Zone`.
2. The API stores the geofence with a latitude, longitude, and radius.
3. A location update is checked against the geofence.
4. If the location enters or exits the geofence, an alert event is created.
5. The alert event can be retrieved through the API.

## Example Logical Schema

```text
users
- id
- name
- email
- created_at
- updated_at

geofences
- id
- user_id
- name
- description
- latitude
- longitude
- radius_meters
- is_active
- created_at
- updated_at

alert_events
- id
- geofence_id
- event_type
- latitude
- longitude
- message
- created_at
```

## Backend Value

This schema demonstrates several backend development concepts:

- Relational database design
- Primary key and foreign key relationships
- Event logging
- Location-based data modeling
- API-ready resource structure
- Future support for authentication and user-owned resources
- Clear separation between users, geofence definitions, and generated events

## Future Schema Improvements

Possible future improvements include:

| Improvement | Purpose |
| --- | --- |
| Add `devices` table | Track mobile devices or assets being monitored |
| Add `organizations` table | Support multiple teams or business accounts |
| Add `severity` field to alert events | Classify alerts by importance |
| Add `resolved_at` field | Track whether alerts have been handled |
| Add polygon geofence support | Support more complex geographic boundaries |
| Add indexes on foreign keys | Improve query performance |
| Add audit logging | Track changes to geofences and users |

## Summary

The GeoFence Alert API database schema is designed around a simple but practical backend model: users create geofences, and geofences generate alert events. This structure keeps the project understandable while still demonstrating real backend architecture, relational modeling, and event-driven API design.
