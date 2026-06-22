# API Endpoint Design

This document outlines the planned API endpoints for the GeoFence Alert API.

The API is designed to support geofence management, tracked devices, location event submission, and alert event history for enter/exit geofence workflows.

## API Overview

The GeoFence Alert API exposes REST-style endpoints for managing geospatial alert workflows.

The initial API will focus on:

- Creating and managing geofences
- Registering tracked devices
- Submitting location events
- Evaluating location events against geofence rules
- Creating alert events when a tracked device enters, exits, or violates a geofence
- Retrieving alert history for monitoring and review

## Base URL

```text
/api/v1
```

## Planned Endpoint Groups

| Group | Purpose |
| --- | --- |
| Health | Verifies API availability |
| Status | Provides service metadata and runtime status |
| Geofences | Manages geofence regions and boundaries |
| Tracked Devices | Manages devices or simulated location sources |
| Location Events | Stores submitted latitude/longitude records |
| Alert Events | Stores geofence enter/exit/violation alerts |

---

## Health Endpoints

### GET `/api/v1/health`

Checks whether the API is running.

#### Health Check Example Response

```json
{
  "status": "ok",
  "service": "GeoFence Alert API",
  "version": "0.1.0",
  "timestamp": "2026-06-02T15:00:00.000Z"
}
```

---

## Status Endpoints

### GET `/api/v1/status`

Returns basic service status and runtime metadata.

#### Service Status Example Response

```json
{
  "service": "GeoFence Alert API",
  "status": "running",
  "environment": "development",
  "version": "0.1.0",
  "uptimeSeconds": 120,
  "timestamp": "2026-06-02T15:00:00.000Z"
}
```

---

## Geofence Endpoints

Geofence endpoints manage named geofence regions.

For the MVP, circular geofences will use a center latitude, center longitude, and radius in meters. Future versions may support polygon-based geofences using PostGIS.

### GET `/api/v1/geofences`

Returns all geofences.

#### List Geofences Example Response

```json
{
  "data": [
    {
      "id": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
      "name": "Warehouse Zone",
      "description": "Primary delivery warehouse boundary",
      "boundaryType": "circle",
      "centerLatitude": 30.3119,
      "centerLongitude": -95.4561,
      "radiusMeters": 500,
      "isActive": true,
      "createdAt": "2026-06-02T15:00:00.000Z",
      "updatedAt": "2026-06-02T15:00:00.000Z"
    }
  ]
}
```

### POST `/api/v1/geofences`

Creates a new geofence.

#### Create Geofence Example Request

```json
{
  "name": "Warehouse Zone",
  "description": "Primary delivery warehouse boundary",
  "boundaryType": "circle",
  "centerLatitude": 30.3119,
  "centerLongitude": -95.4561,
  "radiusMeters": 500
}
```

#### Create Geofence Example Response

```json
{
  "message": "Geofence created successfully",
  "data": {
    "id": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
    "name": "Warehouse Zone",
    "boundaryType": "circle",
    "centerLatitude": 30.3119,
    "centerLongitude": -95.4561,
    "radiusMeters": 500,
    "isActive": true,
    "createdAt": "2026-06-02T15:00:00.000Z"
  }
}
```

### GET `/api/v1/geofences/:id`

Returns one geofence by ID.

#### Get Geofence by ID Example Response

```json
{
  "data": {
    "id": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
    "name": "Warehouse Zone",
    "description": "Primary delivery warehouse boundary",
    "boundaryType": "circle",
    "centerLatitude": 30.3119,
    "centerLongitude": -95.4561,
    "radiusMeters": 500,
    "isActive": true,
    "createdAt": "2026-06-02T15:00:00.000Z",
    "updatedAt": "2026-06-02T15:00:00.000Z"
  }
}
```

### PATCH `/api/v1/geofences/:id`

Updates an existing geofence.

#### Update Geofence Example Request

```json
{
  "name": "Warehouse Zone Updated",
  "radiusMeters": 750,
  "isActive": true
}
```

#### Update Geofence Example Response

```json
{
  "message": "Geofence updated successfully",
  "data": {
    "id": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
    "name": "Warehouse Zone Updated",
    "radiusMeters": 750,
    "isActive": true,
    "updatedAt": "2026-06-02T15:10:00.000Z"
  }
}
```

### DELETE `/api/v1/geofences/:id`

Deletes or deactivates a geofence.

For the MVP, soft deactivation may be preferred over permanent deletion by setting `isActive` to `false`.

#### Deactivate Geofence Example Response

