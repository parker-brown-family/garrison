# garrison

Ingest Google NotebookLM notebooks into local Jupyter notebooks for offline analysis.

Garrison scrapes your NotebookLM notebook — sources, notes, summaries, and generated study materials — and writes it all to a local `.ipynb` file you own and can query however you like.

## How it works

1. **Scrape** — Playwright authenticates with your Google account and pulls the full notebook content, clicking through each source to capture body text and URLs.
2. **Extract** — Source structure is assembled locally from the scraped DOM. An LLM call enriches the result with per-source summaries, cross-cutting notes, and study materials (study guide, briefing doc, FAQ, timeline).
3. **Write** — A Jupyter notebook is written to `~/ai-garrison/notebooks/<name>/notebook.ipynb`, alongside individual source markdown files and a `fruits/` workspace for downstream analysis.

The LLM only sees metadata and summaries — not the full source text — keeping costs low even for large notebooks.

## Requirements

- Node.js 20+
- Google Chrome (used by Playwright)
- An API key for one of the supported LLM providers

## Installation

```bash
git clone https://github.com/parker-brown-family/garrison.git
cd garrison
npm install
npm run build
npm link          # makes `garrison` available globally
npx playwright install chromium
```

## Setup

On first run, garrison creates `~/.garrison/config.yaml` with defaults:

```yaml
llm:
  provider: claude
  model: claude-sonnet-4-20250514
```

Edit this file to switch providers or models.

### LLM providers

| Provider | Config value | Environment variable |
|----------|-------------|----------------------|
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |

Set the relevant environment variable before running garrison.

### Google authentication

The first time you target a NotebookLM URL, garrison opens a visible Chrome window for you to log in manually. The session is saved to `~/.garrison/auth/` and reused on subsequent runs.

## Commands

```
garrison assess <link>      Estimate cost and scope before ingesting. Read-only.
garrison new <name> <link>  Ingest a NotebookLM notebook for the first time.
garrison update <name>      Re-scrape and rebuild an existing notebook.
garrison status             List all registered notebooks with size and token usage.
```

Run `garrison` with no arguments to get an interactive prompt.

### Examples

```bash
# See what a notebook contains and roughly what it will cost before committing
garrison assess "https://notebooklm.google.com/notebook/abc123"

# Ingest a notebook and name it locally
garrison new my-research "https://notebooklm.google.com/notebook/abc123"

# Pull fresh content after you've added sources to the notebook
garrison update my-research

# See all ingested notebooks
garrison status
```

## Output structure

```
~/ai-garrison/notebooks/<name>/
  notebook.ipynb        # Jupyter notebook: title, summary, sources, notes, study materials
  manifest.json         # Metadata: source count, timestamps, token usage
  sources/
    01-<title>.md       # Full content for each source
    02-<title>.md
    ...
  fruits/               # Workspace for downstream AI-generated digests and reports
```

The notebook contains:
- Title, source URL, ingestion timestamp
- Raw notebook summary
- All sources with titles, types, URLs, summaries, and full content
- LLM-generated notes capturing cross-cutting themes
- Study guide, briefing document, FAQ, and timeline (when content warrants)
- An empty analysis workspace cell for your own code

## Cost

The enrichment LLM call sends only source metadata (titles, types, URLs, content previews) — not full body text. For a notebook with 100+ sources this typically costs a few cents with Claude Sonnet or GPT-4o.

Use `garrison assess` first to get an estimate before ingesting.

## License

MIT
