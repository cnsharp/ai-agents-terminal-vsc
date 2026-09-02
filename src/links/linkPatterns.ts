// Ported from IntelliJ: YoloLinkPatterns.kt
// Link-detection building blocks shared by the terminal link filters.
// Canonical source of truth: the RegExp objects below are serialized (source + flags) to the
// webview at runtime, so the webview and extension host always share the exact same patterns.

export type LinkKind = "file" | "url" | "type" | "member";

/** Max hyperlinks a single terminal line may produce before the rest is ignored (defensive cap). */
export const MAX_MATCHES_PER_LINE = 50;

/**
 * Fixed allowlist of common programming / source / config file extensions. Mirrors the IntelliJ original.
 * Only names ending in one of these are linked, so a dotted non-file (e.g. `pay.amount.mark`, `JSON.parseObject`)
 * is never mistaken for a file reference.
 */
export const PROGRAMMING_EXT: string = [
  // JVM / static languages
  "kt", "kts", "java", "scala", "sc", "groovy", "gradle",
  // Dynamic / scripting
  "py", "pyi", "pyw", "rb", "rake", "php", "pl", "pm", "lua", "sh", "bash", "zsh", "ksh",
  // Web / front-end
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl",
  // Systems / native
  "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hxx", "hh", "cs", "m", "mm", "swift", "d", "nim", "zig", "s", "asm",
  // Functional / other
  "ex", "exs", "clj", "cljs", "cljc", "erl", "hs", "ml", "mli", "fs", "fsx", "fsi", "jl", "r", "proto", "sol", "graphql", "gql",
  // Data / config / markup
  "xml", "xsd", "xsl", "xslt", "wsdl", "json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "config",
  "properties", "env", "lock", "csv", "tsv", "log",
  // Docs / misc
  "md", "markdown", "rst", "txt", "text", "diff", "patch", "editorconfig", "gitignore", "dockerignore",
  "tf", "tfvars", "feature", "bnf", "avsc", "edn",
  // IntelliJ project files
  "iml", "ipr", "iws",
].join("|");

export interface MatcherDef {
  kind: LinkKind;
  regex: RegExp;
  /** Numeric capture-group indices for the meaningful fields (1-based, matching match[]). */
  fields?: Record<string, number>;
  /** When set, read these named groups instead of numeric fields. */
  named?: string[];
}

// NOTE on porting deviations from the Kotlin original (all behaviour-preserving for a draft):
//  - `(?i:...)` inline flags are not valid in JS regex; the `i` flag is applied to the whole pattern instead.
//  - Possessive quantifiers (`*+`, `++`) are not supported in JS; plain `*` / `+` is used.
//  - `\/` is kept escaped for clarity; it is valid either way.

export const PATH_MATCHER: MatcherDef = {
  kind: "file",
  regex: new RegExp(
    `(?<![\\\\/\\w.])((?:(?:[A-Za-z]:[\\\\/]?)|[\\\\/]|[~][\\\\/]?|\\\\\\\\[A-Za-z0-9._\\-]+(?:[\\\\/][A-Za-z0-9._\\-]+)+|[A-Za-z0-9._\\-]+[\\\\/])(?:[A-Za-z0-9._\\-]+[\\\\/])*(?:[A-Za-z0-9._\\-]+\\.(?:${PROGRAMMING_EXT})(?![\\\\/\\w.])|[A-Za-z0-9._\\-]+))(?::(\\d+)(?:-(\\d+))?(?::(\\d+))?)?`,
    "i"
  ),
  fields: { path: 1, line: 2, column: 4 },
};

export const QUOTED_PATH_MATCHER: MatcherDef = {
  kind: "file",
  regex: new RegExp(
    `(["'])((?:[A-Za-z]:)?[\\\\/][^"']*?\\.(?:${PROGRAMMING_EXT}))\\1(?::(\\d+))?(?::(\\d+))?`,
    "i"
  ),
  fields: { path: 2, line: 3, column: 4 },
};

