# Task 011: Implement temp directory cleanup after push

## Category

feature

## Priority

P1

## Wave

wave-3

## Delivery Phase

implementation

## Depends On

- 001
- 002

## Blocks

- 013

## Summary

Design and implement the capability for: temp directory cleanup after push.

## Problem

The product cannot satisfy its initial scope until temp directory cleanup after push exists as a reviewable, testable capability.

## Solution

Add a focused module for temp directory cleanup after push that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/notifications/types.ts — Notification, Channel, Template interfaces
- lib/notifications/email.ts — Email transport (SMTP/Resend/SendGrid)
- lib/notifications/templates.ts — Email template rendering
- lib/notifications/service.ts — Send notification with channel routing
- app/api/notifications/route.ts — GET user notifications
- app/api/notifications/preferences/route.ts — GET/PUT notification settings
- prisma/schema.prisma — Notification, NotificationPreference models
- tests/notifications/email.test.ts — Email transport tests
- tests/notifications/service.test.ts — Notification logic tests

## Acceptance Criteria

- [ ] The temp directory cleanup after push capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for temp directory cleanup after push are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
