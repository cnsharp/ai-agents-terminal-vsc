// Ported concept from IntelliJ: the terminal HyperlinkFilter chain. Runs every matcher against a single
// terminal line and returns link descriptors (kind + payload fields). Used by the extension host for
// hover/peek and as a reference implementation alongside the webview's xterm link provider.

import {
  ALL_MATCHERS,
  isTruncatedPathHead,
  type LinkKind,
  type MatcherDef,
} from "./linkPatterns";

export interface ParsedLink {
  kind: LinkKind;
  start: number;
  end: number;
  text: string;
  payload: LinkPayload;
}

export type LinkPayload =
  | { kind: "file"; path: string; line?: number; column?: number }
  | { kind: "url"; url: string }
  | { kind: "type"; name: string }
  | { kind: "member"; className: string; member: string };

// Priority when ranges overlap: type/member (symbol nav) beat file, url lowest. Higher wins.
const PRIORITY: Record<LinkKind, number> = { member: 4, type: 3, file: 2, url: 1 };

interface Candidate {
  start: number;
  end: number;
  text: string;
  payload: LinkPayload;
  priority: number;
}

/** Parse a single line of terminal text into de-duplicated, non-overlapping link descriptors. */
export function parseLine(text: string, matchers: MatcherDef[] = ALL_MATCHERS): ParsedLink[] {
  const candidates: Candidate[] = [];
  for (const matcher of matchers) {
    const flags = matcher.regex.flags.includes("g")
      ? matcher.regex.flags
      : matcher.regex.flags + "g";
    const re = new RegExp(matcher.regex.source, flags);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 50) {
      if (m.index === re.lastIndex) {
        re.lastIndex++; // avoid zero-width loop
      }
      const payload = buildPayload(matcher, m);
      if (!payload) {
        continue;
      }
      stripUndefined(payload);
      // Skip file references that are the tail of a truncated path (`…` / `...` marker before).
      if (payload.kind === "file" && isTruncatedPathHead(text, m.index)) {
        continue;
      }
      candidates.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        payload,
        priority: PRIORITY[matcher.kind],
      });
    }
  }

  // Sort by length desc, then priority desc, then start asc; drop overlaps (longest/strongest wins).
  candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || b.priority - a.priority || a.start - b.start
  );
  const accepted: ParsedLink[] = [];
  for (const c of candidates) {
    const overlaps = accepted.some((a) => c.start < a.end && c.end > a.start);
    if (!overlaps) {
      accepted.push({ kind: c.payload.kind, start: c.start, end: c.end, text: c.text, payload: c.payload });
    }
  }
  return accepted;
}

function buildPayload(matcher: MatcherDef, m: RegExpExecArray): LinkPayload | undefined {
  switch (matcher.kind) {
    case "url":
      return { kind: "url", url: m[0] };
    case "file": {
      if (!matcher.fields) {
        return undefined;
      }
      const path = m[matcher.fields.path];
      if (!path) {
        return undefined;
      }
      const line = num(m[matcher.fields.line]);
      const column = num(m[matcher.fields.column]);
      return { kind: "file", path, line, column };
    }
    case "type": {
      const name = (matcher.named && (m.groups?.qualified ?? m.groups?.simple)) || undefined;
      if (!name) {
        return undefined;
      }
      return { kind: "type", name };
    }
    case "member": {
      const className = matcher.named ? m.groups?.class : undefined;
      const member = matcher.named ? m.groups?.member : undefined;
      if (!className || !member) {
        return undefined;
      }
      return { kind: "member", className, member };
    }
  }
  return undefined;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s.length === 0) {
    return undefined;
  }
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Remove keys whose value is undefined so payloads compare cleanly and serialize tightly. */
function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] === undefined) {
      delete o[k];
    }
  }
  return o;
}