```json
{
  "message": "Geofence deactivated successfully",
  "data": {
    "id": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
    "isActive": false,
    "updatedAt": "2026-06-02T15:15:00.000Z"
  }
}
```

---

## Tracked Device Endpoints

Tracked device endpoints manage devices, assets, users, vehicles, or simulated location sources that submit location data.

### GET `/api/v1/tracked-devices`

Returns all tracked devices.

#### List Tracked Devices Example Response

```json
{
  "data": [
    {
      "id": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
      "name": "Delivery Vehicle 001",
      "externalId": "vehicle-001",
      "description": "Simulated delivery vehicle for geofence testing",
      "isActive": true,
      "createdAt": "2026-06-02T15:00:00.000Z",
      "updatedAt": "2026-06-02T15:00:00.000Z"
    }
  ]
}
```

### POST `/api/v1/tracked-devices`

Creates a tracked device.

#### Create Tracked Device Example Request

```json
{
  "name": "Delivery Vehicle 001",
  "externalId": "vehicle-001",
  "description": "Simulated delivery vehicle for geofence testing"
}
```

#### Create Tracked Device Example Response

```json
{
  "message": "Tracked device created successfully",
  "data": {
    "id": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "name": "Delivery Vehicle 001",
    "externalId": "vehicle-001",
    "isActive": true,
    "createdAt": "2026-06-02T15:00:00.000Z"
  }
}
```

### GET `/api/v1/tracked-devices/:id`

Returns one tracked device by ID.

#### Get Tracked Device by ID Example Response

```json
{
  "data": {
    "id": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "name": "Delivery Vehicle 001",
    "externalId": "vehicle-001",
    "description": "Simulated delivery vehicle for geofence testing",
    "isActive": true,
    "createdAt": "2026-06-02T15:00:00.000Z",
    "updatedAt": "2026-06-02T15:00:00.000Z"
  }
}
```

### PATCH `/api/v1/tracked-devices/:id`

Updates an existing tracked device.

#### Update Tracked Device Example Request

```json
{
  "name": "Delivery Vehicle 001 Updated",
  "isActive": true
}
```

#### Update Tracked Device Example Response

```json
{
  "message": "Tracked device updated successfully",
  "data": {
    "id": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "name": "Delivery Vehicle 001 Updated",
    "isActive": true,
    "updatedAt": "2026-06-02T15:10:00.000Z"
  }
}
```

### DELETE `/api/v1/tracked-devices/:id`

Deletes or deactivates a tracked device.

For the MVP, soft deactivation may be preferred over permanent deletion by setting `isActive` to `false`.

#### Deactivate Tracked Device Example Response

```json
{
  "message": "Tracked device deactivated successfully",
  "data": {
    "id": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "isActive": false,
    "updatedAt": "2026-06-02T15:15:00.000Z"
  }
}
```

---

## Location Event Endpoints

Location event endpoints store submitted latitude and longitude records from tracked devices.

### GET `/api/v1/location-events`

Returns submitted location events.

Possible future query filters:

```text
deviceId
from
to
limit
```

#### List Location Events Example Response

```json
{
  "data": [
    {
      "id": "fbb4a49e-7de5-4991-85d6-30f81e0e72c1",
      "deviceId": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
      "latitude": 30.3119,
      "longitude": -95.4561,
      "accuracyMeters": 10,
      "recordedAt": "2026-06-02T15:00:00.000Z",
      "receivedAt": "2026-06-02T15:00:01.000Z"
    }
  ]
}
```

### POST `/api/v1/location-events`

Submits a new location event.

When a location event is submitted, the backend can evaluate the point against active geofences and generate alert events if needed.

#### Submit Location Event Example Request

```json
{
  "deviceId": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
  "latitude": 30.3119,
  "longitude": -95.4561,
  "accuracyMeters": 10,
  "recordedAt": "2026-06-02T15:00:00.000Z"
}
```

#### Submit Location Event Example Response

```json
{
  "message": "Location event recorded successfully",
  "data": {
    "id": "fbb4a49e-7de5-4991-85d6-30f81e0e72c1",
    "deviceId": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "latitude": 30.3119,
    "longitude": -95.4561,
    "accuracyMeters": 10,
    "recordedAt": "2026-06-02T15:00:00.000Z",
    "receivedAt": "2026-06-02T15:00:01.000Z",
    "alertsCreated": 1
  }
}
```

### GET `/api/v1/location-events/:id`

Returns one location event by ID.

#### Get Location Event by ID Example Response

