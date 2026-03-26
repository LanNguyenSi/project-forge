# Task 006: Implement preview UI showing generated tasks, architecture overview, and file tree

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

Design and implement the capability for: preview UI showing generated tasks, architecture overview, and file tree.

## Problem

The product cannot satisfy its initial scope until preview UI showing generated tasks, architecture overview, and file tree exists as a reviewable, testable capability.

## Solution

Add a focused module for preview UI showing generated tasks, architecture overview, and file tree that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/upload/types.ts — FileUpload, StorageConfig interfaces
- lib/upload/storage.ts — Storage adapter (local disk or S3-compatible)
- lib/upload/validation.ts — File type + size validation
- lib/upload/service.ts — Upload, retrieve, delete file logic
- app/api/upload/route.ts — POST file upload endpoint (multipart)
- app/api/files/[id]/route.ts — GET file download, DELETE file
- components/FileUpload.tsx — Drag-and-drop upload component
- prisma/schema.prisma — File model with path, mimeType, size
- tests/upload/validation.test.ts — File validation tests
- tests/upload/service.test.ts — Upload logic tests

## Acceptance Criteria

- [ ] The preview UI showing generated tasks, architecture overview, and file tree capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for preview UI showing generated tasks, architecture overview, and file tree are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
