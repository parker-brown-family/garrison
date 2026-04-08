import test from 'node:test';
import assert from 'node:assert/strict';

test('looksLikeNotebookShell detects NotebookLM chrome and empty-state text', async () => {
  const { looksLikeNotebookShell } = await import('../dist/scraper.js');

  assert.equal(
    looksLikeNotebookShell('Welcome to NotebookLM Create new notebook Your notebooks Upgrade'),
    true
  );
  assert.equal(
    looksLikeNotebookShell('Source 1 Example article Notes Timeline FAQ Summary of findings'),
    false
  );
});