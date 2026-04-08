import test from 'node:test';
import assert from 'node:assert/strict';

test('assertProviderCredentials fails with a clear Claude setup message', async () => {
  const { assertProviderCredentials } = await import('../dist/llm/providers.js');
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    assert.throws(
      () =>
        assertProviderCredentials(
          {
            garrisonDir: '/tmp/ai-garrison',
            configDir: '/tmp/.garrison',
            registryPath: '/tmp/.garrison/registry.json',
            authDir: '/tmp/.garrison/auth',
            llm: {
              provider: 'claude',
              model: 'claude-sonnet-4-20250514',
            },
          },
          'Notebook ingestion'
        ),
      /ANTHROPIC_API_KEY/
    );
  } finally {
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  }
});