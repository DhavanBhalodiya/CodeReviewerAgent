/**
 * Diff utilities for smart per-file chunking.
 *
 * A raw unified diff is split into per-file slices so the prompt budget can be
 * allocated granularly instead of hard-truncating the whole diff mid-file.
 */

/**
 * Split a unified diff string into an array of per-file chunks.
 * Each chunk carries the filename and the raw diff text for that file.
 *
 * @param {string} rawDiff - Full unified diff text.
 * @returns {{ filename: string; diff: string }[]}
 */
export function splitDiffByFile(rawDiff) {
  const chunks = [];
  // Split on "diff --git a/<file> b/<file>" boundaries
  const parts = rawDiff.split(/^(?=diff --git )/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract the new filename from the +++ b/<path> line
    const match = trimmed.match(/^\+\+\+ b\/(.+)$/m);
    const filename = match ? match[1].trim() : "unknown";

    chunks.push({ filename, diff: trimmed });
  }

  return chunks;
}

/**
 * Fill a character budget from the per-file chunks, annotating any that were
 * dropped so the model knows the diff was intentionally limited.
 *
 * @param {{ filename: string; diff: string }[]} chunks
 * @param {number} maxChars
 * @returns {string} - Combined diff text that fits within maxChars.
 */
export function budgetDiff(chunks, maxChars) {
  const included = [];
  const skipped = [];
  let used = 0;

  for (const chunk of chunks) {
    if (used + chunk.diff.length <= maxChars) {
      included.push(chunk.diff);
      used += chunk.diff.length;
    } else {
      // Try to include a partial slice so we don't lose the file header
      const remaining = maxChars - used;
      if (remaining > 200) {
        const partial = chunk.diff.slice(0, remaining);
        included.push(partial + `\n...[${chunk.filename}: diff truncated for length]`);
        used = maxChars;
      } else {
        skipped.push(chunk.filename);
      }
      break;
    }
  }

  if (skipped.length > 0) {
    included.push(
      `\n# The following files were omitted due to diff size limits:\n` +
        skipped.map((f) => `#   - ${f}`).join("\n")
    );
  }

  return included.join("\n\n");
}
