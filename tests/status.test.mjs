import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('collectNotebookStatuses measures notebook directories and reports missing entries', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'garrison-status-'));

  try {
    const alphaDir = join(tempRoot, 'alpha');
    await mkdir(join(alphaDir, 'sources'), { recursive: true });
    await writeFile(join(alphaDir, 'notebook.ipynb'), '1234', 'utf8');
    await writeFile(join(alphaDir, 'manifest.json'), '12', 'utf8');
    await writeFile(join(alphaDir, 'sources', '01-source.md'), 'abcdef', 'utf8');

    const { collectNotebookStatuses, renderStatusReport } = await import('../dist/status.js');
    const statuses = await collectNotebookStatuses({
      notebooks: {
        alpha: {
          name: 'alpha',
          link: 'https://example.com/alpha',
          localPath: join(alphaDir, 'notebook.ipynb'),
          createdAt: '2026-03-06T00:00:00.000Z',
          updatedAt: '2026-03-06T00:00:00.000Z',
          sourceCount: 1,
          noteCount: 0,
        },
        missing: {
          name: 'missing',
          link: 'https://example.com/missing',
          localPath: join(tempRoot, 'missing', 'notebook.ipynb'),
          createdAt: '2026-03-06T00:00:00.000Z',
          updatedAt: '2026-03-06T00:00:00.000Z',
          sourceCount: 0,
          noteCount: 0,
        },
      },
    });

    assert.deepEqual(statuses, [
      { name: 'alpha', sizeBytes: 12, totalInputTokens: 0, totalOutputTokens: 0 },
      { name: 'missing', sizeBytes: null, totalInputTokens: 0, totalOutputTokens: 0 },
    ]);

    const report = renderStatusReport(statuses);
    assert.match(report, /Registered notebooks: 2/);
    assert.match(report, /alpha\s+12 B/);
    assert.match(report, /missing\s+MISSING/);
    assert.match(report, /Total size: 12 B/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});