# Database Schema Design

This document outlines the planned database schema for the GeoFence Alert API.

The schema is designed to support geofence storage, tracked devices, location events, and alert history for enter/exit workflows.

## Database Overview

The GeoFence Alert API will use PostgreSQL with PostGIS support for geospatial data.

PostgreSQL provides relational data storage, while PostGIS adds spatial data types and geospatial query support.

## Planned Entities

| Entity         | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| Geofence       | Stores named geofence regions and spatial boundaries |
| Tracked Device | Stores device or location source information         |
| Location Event | Stores submitted latitude/longitude location records |
| Alert Event    | Stores enter/exit alert history                      |

---

## Entity Relationship Overview

```text
Tracked Device
      |
      | 1-to-many
      v
Location Event
      |
      | evaluated against
      v
Geofence
      |
      | creates
      v
Alert Event
```

A tracked device can submit many location events.

Each location event can be evaluated against one or more geofences.

When a location event enters or exits a geofence, the system can create an alert event.

---

## Table: geofences

Stores geofence regions and spatial boundary data.

| Field            | Type      | Notes                                      |
| ---------------- | --------- | ------------------------------------------ |
| id               | UUID      | Primary key                                |
| name             | VARCHAR   | Human-readable geofence name               |
| description      | TEXT      | Optional description                       |
| boundary_type    | VARCHAR   | Example: `circle`, `polygon`               |
| center_latitude  | DECIMAL   | Used for circular geofences                |
| center_longitude | DECIMAL   | Used for circular geofences                |
| radius_meters    | INTEGER   | Used for circular geofences                |
| polygon          | GEOMETRY  | Used for polygon geofences with PostGIS    |
| is_active        | BOOLEAN   | Enables or disables the geofence           |
| created_at       | TIMESTAMP | Record creation time                       |
| updated_at       | TIMESTAMP | Last update time                           |

### Geofence Notes

Circular geofences can use latitude, longitude, and radius values.

Polygon geofences can use PostGIS geometry fields for more complex spatial boundaries.

---

## Table: tracked_devices

Stores device or location source information.

| Field       | Type      | Notes                               |
| ----------- | --------- | ----------------------------------- |
| id          | UUID      | Primary key                         |
| name        | VARCHAR   | Device name or label                |
| external_id | VARCHAR   | Optional external device identifier |
| description | TEXT      | Optional description                |
| is_active   | BOOLEAN   | Enables or disables tracking        |
| created_at  | TIMESTAMP | Record creation time                |
| updated_at  | TIMESTAMP | Last update time                    |

### Tracked Device Notes

A tracked device represents anything that submits location data, such as a mobile device, asset tracker, delivery vehicle, or simulated location source.

---

## Table: location_events

Stores submitted location records.

| Field           | Type             | Notes                                |
| --------------- | ---------------- | ------------------------------------ |
| id              | UUID             | Primary key                          |
| device_id       | UUID             | Foreign key to `tracked_devices.id`  |
| latitude        | DECIMAL          | Submitted latitude                   |
| longitude       | DECIMAL          | Submitted longitude                  |
| location        | GEOGRAPHY(Point) | PostGIS point representation         |
| accuracy_meters | INTEGER          | Optional accuracy value              |
| recorded_at     | TIMESTAMP        | Time the location was recorded       |
| received_at     | TIMESTAMP        | Time the API received the event      |

### Location Event Notes

The `location` field can be used for spatial queries with PostGIS.

Latitude and longitude are kept separately for readability and API response formatting.

---

## Table: alert_events

Stores alert records generated when a tracked device enters, exits, or violates a geofence rule.

| Field | Type | Notes |
| --- | --- | --- |
| id | UUID | Primary key |
| geofence_id | UUID | Foreign key to `geofences.id` |
| device_id | UUID | Foreign key to `tracked_devices.id` |
| location_event_id | UUID | Foreign key to `location_events.id` |
| event_type | VARCHAR | Example: `enter`, `exit`, `violation` |
| severity | VARCHAR | Example: `low`, `medium`, `high`, `critical` |
| latitude | DECIMAL | Latitude where the alert was triggered |
| longitude | DECIMAL | Longitude where the alert was triggered |
| message | TEXT | Human-readable alert message |
| status | VARCHAR | Example: `open`, `acknowledged`, `resolved`, `ignored` |
| created_at | TIMESTAMP | Time the alert was created |
| resolved_at | TIMESTAMP | Optional time the alert was resolved |

### Alert Event Notes

Alert events are created when a submitted location event enters, exits, or violates a geofence rule. For the MVP, geofence checks use a center latitude, center longitude, and radius in meters. Future versions may support polygon-based geofences, webhook notifications, and real-time alert delivery.

---

## Relationships

| Relationship | Description |
| --- | --- |
| `tracked_devices` → `location_events` | One tracked device can create many location events |
| `tracked_devices` → `alert_events` | One tracked device can create many alert events |
| `geofences` → `alert_events` | One geofence can be associated with many alert events |
| `location_events` → `alert_events` | One location event can trigger one or more alert events |

---

## Future Schema Considerations

Future versions may include:

- Users and authentication
- API keys
- Organization or tenant support
- Alert notification destinations
- Webhook delivery history
- Audit logs
- Rate limiting records
- Geofence rule configuration
- Device status history

---

## Portfolio Relevance

This schema demonstrates:

- Relational database planning
- GIS-aware backend design
- PostgreSQL/PostGIS concepts
- Event-driven alert modeling
- API data persistence planning
- Professional backend documentation
