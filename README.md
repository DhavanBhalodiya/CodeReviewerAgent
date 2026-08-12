# Claude PR Reviewer

An AI-powered code review agent that automatically reviews GitHub pull requests and posts inline comments. Runs as a reusable GitHub Action, powered by Claude, OpenAI, or any OpenAI-compatible API (OpenRouter, Groq, Mistral, local Ollama, etc.).

## How it works

1. A pull request is opened or updated in a repo that uses this Action.
2. The Action fetches the PR's diff via the GitHub API.
3. The diff is sent to an LLM with instructions to review only the changed lines and flag real issues — bugs, security problems, performance concerns, missing error handling.
4. The model's response is parsed into structured comments and posted back as an inline-comment review on the PR (or a single "no issues found" comment if the diff is clean).

## Repo structure

```
CodeReviewerAgent/
├── action.yml                    # composite action definition (the "engine")
├── package.json
└── scripts/
    ├── review-pr.js               # main logic: fetch diff → call LLM → post review
    └── providers/
        ├── anthropic.js
        ├── openai.js
        └── compatible.js          # any OpenAI-compatible endpoint (OpenRouter, Groq, etc.)
```

This repo only needs to be set up **once**. Any other repo can then use it by referencing `uses: <your-username>/CodeReviewerAgent@main` in a small workflow file — no need to copy scripts or install dependencies elsewhere.

## Using this in another repo

Add one file to the target repo at `.github/workflows/pr-review.yml` (filename can be anything, this path is just a convention):

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: <your-username>/CodeReviewerAgent@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          llm-provider: anthropic
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Then in that repo's **Settings**:

1. **Secrets and variables → Actions → Secrets** — add whichever key(s) the provider needs (see table below). Secrets do not carry over between repos; each repo needs its own.
2. **Actions → General → Workflow permissions** — set to **Read and write permissions**, or the Action can run but won't be able to post comments.

Push to the repo's default branch, then open a pull request to trigger a run. Check the **Actions** tab to watch it live.

## Provider options

| `llm-provider` | Required inputs | Notes |
|---|---|---|
| `anthropic` (default) | `anthropic-api-key` | Uses Claude. Default model: `claude-sonnet-5` |
| `openai` | `openai-api-key` | Default model: `gpt-4o` |
| `compatible` | `llm-api-key`, `llm-base-url` | Works with OpenRouter, Groq, Mistral, local Ollama, etc. |

All providers accept an optional `llm-model` input to override the default, e.g.:

```yaml
llm-model: claude-opus-4-8
```

### Example: using OpenRouter

```yaml
      - uses: <your-username>/CodeReviewerAgent@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          llm-provider: compatible
          llm-base-url: https://openrouter.ai/api/v1
          llm-model: anthropic/claude-sonnet-5
          llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No runs appear in the Actions tab | Workflow file isn't on the default branch, or it's in the wrong repo (PRs only trigger workflows that live in the *same* repo as the PR) |
| `Missing API key for provider "..."` | Secret name in `secrets.X` doesn't exactly match the name you gave it in repo settings |
| Run succeeds but no comments appear | Workflow permissions aren't set to "Read and write" |
| Workflow doesn't rerun after editing the file | Changes must be committed and pushed to the PR's own branch — edits only on `main` don't affect an already-open PR |

## Notes and limits

- Diffs over 100,000 characters are truncated to keep prompt size reasonable (`MAX_DIFF_CHARS` in `review-pr.js`).
- Comments are capped at 25 per PR, prioritizing critical and warning issues.
- The reviewer only comments on changed lines, not the whole file.
- Runs on every push to an open PR by default (`synchronize`); adjust the `on.pull_request.types` list if you want fewer runs on active PRs.
