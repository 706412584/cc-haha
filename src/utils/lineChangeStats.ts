import { diffLines } from 'diff'

/**
 * Myers diff costs O(lines × edits). A rewrite of a large file (a line-ending
 * flip turns every line into an edit) took 15s on one 7k-line file and blocked
 * the server event loop for every open session. Past this bound the exact diff
 * is abandoned for an O(n) count.
 */
const LINE_STATS_MAX_EDIT_LENGTH = 1_000

function splitLines(content: string): string[] {
  return content.length > 0 ? content.split('\n') : []
}

/**
 * Inserted/deleted line counts for summary badges. Exact up to
 * LINE_STATS_MAX_EDIT_LENGTH edits; beyond that, counts lines that occur on
 * only one side (a moved line is not counted, which is acceptable for a badge).
 */
export function countLineChangeStats(
  oldContent: string,
  newContent: string,
): { insertions: number; deletions: number } {
  const changes = diffLines(oldContent, newContent, {
    maxEditLength: LINE_STATS_MAX_EDIT_LENGTH,
  })
  if (changes) {
    let insertions = 0
    let deletions = 0
    for (const change of changes) {
      if (change.added) insertions += change.count || 0
      if (change.removed) deletions += change.count || 0
    }
    return { insertions, deletions }
  }

  const unmatchedOld = new Map<string, number>()
  for (const line of splitLines(oldContent)) {
    unmatchedOld.set(line, (unmatchedOld.get(line) ?? 0) + 1)
  }
  let insertions = 0
  for (const line of splitLines(newContent)) {
    const count = unmatchedOld.get(line) ?? 0
    if (count > 0) unmatchedOld.set(line, count - 1)
    else insertions += 1
  }
  let deletions = 0
  for (const count of unmatchedOld.values()) deletions += count
  return { insertions, deletions }
}
