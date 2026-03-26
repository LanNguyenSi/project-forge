import { describe, it, expect } from 'vitest';
import type { ProjectInput, GenerateResponse, ErrorResponse, GenerationPreview, Task } from '../../lib/types';

/**
 * Contract tests for the /api/generate endpoint.
 * These validate type contracts and schema correctness without requiring a running server.
 * Live integration tests should be run manually against a local dev server.
 */

describe('Generate API Contract Tests', () => {
  describe('ProjectInput schema', () => {
    it('should require projectName and summary', () => {
      const valid: ProjectInput = {
        projectName: 'my-project',
        summary: 'A test project',
        features: [],
        constraints: [],
      };
      expect(valid.projectName).toBeTruthy();
      expect(valid.summary).toBeTruthy();
    });

    it('should accept optional fields', () => {
      const withOptionals: ProjectInput = {
        projectName: 'my-project',
        summary: 'A test project',
        features: ['feature 1', 'feature 2'],
        constraints: ['TypeScript only'],
        targetUsers: ['developers'],
      };
      expect(withOptionals.features).toHaveLength(2);
      expect(withOptionals.targetUsers).toHaveLength(1);
    });

    it('should handle special characters in project name', () => {
      const input: ProjectInput = {
        projectName: 'my-project_v2.0',
        summary: 'Test with special chars',
        features: [],
        constraints: [],
      };
      expect(input.projectName).toBe('my-project_v2.0');
    });
  });

  describe('GenerateResponse schema', () => {
    it('should have correct GenerationPreview shape', () => {
      const preview: GenerationPreview = {
        sessionId: 'test-uuid-123',
        projectName: 'my-project',
        tasks: [],
        architectureOverview: '# Architecture',
        fileTree: [],
        taskCount: 0,
        waveCount: 0,
      };
      expect(preview.sessionId).toBeTruthy();
      expect(Array.isArray(preview.tasks)).toBe(true);
      expect(Array.isArray(preview.fileTree)).toBe(true);
    });

    it('should have correct Task shape', () => {
      const task: Task = {
        id: '001',
        title: 'Set up repository',
        wave: 'wave-1',
        category: 'foundation',
        priority: 'P0',
        summary: 'Initialize the project',
      };
      expect(task.id).toBe('001');
      expect(task.wave).toBe('wave-1');
    });

    it('should have correct success response shape', () => {
      const response: GenerateResponse = {
        ok: true,
        preview: {
          sessionId: 'abc-123',
          projectName: 'test',
          tasks: [],
          architectureOverview: '',
          fileTree: [],
          taskCount: 0,
          waveCount: 0,
        },
      };
      expect(response.ok).toBe(true);
      expect(response.preview.sessionId).toBeTruthy();
    });
  });

  describe('ErrorResponse schema', () => {
    it('should have ok: false and error message', () => {
      const error: ErrorResponse = {
        ok: false,
        error: 'Missing required fields: projectName, summary',
      };
      expect(error.ok).toBe(false);
      expect(error.error).toBeTruthy();
    });

    it('should support optional details field', () => {
      const error: ErrorResponse = {
        ok: false,
        error: 'Generation failed',
        details: 'planforge exited with code 1',
      };
      expect(error.details).toBeTruthy();
    });
  });
});
