import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAiCapabilities } from '@/lib/ai-provider';

/**
 * Unit tests for lib/ai-provider.ts — getAiCapabilities() is a pure
 * env-reading function. Tests all 4 provider branches by toggling env vars.
 *
 * generateStructuredJson requires an OpenAI SDK mock and is deferred.
 */

// AI env var keys managed by these tests
const AI_ENV_KEYS = [
  'LOCAL_AI_BASE_URL',
  'LOCAL_AI_MODEL',
  'LOCAL_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
] as const;

// Save and restore AI env vars around each test so tests are isolated
// from each other AND from whatever the CI/dev env has set.
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of AI_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    const val = saved[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

describe('getAiCapabilities', () => {
  describe('local provider', () => {
    it('returns enabled=true with provider=local when LOCAL_AI_BASE_URL + LOCAL_AI_MODEL are set', () => {
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434';
      process.env.LOCAL_AI_MODEL = 'llama3';

      const caps = getAiCapabilities();

      expect(caps.enabled).toBe(true);
      expect(caps.provider).toBe('local');
      expect(caps.model).toBe('llama3');
      expect(caps.maxContextChars).toBe(20000);
      expect(caps.features.magicFill).toBe(true);
      expect(caps.features.intakeEnrichment).toBe(true);
      expect(caps.features.postScaffoldReview).toBe(true);
    });

    it('local provider takes priority over GROQ_API_KEY when both are set', () => {
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434';
      process.env.LOCAL_AI_MODEL = 'llama3';
      process.env.GROQ_API_KEY = 'gsk_would_be_ignored';

      const caps = getAiCapabilities();

      expect(caps.provider).toBe('local');
    });
  });

  describe('groq provider', () => {
    it('returns enabled=true with provider=groq when GROQ_API_KEY is set', () => {
      process.env.GROQ_API_KEY = 'gsk_test_key';

      const caps = getAiCapabilities();

      expect(caps.enabled).toBe(true);
      expect(caps.provider).toBe('groq');
      expect(caps.model).toBe('llama-3.3-70b-versatile');
      expect(caps.maxContextChars).toBe(50000);
      expect(caps.features.magicFill).toBe(true);
    });

    it('groq takes priority over OPENAI_API_KEY when both are set and no local env', () => {
      process.env.GROQ_API_KEY = 'gsk_test_key';
      process.env.OPENAI_API_KEY = 'sk_would_be_ignored';

      const caps = getAiCapabilities();

      expect(caps.provider).toBe('groq');
    });
  });

  describe('openai provider', () => {
    it('returns enabled=true with provider=openai when only OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const caps = getAiCapabilities();

      expect(caps.enabled).toBe(true);
      expect(caps.provider).toBe('openai');
      expect(caps.model).toBe('gpt-4o-mini');
      expect(caps.maxContextChars).toBe(50000);
      expect(caps.features.postScaffoldReview).toBe(true);
    });
  });

  describe('no provider configured', () => {
    it('returns enabled=false with null provider when no AI env vars are set', () => {
      // All keys deleted in beforeEach; nothing to set here.
      const caps = getAiCapabilities();

      expect(caps.enabled).toBe(false);
      expect(caps.provider).toBeNull();
      expect(caps.model).toBeNull();
      // Default context chars apply even when disabled
      expect(caps.maxContextChars).toBe(50000);
      expect(caps.features.magicFill).toBe(false);
      expect(caps.features.intakeEnrichment).toBe(false);
      expect(caps.features.postScaffoldReview).toBe(false);
    });
  });
});
