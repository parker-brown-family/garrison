import test from 'node:test';
import assert from 'node:assert/strict';

test('parseWorkflowSelection accepts numeric and named selections', async () => {
  const { parseWorkflowSelection } = await import('../dist/workflow.js');

  assert.equal(parseWorkflowSelection('1'), 'assess');
  assert.equal(parseWorkflowSelection('status'), 'status');
  assert.equal(parseWorkflowSelection('QUIT'), 'exit');
  assert.equal(parseWorkflowSelection('unknown'), null);
});

test('runWorkflowLauncher retries invalid selection and dispatches status', async () => {
  const { runWorkflowLauncher } = await import('../dist/workflow.js');
  const answers = ['0', 'status', '6'];
  const output = [];
  const calls = [];

  await runWorkflowLauncher(
    {
      assess: async () => calls.push('assess'),
      createNotebook: async () => calls.push('new'),
      updateNotebook: async () => calls.push('update'),
      showStatus: async () => calls.push('status'),
      showHelp: async () => calls.push('help'),
      getNotebookList: async () => [],
    },
    {
      prompt: async () => answers.shift() ?? '',
      write: (message) => output.push(message),
      close: () => {},
    }
  );

  assert.deepEqual(calls, ['status']);
  assert.match(output.join(''), /Invalid selection/);
  assert.match(output.join(''), /Garrison Workflow Launcher/);
  assert.match(output.join(''), /Returning to workflow menu/);
});

test('runWorkflowLauncher collects name and link for new workflow', async () => {
  const { runWorkflowLauncher } = await import('../dist/workflow.js');
  const answers = ['2', 'market-scan', 'https://example.com/notebook', '6'];
  const received = [];

  await runWorkflowLauncher(
    {
      assess: async () => {},
      createNotebook: async (name, link) => received.push({ name, link }),
      updateNotebook: async () => {},
      showStatus: async () => {},
      showHelp: async () => {},
      getNotebookList: async () => [],
    },
    {
      prompt: async () => answers.shift() ?? '',
      write: () => {},
      close: () => {},
    }
  );

  assert.deepEqual(received, [
    { name: 'market-scan', link: 'https://example.com/notebook' },
  ]);
});

test('runWorkflowLauncher reports handler errors and returns to the menu', async () => {
  const { runWorkflowLauncher } = await import('../dist/workflow.js');
  const answers = ['4', '6'];
  const output = [];

  await runWorkflowLauncher(
    {
      assess: async () => {},
      createNotebook: async () => {},
      updateNotebook: async () => {},
      showStatus: async () => {
        throw new Error('status blew up');
      },
      showHelp: async () => {},
      getNotebookList: async () => [],
    },
    {
      prompt: async () => answers.shift() ?? '',
      write: (message) => output.push(message),
      close: () => {},
    }
  );

  assert.match(output.join(''), /Operation failed:/);
  assert.match(output.join(''), /status blew up/);
  assert.match(output.join(''), /Returning to workflow menu/);
});