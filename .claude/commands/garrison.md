# /garrison — Garrison Research Storehouse

garrison holds locally ingested NotebookLM notebooks. Use it to look up
research, sources, and notes that have been scraped into the local storehouse.

## MCP Tools

| Tool | What |
|---|---|
| `garrison_list_notebooks` | List all registered notebooks — name, sourceCount, updatedAt |
| `garrison_notebook_info` | Metadata + source file listing for one notebook |
| `garrison_read_source` | Read one source file (markdown) in full |
| `garrison_search` | grep across sources in one notebook or all notebooks |

## Standard Workflow

When the user says "look in garrison for X":

1. Call `garrison_list_notebooks` — see what research is available.
2. Identify the relevant notebook(s) by name.
3. Call `garrison_notebook_info` on the target to get the source file list.
4. Call `garrison_search` with a precise keyword to locate relevant content.
5. Call `garrison_read_source` on the most relevant file(s) for full text.
6. Synthesize findings — cite source filenames.

## Registration

Add to your Claude MCP config (`~/.claude/settings.json`):

```json
"garrison": {
  "command": "node",
  "args": ["/path/to/garrison/dist/cli.js", "mcp"]
}
```

Restart Claude to activate the tools if not yet visible.
