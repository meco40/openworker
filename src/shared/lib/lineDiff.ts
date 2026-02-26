/**
 * Lightweight line-level diff utility.
 * Uses a simple LCS (Longest Common Subsequence) approach —
 * no external dependencies required.
 */

export type DiffLineKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * Compute a line-level diff between two strings.
 * Returns an array of DiffLine entries with `same`, `added`, or `removed` markers.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;

  const lcs: number[][] = [];
  for (let i = 0; i <= m; i++) {
    lcs[i] = new Array(n + 1).fill(0);
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ kind: 'same', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      result.push({ kind: 'added', text: newLines[j - 1] });
      j--;
    } else {
      result.push({ kind: 'removed', text: oldLines[i - 1] });
      i--;
    }
  }

  result.reverse();
  return result;
}
