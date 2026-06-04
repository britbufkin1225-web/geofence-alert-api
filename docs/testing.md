# Testing

This document tracks the current testing state for the GeoFence Alert API.

## Test Framework

This project uses Jest for backend unit testing.

Tests are located alongside source files using the `.spec.ts` naming pattern.

Current examples:

```text
src/geofences/geofences.service.spec.ts
src/geofences/geofences.controller.spec.ts
```

## Running Tests

Run the full test suite with:

```bash
npm run test
```

## Current Verified Test State

The current verified test state is:

```text
Test Suites: 1 passed
Tests: 3 passed
```

## Current Test Coverage

Current test coverage includes geofence summary service behavior.

The summary test suite verifies:

- Aggregate geofence summary counts
- Empty-state summary behavior
- Mixed-status summary behavior

## Planned Test Coverage

Additional planned test coverage includes:

- Geofence creation behavior
- Geofence retrieval behavior
- Geofence update behavior
- Geofence deletion behavior
- Pagination behavior
- Status filtering behavior
- Controller route behavior
- Not-found error handling
- DTO validation edge cases
- Alert workflow behavior

## Testing Notes

Testing should be updated whenever new service methods, controller routes, DTO rules, or query behavior are added.

Each completed backend workflow should include either:

- A passing unit test
- A documented manual verification step
- A note explaining why the behavior is not currently test-covered