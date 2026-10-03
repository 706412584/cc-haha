/**
 * Whether a state file's text carries no data at all: empty, whitespace (a BOM counts —
 * U+FEFF is whitespace to `\s`), or NUL padding.
 *
 * A crash or power loss during a write can leave a file on NTFS at its full size but
 * zero-filled, and a tool that wrote nothing but a BOM leaves just that. A reader loses
 * nothing by treating such a file as never written — unlike content that merely fails to
 * parse, which may still be recoverable and must not be silently replaced by the next
 * write. NULs sitting next to real data are therefore not blank.
 */
export function isBlankFileContent(content: string): boolean {
  return /^[\s\0]*$/.test(content)
}