export const STACK_BARE_MATCHER: MatcherDef = {
  kind: "file",
  regex: new RegExp(
    `(?<![\\\\/\\w.])([\\w.\\-]+\\.(?:${PROGRAMMING_EXT})):(\\d+)(?::(\\d+))?`,
    "i"
  ),
  fields: { path: 1, line: 2, column: 3 },
};

export const STACK_BARE_NAME_MATCHER: MatcherDef = {
  kind: "file",
  regex: new RegExp(
    `(?<![\\\\/\\w.])([\\w.\\-]+\\.(?:${PROGRAMMING_EXT}))(?![\\\\/\\w.:])`,
    "i"
  ),
  fields: { path: 1 },
};

export const STACK_PY_DQ_MATCHER: MatcherDef = {
  kind: "file",
  regex: new RegExp(`File "([^"]+\\.(?:${PROGRAMMING_EXT}))", line (\\d+)`, "i"),
  fields: { path: 1, line: 2 },
};

export const STACK_PY_SQ_MATCHER: MatcherDef = {
  kind: "file",
  regex: new RegExp(`File '([^']+\\.(?:${PROGRAMMING_EXT}))', line (\\d+)`, "i"),
  fields: { path: 1, line: 2 },
};

export const TYPE_NAME_MATCHER: MatcherDef = {
  kind: "type",
  // Regex literal (no extension interpolation). Possessive quantifiers removed.
  regex:
    /(?<![.\w/\\])(?<qualified>\??(?:[A-Za-z_][A-Za-z0-9_]*)(?:(?:\.|::|\\)[A-Za-z_][A-Za-z0-9_]*)+)(?!\.[a-z])|(?<![.\w/\\])(?<simple>(?![A-Z]+\b)[A-Z][a-zA-Z0-9_]*)(?!\.[a-z])/,
  named: ["qualified", "simple"],
};

export const MEMBER_REF_MATCHER: MatcherDef = {
  kind: "member",
  regex:
    /(?<class>(?<![.\w/\\])(?:\??(?:[A-Za-z_][A-Za-z0-9_]*)(?:(?:\.|::|\\)[A-Za-z_][A-Za-z0-9_]*)+)|[A-Z][a-zA-Z0-9_]*)[.#](?<member>[A-Za-z_]\w*)/,
  named: ["class", "member"],
};

export const URL_MATCHER: MatcherDef = {
  kind: "url",
  regex: /https?:\/\/[^\s<>"'\)\]]+/,
};

export const ALL_MATCHERS: MatcherDef[] = [
  PATH_MATCHER,
  QUOTED_PATH_MATCHER,
  STACK_BARE_MATCHER,
  STACK_BARE_NAME_MATCHER,
  STACK_PY_DQ_MATCHER,
  STACK_PY_SQ_MATCHER,
  TYPE_NAME_MATCHER,
  MEMBER_REF_MATCHER,
  URL_MATCHER,
];

/** Serializable form sent to the webview (RegExp is not structured-cloneable). */
export interface SerializableMatcher {
  kind: LinkKind;
  source: string;
  flags: string;
  fields?: Record<string, number>;
  named?: string[];
}

export function toSerializable(defs: MatcherDef[] = ALL_MATCHERS): SerializableMatcher[] {
  return defs.map((d) => ({
    kind: d.kind,
    source: d.regex.source,
    flags: d.regex.flags,
    fields: d.fields,
    named: d.named,
  }));
}

/**
 * True when the file reference at [fileStart] is the tail of a truncated path — i.e. the character(s)
 * immediately before it are a `…` (U+2026) or a `...` run. Agents abbreviate long paths with `…` in the
 * middle; the fragment after the marker is not a real file and must not be linked.
 */
export function isTruncatedPathHead(text: string, fileStart: number): boolean {
  if (fileStart < 1) {
    return false;
  }
  const c = text[fileStart - 1];
  return c === "…" || (c === "." && text.startsWith("...", fileStart - 3));
}
