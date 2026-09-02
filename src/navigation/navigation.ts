// Ported concept from IntelliJ: YoloNavigation.kt
//  - openFileAt     -> vscode.open with a Selection at the given line/column (1-based -> 0-based).
//  - resolveType    -> LSP-backed workspace symbol search. This is the VS Code equivalent of the
//                       language-agnostic `gotoClassContributor` extension point: every language
//                       server implements `workspace/symbol`, so one code path resolves types in any
//                       language without per-language PSI code. (No custom language server needed.)
//  - resolveMember  -> narrowed workspace symbol lookup; same mechanism, filtered to the same file as
//                       the class when possible.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { LinkPayload } from "../links/linkParser";

/**
 * Resolve a link's path to an absolute filesystem path. Absolute paths pass through unchanged;
 * relative paths (as printed by agents in a terminal) are resolved against the workspace folder(s)
 * first and then the home directory, picking the first candidate that actually exists on disk. This
 * is what makes project-relative references like `src/foo.ts:12` openable.
 */
function resolveFilePath(rawPath: string): string {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const bases = [
    ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []),
    os.homedir(),
  ];
  for (const base of bases) {
    const candidate = path.join(base, rawPath);
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore unreadable candidates and keep trying other bases
    }
  }
  // No existing match: best-effort resolve against the first known base.
  return path.join(bases[0] ?? process.cwd(), rawPath);
}

/** Open a file in the editor at the given 1-based line/column (converted to 0-based internally). */
export async function openFileAt(
  fsPath: string,
  line?: number,
  column?: number
): Promise<void> {
  const uri = vscode.Uri.file(resolveFilePath(fsPath));
  const position = new vscode.Position(
    Math.max(0, (line ?? 1) - 1),
    Math.max(0, (column ?? 1) - 1)
  );
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Selection(position, position),
    preview: false,
  });
}

/**
 * Resolve a (possibly qualified) type name to a file location via the workspace symbol provider.
 * Returns the first symbol whose name matches; null if nothing matches. Language-agnostic.
 */
export async function resolveType(
  name: string
): Promise<vscode.SymbolInformation | undefined> {
  const normalized = name.replace(/\\/g, ".").replace(/::/g, ".");
  const lastSeg = name.split(/[.\\:]/).pop() ?? name;

  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    normalized
  );

  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();

  // Tier 1: exact (qualified) match in the active document.
  // Tier 2: exact (qualified) match anywhere.
  // Tier 3: simple-name (last segment) match in the active document.
  // Tier 4: simple-name match anywhere.
  let bySimpleInActive: vscode.SymbolInformation | undefined;
  let bySimple: vscode.SymbolInformation | undefined;
  for (const s of symbols ?? []) {
    const symName = s.name;
    const uri = s.location?.uri.toString();
    const exact = symName === name || symName.replace(/\\/g, ".").replace(/::/g, ".") === normalized;
    if (exact && uri === activeUri) {
      return s;
    }
    if (exact) {
      return s;
    }
    if (symName === lastSeg) {
      if (uri === activeUri && !bySimpleInActive) {
        bySimpleInActive = s;
      } else if (!bySimple) {
        bySimple = s;
      }
    }
  }
  return bySimpleInActive ?? bySimple;
}

/**
 * Resolve a member symbol within a class. Strategy:
 *  1. Resolve the class symbol first (so we know its file + range). `resolveType` already prefers the
 *     active document when several classes share a name, which de-ambiguates the class itself.
 *  2. Use the file's document symbols to find the member *nested inside* the class — precise, and avoids
 *     picking the wrong same-named member declared in a different class / file. This is the
 *     cross-file/ambiguous-name fix that a bare workspace-symbol lookup for the member name cannot do.
 *  3. Fall back to a workspace symbol lookup for the member, preferring the class's file.
 */
export async function resolveMember(
  className: string,
  member: string
): Promise<vscode.SymbolInformation | undefined> {
  const classSym = await resolveType(className);
  const classUri = classSym?.location?.uri;
  if (classUri && classSym.location) {
    const scoped = await memberInClassFile(classUri, classSym.location.range, member);
    if (scoped) {
      return scoped;
    }
  }
  return memberByWorkspace(member, classUri);
}

