// Folds a stored string onto one line before it reaches a line-structured answer, so no text that
// came out of the log or the corpus can break the lines a reader parses. Control characters (C0, DEL,
// C1) and the Unicode line and paragraph separators become spaces, whitespace runs collapse to one
// space, and the ends are trimmed.
export function singleLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim();
}
