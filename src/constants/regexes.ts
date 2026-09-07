// Precompiled regexes shared by the extension host and the panel webview.
//
// Every pattern is compiled once, at module load, instead of on each call. A regex literal written
// inside a function is re-instantiated on every invocation, and the terminal link provider runs
// `provideLinks` for every visible row — so the soft-wrap patterns would otherwise be rebuilt for
// every row on every screen.
//
// None of these carry the `g` or `y` flags, so `test()` / `exec()` keep no `lastIndex` state and a
// single shared instance is safe to reuse.

export class Regexes {
  /** One or more whitespace characters — splits space-separated CLI arguments. */
  static readonly WHITESPACE_RUN = /\s+/;

  // --- Soft-wrap stitching (terminal link provider) --------------------------------
  // Tools break long paths across rows; these classify a row so the fragments can be rejoined.

  /**
   * A single-token path fragment that continues the path on the row above: "  per-", "  /main/java/…",
   * "  PageResult.java:31". Leading whitespace is optional — tools differ in whether they indent
   * wrapped output (and some use tabs), so requiring indentation silently misses the un-indented
   * case and leaves each row matching alone as a fragment. Group 1 is the fragment itself; a
   * separator may lead it, since a wrap can land right before one.
   */
  static readonly SOFT_CONTINUATION = /^[ \t]*([A-Za-z0-9_\-.\/\\][A-Za-z0-9_\-.\/:]*)\s*$/;

  /**
   * A path token at the START of a row, allowing trailing junk on the same row
   * (e.g. "odel/PageResult.java:31 output the same"). Unlike SOFT_CONTINUATION this does not require
   * the rest of the line to be whitespace — a wrapped path is sometimes followed by other text. The
   * caller only treats the row as a continuation when the captured token is a strong path indicator.
   */
  static readonly LEADING_PATH_TOKEN = /^[ \t]*([A-Za-z0-9_\-.\/\\][A-Za-z0-9_\-.\/:]*)/;

  /**
   * A decorative token some CLI tools print just before a path (e.g. "— /Users/…", "> /Users/…",
   * "● file"). These symbols are never part of a path, so they must be stripped before a row is
   * classified as a path fragment/origin — otherwise the leading "—" makes the whole row fail the
   * path test and the upward link walk stops one row too low. Hyphen ("-") is deliberately excluded:
   * it is a legitimate path char ("mq-keeper") and a hyphen-only continuation ("  per-"). The token
   * must be followed by whitespace so a bare "->" or similar is left alone.
   */
  static readonly DECORATIVE_PREFIX =
    /^[ \t]*(?:[—–•●▪◦○◆▶▸►▶›»→⇒«¦|│>][ \t]+)?/;
  /** Fragment truncated at a hyphen — the "per-" in "mq-kee" + "per-". */
  static readonly TRAILING_HYPHEN = /-$/;
  /** Complete file reference at end of text: ".java", ".java:31", ".java:31:5". */
  static readonly FILE_REF = /\.[A-Za-z0-9]+(:\d+(:\d+)?)?$/;
  /** Line/column suffix at end of text: ":31", ":31:5". */
  static readonly LINE_SUFFIX = /:\d+(:\d+)?$/;
  /** Text contains a path separator. */
  static readonly HAS_SEPARATOR = /[\/\\]/;
  /** Text ends mid-path (separator, word char, hyphen, dot) rather than on whitespace. */
  static readonly ENDS_MID_PATH = /[A-Za-z0-9_\-.\/\\]$/;
}
