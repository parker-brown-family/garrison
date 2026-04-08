import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('buildNotebook creates project fruits workspace alongside notebook assets', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'garrison-notebook-'));

  try {
    const { buildNotebook } = await import('../dist/notebook.js');
    const notebookPath = await buildNotebook({
      notebookTitle: 'Demo Notebook',
      rawSummary: 'Summary',
      sources: [{
        title: 'Source One',
        type: 'website',
        summary: 'Short summary',
        content: 'Full content',
        url: 'https://example.com/source',
      }],
      notes: [],
    }, tempRoot, 'demo-project', 'https://example.com/notebook');

    const projectDir = join(tempRoot, 'demo-project');
    const sourcesDir = join(projectDir, 'sources');
    const fruitsDir = join(projectDir, 'fruits');
    const manifestPath = join(projectDir, 'manifest.json');

    assert.equal(notebookPath, join(projectDir, 'notebook.ipynb'));
    assert.equal((await stat(sourcesDir)).isDirectory(), true);
    assert.equal((await stat(fruitsDir)).isDirectory(), true);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'demo-project');
    assert.equal(manifest.sourceCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});