/** Find `member` nested inside the class node of `uri`'s document symbol tree (precise scoping). */
async function memberInClassFile(
  uri: vscode.Uri,
  classRange: vscode.Range,
  member: string
): Promise<vscode.SymbolInformation | undefined> {
  const docSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    uri
  );
  const classNode = findEnclosing(docSyms ?? [], classRange);
  const descendants = classNode ? classNode.children : (docSyms ?? []);
  for (const s of descendants) {
    if (s.name === member) {
      return {
        name: s.name,
        kind: s.kind,
        containerName: "",
        location: new vscode.Location(uri, s.selectionRange),
      };
    }
  }
  return undefined;
}

/** Fallback: workspace symbol for the member name, preferring the class's file when known. */
async function memberByWorkspace(
  member: string,
  classUri: vscode.Uri | undefined
): Promise<vscode.SymbolInformation | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    member
  );
  let fallback: vscode.SymbolInformation | undefined;
  for (const s of symbols ?? []) {
    if (s.name !== member) {
      continue;
    }
    if (classUri && s.location?.uri.toString() === classUri.toString()) {
      return s;
    }
    if (!fallback) {
      fallback = s;
    }
  }
  return fallback;
}

/** Return the deepest document symbol whose range fully contains `range`, or undefined. */
function findEnclosing(syms: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | undefined {
  for (const s of syms) {
    if (s.range.contains(range.start) && s.range.contains(range.end)) {
      const inner = findEnclosing(s.children, range);
      return inner ?? s;
    }
  }
  return undefined;
}

/** Open the location returned by resolveType / resolveMember. */
export async function openSymbol(sym: vscode.SymbolInformation): Promise<void> {
  if (sym.location) {
    await vscode.commands.executeCommand("vscode.open", sym.location.uri, {
      selection: sym.location.range,
    });
  }
}

/** Open a URL in the system browser. */
export async function openUrl(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

// Compact SymbolKind labels for hover text (only the common ones; the rest fall back to "").
const KIND_LABEL: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.File]: "file",
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Package]: "package",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.Constructor]: "ctor",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.Variable]: "var",
  [vscode.SymbolKind.Constant]: "const",
};

/** Render a workspace path as relative to the workspace root, when inside one. */
function rel(fsPath: string): string {
  try {
    return vscode.workspace.asRelativePath(fsPath, false);
  } catch {
    return fsPath;
  }
}

/** Format "file:line:column" for a symbol location (column omitted when 0/unknown). */
function locLabel(fsPath: string, line: number, column?: number): string {
  const at = column && column > 0 ? `${line}:${column}` : `${line}`;
  return `${rel(fsPath)}:${at}`;
}

/**
 * Hover-preview text: resolves a parsed link to a short description of where a click would navigate.
 * This is what the xterm link `hover` callback shows as a tooltip before the user commits the click,
 * and is especially valuable for type/member links whose LSP resolution can be ambiguous.
 * Returns `undefined` for unresolvable links (xterm then shows no custom tooltip).
 */
export async function describeLink(payload: LinkPayload): Promise<string | undefined> {
  switch (payload.kind) {
    case "url":
      return `Open URL: ${payload.url}`;
    case "file": {
      const at = [payload.line ? `:${payload.line}` : "", payload.column ? `:${payload.column}` : ""].join("");
      return `Open ${rel(payload.path)}${at}`;
    }
    case "type": {
      const sym = await resolveType(payload.name!);
      if (!sym || !sym.location) {
        return `No symbol found: ${payload.name}`;
      }
      const kind = KIND_LABEL[sym.kind] ? `${KIND_LABEL[sym.kind]} ` : "";
      const line = sym.location.range.start.line + 1;
      const col = sym.location.range.start.character + 1;
      return `Go to ${kind}${payload.name} → ${locLabel(sym.location.uri.fsPath, line, col)}`;
    }
    case "member": {
      const sym = await resolveMember(payload.className!, payload.member!);
      if (!sym || !sym.location) {
        return `No member: ${payload.className}.${payload.member}`;
      }
      const kind = KIND_LABEL[sym.kind] ? `${KIND_LABEL[sym.kind]} ` : "";
      const l = sym.location.range.start.line + 1;
      const c = sym.location.range.start.character + 1;
      return `Go to ${kind}${payload.className}.${payload.member} → ${locLabel(sym.location.uri.fsPath, l, c)}`;
    }
  }
}
