#!/usr/bin/env node
/**
 * AI PR Reviewer
 *
 * Fetches a PR's diff, sends it to the configured LLM provider for review,
 * and posts the results as:
 *   1. Inline review comments on the relevant diff lines.
 *   2. A top-level summary comment with a severity breakdown table.
 */

import { Octokit } from "@octokit/rest";
import { reviewWithAnthropic } from "./providers/anthropic.js";
import { reviewWithOpenAI } from "./providers/openai.js";
import { reviewWithCompatible } from "./providers/compatible.js";
import { splitDiffByFile, budgetDiff } from "./utils/diff.js";
import { logger } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Environment & configuration
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    logger.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const GITHUB_TOKEN      = requireEnv("GITHUB_TOKEN");
const PR_NUMBER         = Number(requireEnv("PR_NUMBER"));
const GITHUB_REPOSITORY = requireEnv("GITHUB_REPOSITORY");

if (isNaN(PR_NUMBER) || PR_NUMBER <= 0) {
  logger.error("PR_NUMBER must be a positive integer.", { value: process.env.PR_NUMBER });
  process.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split("/");
if (!owner || !repo) {
  logger.error("GITHUB_REPOSITORY must be in the format owner/repo.", { value: GITHUB_REPOSITORY });
  process.exit(1);
}

// Provider selection — switch via repo/org variable, no code changes needed.
const LLM_PROVIDER  = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
const LLM_MODEL     = process.env.LLM_MODEL     || "";   // optional; falls back to per-provider default
const LLM_BASE_URL  = process.env.LLM_BASE_URL  || "";   // only used by "compatible" provider

const API_KEYS = {
  anthropic:  process.env.ANTHROPIC_API_KEY,
  openai:     process.env.OPENAI_API_KEY,
  compatible: process.env.LLM_API_KEY,
};

const PROVIDERS = {
  anthropic:  reviewWithAnthropic,
  openai:     reviewWithOpenAI,
  compatible: reviewWithCompatible,
};

const MAX_DIFF_CHARS = 100_000; // total character budget across all files

// ---------------------------------------------------------------------------
// Octokit client
// ---------------------------------------------------------------------------

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior software engineer conducting a thorough code review on a GitHub pull request diff.

## Your task
Review ONLY the lines that appear as additions (+) or deletions (-) in the diff.
Do NOT comment on unchanged context lines.

## Severity rubric
- **critical**: Bugs, security vulnerabilities, data-loss risks, or broken logic that must be fixed before merge.
- **warning**: Non-critical issues such as missing error handling, performance problems, or unclear logic that should be addressed.
- **suggestion**: Minor improvements: naming clarity, code organisation, or missing tests — only when they materially affect maintainability.

## Rules
1. Think carefully before generating output. Scan the entire diff first, then produce your findings.
2. Do NOT invent issues to pad the output. If a file is clean, skip it entirely.
3. Do NOT comment on purely cosmetic style (spacing, trailing commas, etc.) unless they harm readability.
4. Cap output at 25 comments, prioritising critical → warning → suggestion.
5. Respond with ONLY a valid JSON array — no prose, no markdown fences, no explanation.

## Output schema (each element)
{
  "file":     "<path exactly as shown in the diff>",
  "line":     <integer — line number in the NEW version of the file>,
  "severity": "critical" | "warning" | "suggestion",
  "comment":  "<specific, actionable review comment, 1–3 sentences>"
}

If there is genuinely nothing worth flagging, respond with an empty array: []`;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

async function getDiff() {
  logger.info("Fetching PR diff from GitHub...", { owner, repo, pr: PR_NUMBER });

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: PR_NUMBER,
    mediaType: { format: "diff" },
  });

  const rawDiff = typeof data === "string" ? data : String(data);

  if (!rawDiff.trim()) {
    return "";
  }

  logger.debug("Raw diff fetched.", { chars: rawDiff.length });

  const chunks = splitDiffByFile(rawDiff);
  logger.info(`Diff split into ${chunks.length} file(s).`);

  const budgeted = budgetDiff(chunks, MAX_DIFF_CHARS);
  if (budgeted.length < rawDiff.length) {
    logger.warn("Diff exceeded budget and was trimmed.", {
      original: rawDiff.length,
      trimmed: budgeted.length,
      budget: MAX_DIFF_CHARS,
    });
  }

  return budgeted;
}

async function askLLM(diffText) {
  const runProvider = PROVIDERS[LLM_PROVIDER];
  if (!runProvider) {
    logger.error(`Unknown LLM_PROVIDER "${LLM_PROVIDER}".`, {
      valid: Object.keys(PROVIDERS).join(", "),
    });
    process.exit(1);
  }

  const apiKey = API_KEYS[LLM_PROVIDER];
  if (!apiKey && LLM_PROVIDER !== "compatible") {
    logger.error(`Missing API key for provider "${LLM_PROVIDER}".`, {
      hint: "Check your repository secrets.",
    });
    process.exit(1);
  }

  logger.info(`Sending diff to LLM provider "${LLM_PROVIDER}"...`, {
    model: LLM_MODEL || "(provider default)",
  });

  const rawText = await runProvider({
    apiKey,
    model: LLM_MODEL,
    baseURL: LLM_BASE_URL,
    systemPrompt: SYSTEM_PROMPT,
    diffText,
  });

  // Strip accidental markdown fences the model may have included despite instructions
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      logger.warn("LLM returned non-array JSON; treating as empty.", { parsed });
      return [];
    }
    return parsed;
  } catch (err) {
    logger.error("Could not parse LLM response as JSON.", { raw: cleaned.slice(0, 500) });
    return [];
  }
}

async function postReview(comments) {
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: PR_NUMBER });
  const commitId = pr.head.sha;

  const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: PR_NUMBER });
  const validFiles = new Set(files.map((f) => f.filename));

  // Filter to comments that reference actual files and line numbers in this PR
  const reviewComments = comments
    .filter((c) => c.file && c.line && validFiles.has(c.file))
    .map((c) => ({
      path: c.file,
      line: c.line,
      side: "RIGHT",
      body: formatInlineComment(c),
    }));

  const skipped = comments.length - reviewComments.length;
  if (skipped > 0) {
    logger.warn(`${skipped} comment(s) skipped — file or line not found in PR.`);
  }

  const summaryBody = buildSummaryComment(comments, reviewComments.length);

  if (reviewComments.length === 0) {
    // No actionable inline comments — post a summary-only issue comment
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: PR_NUMBER,
      body: summaryBody,
    });
    logger.info("No inline comments to post. Summary comment created.");
    return;
  }

  // Post the full review with inline comments + summary body
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: PR_NUMBER,
    commit_id: commitId,
    event: "COMMENT",
    body: summaryBody,
    comments: reviewComments,
  });

  logger.info("Review posted successfully.", { inlineComments: reviewComments.length });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI = {
  critical:   "🔴",
  warning:    "🟡",
  suggestion: "🔵",
};

function formatInlineComment(c) {
  const emoji = SEVERITY_EMOJI[c.severity] ?? "⚪";
  const label = (c.severity || "suggestion").toUpperCase();
  return `${emoji} **${label}**\n\n${c.comment}`;
}

function buildSummaryComment(allComments, postedCount) {
  const counts = { critical: 0, warning: 0, suggestion: 0 };
  for (const c of allComments) {
    if (c.severity in counts) counts[c.severity]++;
  }

  const total = allComments.length;

  if (total === 0) {
    return `## 🤖 AI Code Review\n\n✅ **No significant issues found.** The changes look good to merge.`;
  }

  const rows = [
    `| Severity | Count |`,
    `|---|---|`,
    `| 🔴 Critical   | ${counts.critical}   |`,
    `| 🟡 Warning    | ${counts.warning}    |`,
    `| 🔵 Suggestion | ${counts.suggestion} |`,
    `| **Total**     | **${total}**         |`,
  ].join("\n");

  const note =
    postedCount < total
      ? `\n> ⚠️ ${total - postedCount} comment(s) could not be placed inline (file/line mismatch) and are omitted.`
      : "";

  return `## 🤖 AI Code Review\n\n${rows}${note}\n\n> Review generated automatically. Please use your own judgement before merging.`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run() {
  logger.info(`Starting AI code review for PR #${PR_NUMBER} in ${owner}/${repo}.`, {
    provider: LLM_PROVIDER,
    model: LLM_MODEL || "(provider default)",
  });

  const diffText = await getDiff();

  if (!diffText.trim()) {
    logger.info("Empty diff — nothing to review.");
    return;
  }

  const comments = await askLLM(diffText);
  logger.info(`LLM returned ${comments.length} comment(s).`);

  await postReview(comments);
  logger.info("Done.");
}

run().catch((err) => {
  logger.error("PR review failed.", { message: err.message, stack: err.stack });
  process.exit(1);
});