```json
{
  "data": {
    "id": "fbb4a49e-7de5-4991-85d6-30f81e0e72c1",
    "deviceId": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "latitude": 30.3119,
    "longitude": -95.4561,
    "accuracyMeters": 10,
    "recordedAt": "2026-06-02T15:00:00.000Z",
    "receivedAt": "2026-06-02T15:00:01.000Z"
  }
}
```

---

## Alert Event Endpoints

Alert event endpoints expose geofence enter, exit, and violation history.

### GET `/api/v1/alert-events`

Returns alert events.

Possible future query filters:

```text
deviceId
geofenceId
eventType
severity
status
from
to
limit
```

#### List Alert Events Example Response

```json
{
  "data": [
    {
      "id": "8dc396fa-fad0-4568-a220-3d8b8025d218",
      "geofenceId": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
      "deviceId": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
      "locationEventId": "fbb4a49e-7de5-4991-85d6-30f81e0e72c1",
      "eventType": "enter",
      "severity": "medium",
      "latitude": 30.3119,
      "longitude": -95.4561,
      "message": "Delivery Vehicle 001 entered Warehouse Zone",
      "status": "open",
      "createdAt": "2026-06-02T15:00:01.000Z",
      "resolvedAt": null
    }
  ]
}
```

### GET `/api/v1/alert-events/:id`

Returns one alert event by ID.

#### Get Alert Event by ID Example Response

```json
{
  "data": {
    "id": "8dc396fa-fad0-4568-a220-3d8b8025d218",
    "geofenceId": "7c0efc5e-9a64-4f66-b3c0-35b042e8d101",
    "deviceId": "c2a4186f-6f19-4f08-b0a2-1c5c46c91c99",
    "locationEventId": "fbb4a49e-7de5-4991-85d6-30f81e0e72c1",
    "eventType": "enter",
    "severity": "medium",
    "latitude": 30.3119,
    "longitude": -95.4561,
    "message": "Delivery Vehicle 001 entered Warehouse Zone",
    "status": "open",
    "createdAt": "2026-06-02T15:00:01.000Z",
    "resolvedAt": null
  }
}
```

### PATCH `/api/v1/alert-events/:id`

Updates an alert event status.

#### Update Alert Event Example Request

```json
{
  "status": "acknowledged"
}
```

#### Update Alert Event Example Response

```json
{
  "message": "Alert event updated successfully",
  "data": {
    "id": "8dc396fa-fad0-4568-a220-3d8b8025d218",
    "status": "acknowledged",
    "updatedAt": "2026-06-02T15:10:00.000Z"
  }
}
```

---

## Standard Response Format

Successful responses should use a consistent structure.

```json
{
  "message": "Operation completed successfully",
  "data": {}
}
```

List responses should return arrays inside `data`.

```json
{
  "data": []
}
```

---

## Standard Error Format

Error responses should use a consistent structure.

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "timestamp": "2026-06-02T15:00:00.000Z",
  "path": "/api/v1/geofences"
}
```

---

## Planned HTTP Status Codes

| Status Code | Meaning |
| --- | --- |
| 200 | Successful read or update |
| 201 | Resource created |
| 400 | Invalid request data |
| 401 | Missing or invalid authentication |
| 404 | Resource not found |
| 409 | Resource conflict |
| 500 | Internal server error |

---

## MVP Endpoint Priority

| Priority | Endpoint |
| --- | --- |
| High | `GET /api/v1/health` |
| High | `GET /api/v1/status` |
| High | `POST /api/v1/geofences` |
| High | `GET /api/v1/geofences` |
| High | `POST /api/v1/tracked-devices` |
| High | `GET /api/v1/tracked-devices` |
| High | `POST /api/v1/location-events` |
| High | `GET /api/v1/location-events` |
| High | `GET /api/v1/alert-events` |
| Medium | `GET /api/v1/geofences/:id` |
| Medium | `PATCH /api/v1/geofences/:id` |
| Medium | `GET /api/v1/tracked-devices/:id` |
| Medium | `PATCH /api/v1/tracked-devices/:id` |
| Medium | `GET /api/v1/location-events/:id` |
| Medium | `GET /api/v1/alert-events/:id` |
| Medium | `PATCH /api/v1/alert-events/:id` |

---

## Future Endpoint Considerations

Future versions may include:

- API key management endpoints
- Webhook notification endpoints
- Alert statistics endpoints
- Geofence rule configuration endpoints
- Device status history endpoints
- Polygon geofence validation endpoints
- Audit log endpoints
- Admin/user management endpoints

---

## Portfolio Relevance

This endpoint design demonstrates:

- REST API planning
- Backend route organization
- Geospatial workflow modeling
- Event-driven API design
- Consistent request and response formatting
- Documentation-first backend development
