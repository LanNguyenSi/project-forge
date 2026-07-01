import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for lib/ai-provider.ts.
 *
 * getAiCapabilities() is a pure env-reading function — tests all 4 provider
 * branches by toggling env vars.
 *
 * generateStructuredJson() (and, through it, the private parseJsonObject
 * branches: valid JSON / fenced code block / brace-substring extraction from
 * prose / empty-response throw / not-valid-JSON throw) is exercised through
 * a mocked OpenAI SDK client, since parseJsonObject itself is not exported.
 */

const { mockCreate, mockOpenAiCtor } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockOpenAiCtor: vi.fn(),
}));

vi.mock('openai', () => ({
  // Regular function (not arrow) so it can be called with `new`, matching
  // the `new OpenAI(...)` call site in lib/ai-provider.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: vi.fn(function MockOpenAI(this: any, config: unknown) {
    mockOpenAiCtor(config);
    this.chat = { completions: { create: mockCreate } };
  }),
}));

import { getAiCapabilities, generateStructuredJson } from '@/lib/ai-provider';

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
  mockCreate.mockReset();
  mockOpenAiCtor.mockReset();
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

function completionWith(content: string | null | undefined) {
  return { choices: [{ message: { content } }] };
}

interface Parsed {
  foo: string;
}

describe('generateStructuredJson', () => {
  it('rejects with "No AI provider configured" when no AI env vars are set, without touching the OpenAI SDK', async () => {
    await expect(generateStructuredJson('sys', 'user')).rejects.toThrow('No AI provider configured');
    expect(mockOpenAiCtor).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  describe('parseJsonObject branches (exercised through the parsed content)', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
    });

    it('parses a plain JSON object response', async () => {
      mockCreate.mockResolvedValue(completionWith('{"foo":"bar"}'));

      const result = await generateStructuredJson<Parsed>('sys', 'user');

      expect(result.data).toEqual({ foo: 'bar' });
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o-mini');
    });

    it('parses JSON wrapped in a ```json fenced code block', async () => {
      mockCreate.mockResolvedValue(
        completionWith('Here you go:\n```json\n{"foo":"fenced"}\n```\nHope that helps!')
      );

      const result = await generateStructuredJson<Parsed>('sys', 'user');

      expect(result.data).toEqual({ foo: 'fenced' });
    });

    it('extracts a JSON object via brace-substring from surrounding prose (no fence)', async () => {
      mockCreate.mockResolvedValue(
        completionWith('Sure, the result is {"foo":"prose"} — let me know if you need more.')
      );

      const result = await generateStructuredJson<Parsed>('sys', 'user');

      expect(result.data).toEqual({ foo: 'prose' });
    });

    it('throws "AI returned an empty response" for an empty string response', async () => {
      mockCreate.mockResolvedValue(completionWith(''));

      await expect(generateStructuredJson('sys', 'user')).rejects.toThrow('AI returned an empty response');
    });

    it('throws "AI returned an empty response" for a whitespace-only (blank) response', async () => {
      mockCreate.mockResolvedValue(completionWith('   \n\t  '));

      await expect(generateStructuredJson('sys', 'user')).rejects.toThrow('AI returned an empty response');
    });

    it('throws "AI returned an empty response" when message.content is missing entirely', async () => {
      mockCreate.mockResolvedValue({ choices: [{ message: {} }] });

      await expect(generateStructuredJson('sys', 'user')).rejects.toThrow('AI returned an empty response');
    });

    it('throws "AI response was not valid JSON" for prose with no braces and no fence (malformed response)', async () => {
      mockCreate.mockResolvedValue(completionWith('Sorry, I cannot help with that request.'));

      await expect(generateStructuredJson('sys', 'user')).rejects.toThrow('AI response was not valid JSON');
    });
  });

  describe('API-error branch', () => {
    it('propagates a rejected OpenAI SDK call (e.g. network/rate-limit error)', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      mockCreate.mockRejectedValue(new Error('OpenAI API rate limit exceeded'));

      await expect(generateStructuredJson('sys', 'user')).rejects.toThrow('OpenAI API rate limit exceeded');
    });
  });

  describe('provider-specific request shaping', () => {
    it('omits response_format for the local provider', async () => {
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434';
      process.env.LOCAL_AI_MODEL = 'llama3';
      mockCreate.mockResolvedValue(completionWith('{"foo":"local"}'));

      await generateStructuredJson<Parsed>('sys', 'user');

      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.response_format).toBeUndefined();
      expect(callArg.model).toBe('llama3');
    });

    it('includes response_format: json_object for hosted providers (openai)', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      mockCreate.mockResolvedValue(completionWith('{"foo":"hosted"}'));

      await generateStructuredJson<Parsed>('sys', 'user');

      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.response_format).toEqual({ type: 'json_object' });
    });

    it('defaults temperature to 0.2 and max_tokens to 800 when options are omitted', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      mockCreate.mockResolvedValue(completionWith('{"foo":"defaults"}'));

      await generateStructuredJson<Parsed>('sys', 'user');

      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.temperature).toBe(0.2);
      expect(callArg.max_tokens).toBe(800);
    });

    it('honors explicit temperature and maxTokens overrides', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      mockCreate.mockResolvedValue(completionWith('{"foo":"override"}'));

      await generateStructuredJson<Parsed>('sys', 'user', { temperature: 0.9, maxTokens: 42 });

      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.temperature).toBe(0.9);
      expect(callArg.max_tokens).toBe(42);
    });

    it('constructs the OpenAI client with the provider apiKey and baseURL, and sends system+user messages', async () => {
      process.env.GROQ_API_KEY = 'gsk_test_key';
      mockCreate.mockResolvedValue(completionWith('{"foo":"groq"}'));

      await generateStructuredJson<Parsed>('system prompt text', 'user prompt text');

      expect(mockOpenAiCtor).toHaveBeenCalledWith({
        apiKey: 'gsk_test_key',
        baseURL: 'https://api.groq.com/openai/v1',
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.messages).toEqual([
        { role: 'system', content: 'system prompt text' },
        { role: 'user', content: 'user prompt text' },
      ]);
    });
  });
});
