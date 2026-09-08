// Bundled webview entry (compiled by esbuild -> media/dist/panel.js).
// Owns the xterm.js terminal, the combined link provider (de-duplicated + prioritized), and the
// message bridge to the extension host.
//
// IMPORTANT: the agent picker + the `ready` handshake MUST be wired up BEFORE the xterm terminal is
// initialised. A failure while creating the terminal (e.g. a layout/element issue) must never prevent
// the host from learning the webview is ready and shipping the agent list — otherwise the dropdown
// stays empty. Terminal init is therefore isolated in a try/catch.

import { Terminal, type IBufferLine, type ILink, type ITheme, type Terminal as ITerminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { Regexes } from "../constants/regexes";
import { PROGRAMMING_EXT } from "../links/linkPatterns";

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

interface SerializableMatcher {
  kind: "file" | "url" | "type" | "member";
  source: string;
  flags: string;
  fields?: Record<string, number>;
  named?: string[];
}

interface AgentOption {
  id: string;
  displayName: string;
  command: string;
  resolvedPath?: string;
  iconUri?: string;
}

interface SkipIconSet {
  off: string;
  offDark: string;
  on: string;
  onDark: string;
}

interface InitMessage {
  type: "init";
  matchers: SerializableMatcher[];
  agents: AgentOption[];
  skipEnabled: boolean;
  resumeMode?: boolean;
  skipIcons?: SkipIconSet;
  resumeIcons?: SkipIconSet;
  cwd: string;
  lastAgentId?: string;
}

type Backend = "embedded" | "vscode-terminal";

type HostMessage =
  | InitMessage
  | { type: "data"; sessionId: string; data: string }
  | {
      type: "spawned";
      sessionId: string;
      agentId: string;
      displayName: string;
      iconUri?: string;
      command: string;
      backend?: Backend;
      replay?: string;
    }
  /** Host tells the webview which tab is active (after re-attach, and after a close). */
  | { type: "selected"; sessionId: string }
  /** Host confirmed the close and killed the PTY; the webview disposes the terminal. */
  | { type: "sessionClosed"; sessionId: string }
  | { type: "hoverResult"; reqId: number; text?: string };

interface LinkPayload {
  kind: "file" | "url" | "type" | "member";
  path?: string;
  line?: number;
  column?: number;
  url?: string;
  name?: string;
  className?: string;
  member?: string;
}

interface Candidate {
  start: number;
  length: number;
  payload: LinkPayload;
  priority: number;
}

// Priority when ranges overlap: type/member (symbol nav) beat file, url lowest. Higher wins.
const PRIORITY: Record<string, number> = { member: 4, type: 3, file: 2, url: 1 };

let matchers: SerializableMatcher[] = [];

// Compiled regexes for `matchers`, built once per `init` (not per `provideLinks` call). Reusing the
// same RegExp object across rows/calls avoids recompiling on every line of every render — which
// otherwise multiplied with the number of visible rows and open tabs.
interface CompiledMatcher {
  m: SerializableMatcher;
  re: RegExp;
}
let compiledMatchers: CompiledMatcher[] = [];

// --- Agent picker (custom listbox; native <select> can't show the resolved path/command on hover) ---
let agents: AgentOption[] = [];
let selectedAgentId = "";

// --- YOLO (skip-permissions) toggle state + icon set (icons come from the host / IDEA edition) ---
let skipEnabled = false;
let skipIcons: SkipIconSet | undefined;

// --- Resume toggle state + icon set (icons come from the host / IDEA edition) ---
let resumeEnabled = false;
let resumeIcons: SkipIconSet | undefined;

/**
 * One open terminal tab — the webview half of a host `YoloSession`. Mirrors IDEA's `Session`
 * (widget + process + agent row + tab component + card key): each tab owns its terminal, its fit
 * addon and its own TypedInputGuard, so nothing leaks between tabs.
 */
interface SessionView {
  id: string;
  agentId: string;
  displayName: string;
  iconUri?: string;
  command: string;
  /** "vscode-terminal" means the agent runs in a revealed real terminal and this xterm only shows a
   *  notice — keystrokes are not bridged, so we must not forward input (that would double-type). */
  backend: Backend | undefined;
  term: ITerminal;
  fit: FitAddon;
  guard: TypedInputGuard;
  card: HTMLDivElement;
  hoverEl: HTMLDivElement;
}

/** Open terminals in tab order (IDEA: `sessions`). */
const sessions: SessionView[] = [];
/** Id of the visible tab (IDEA: `selectedIndex`). */
let activeId: string | undefined;
/** Last known good grid size; seeds a terminal created while its card is still hidden. */
let lastDims: { cols: number; rows: number } | undefined;

function byId(id?: string): SessionView | undefined {
  return id ? sessions.find((s) => s.id === id) : undefined;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Render the YOLO toggle button with its four icon variants (off/on × light/dark). The active
// variant is selected purely via CSS (body.vscode-dark etc.), so no JS theme detection is needed.
function renderSkipToggle(): void {
  const btn = document.getElementById("skipToggle") as HTMLButtonElement | null;
  if (!btn || !skipIcons) {
    return;
  }
  btn.classList.toggle("active", skipEnabled);
  btn.setAttribute("aria-pressed", skipEnabled ? "true" : "false");
  btn.innerHTML = `
    <img class="ic ic-off" src="${escapeAttr(skipIcons.off)}" alt="" />
    <img class="ic ic-on" src="${escapeAttr(skipIcons.on)}" alt="" />`;
}

// Resume toggle: render with the four icon variants (off/on × light/dark), selected via CSS.
function renderResumeToggle(): void {
  const btn = document.getElementById("resumeToggle") as HTMLButtonElement | null;
  if (!btn) {
    return;
  }
  btn.classList.toggle("active", resumeEnabled);
  btn.setAttribute("aria-pressed", resumeEnabled ? "true" : "false");
  if (resumeIcons) {
    btn.innerHTML = `
      <img class="ic ic-off" src="${escapeAttr(resumeIcons.off)}" alt="" />
      <img class="ic ic-on" src="${escapeAttr(resumeIcons.on)}" alt="" />`;
  }
}

function renderAgentMenu(): void {
  const menu = document.getElementById("agentMenu") as HTMLDivElement | null;
  if (!menu) {
    return;
  }
  // Only show agents that resolved on PATH.
  const visible = agents.filter((a) => a.resolvedPath);
  if (visible.length === 0) {
    menu.innerHTML = `<div class="agent-empty">No agents detected on PATH.<br/>Install one or check settings.</div>`;
    const btn = document.getElementById("agentBtn") as HTMLButtonElement | null;
    if (btn) {
      btn.textContent = "Select agent…";
    }
    return;
  }
  menu.innerHTML = visible
    .map((a) => {
      const logo = a.iconUri
        ? `<img class="logo" src="${escapeAttr(a.iconUri)}" alt="" />`
        : `<span class="logo lightning" title="no icon set">⚡</span>`;
      return `<div class="agent-opt ${a.id === selectedAgentId ? "active" : ""}" data-id="${a.id}" title="${escapeAttr(a.resolvedPath ?? "")}">
        ${logo}<div class="meta"><div class="name">${escapeAttr(a.displayName)}</div></div>
      </div>`;
    })
    .join("");
  menu.querySelectorAll<HTMLDivElement>(".agent-opt").forEach((el) => {
    el.addEventListener("click", () => selectAgent(el.dataset.id!));
  });
  const btn = document.getElementById("agentBtn") as HTMLButtonElement | null;
  const sel = agents.find((a) => a.id === selectedAgentId);
  if (btn) {
    btn.textContent = sel ? sel.displayName : "Select agent…";
  }
}

function selectAgent(id: string): void {
  selectedAgentId = id;
  const menu = document.getElementById("agentMenu") as HTMLDivElement | null;
  if (menu) {
    menu.hidden = true;
  }
  // Remember this selection so it is pre-selected next time the panel opens, even before a launch.
  vscode.postMessage({ type: "setLastAgent", agentId: id });
  renderAgentMenu();
}

function toggleAgentMenu(): void {
  const menu = document.getElementById("agentMenu") as HTMLDivElement | null;
  if (menu) {
    menu.hidden = !menu.hidden;
  }
}

// --- Message bridge: register BEFORE terminal init so init/data/spawned always arrive ---
window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostMessage;
  switch (msg.type) {
    case "init":
      matchers = msg.matchers;
      // Compile each matcher's regex once here; provideLinks reuses them instead of recompiling
      // on every row of every render.
      compiledMatchers = matchers.map((m) => ({
        m,
        re: new RegExp(m.source, m.flags.includes("g") ? m.flags : m.flags + "g"),
      }));
      agents = msg.agents || [];
      renderAgentMenu();
      // Pre-select the last-used agent (remembered across opens) if it's still installed; otherwise
      // fall back to the first installed agent. Only set if nothing is selected yet.
      if (!selectedAgentId) {
        const remembered = msg.lastAgentId
          ? agents.find((a) => a.id === msg.lastAgentId && a.resolvedPath)
          : undefined;
        const firstInstalled = remembered ?? agents.find((a) => a.resolvedPath);
        if (firstInstalled) {
          selectAgent(firstInstalled.id);
        }
      }
      skipEnabled = Boolean(msg.skipEnabled);
      resumeEnabled = Boolean(msg.resumeMode);
      skipIcons = msg.skipIcons;
      resumeIcons = msg.resumeIcons;
      renderSkipToggle();
      renderResumeToggle();
      break;
    case "data":
      // Route to the owning tab. Hidden tabs still receive their output so their scrollback stays
      // current — switching to them then shows an up-to-date screen.
      byId(msg.sessionId)?.term.write(msg.data);
      break;
    case "spawned":
      onSpawned(msg);
      break;
    case "selected":
      selectSession(msg.sessionId);
      break;
    case "sessionClosed":
      disposeSession(msg.sessionId);
      break;
    case "hoverResult":
      // Only apply if this reply matches the link currently being hovered.
      if (hoverState && msg.reqId === hoverState.reqId && msg.text) {
        hoverState.session.hoverEl.textContent = msg.text;
      }
      break;
  }
});

document.getElementById("agentBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleAgentMenu();
});
// Close the menu when clicking elsewhere.
document.addEventListener("click", (e) => {
  const pick = document.getElementById("agentPick");
  if (pick && !pick.contains(e.target as Node)) {
    const menu = document.getElementById("agentMenu") as HTMLDivElement | null;
    if (menu) {
      menu.hidden = true;
    }
  }
});

document.getElementById("launch")?.addEventListener("click", () => {
  // Send the panel's real grid so the host spawns the PTY at the size the terminal will display.
  // Without this the PTY defaults to 80x30 while the panel is much smaller, and a size mismatch makes
  // TUIs like codebuddy's session picker mis-render / re-list. There may be no terminal yet (first
  // launch), so measure the container instead of reading a terminal's cols/rows.
  const dims = measureDims();
  vscode.postMessage({
    type: "launch",
    agentId: selectedAgentId,
    skip: skipEnabled,
    resume: resumeEnabled,
    cols: dims?.cols,
    rows: dims?.rows,
  });
});

document.getElementById("skipToggle")?.addEventListener("click", () => {
  skipEnabled = !skipEnabled;
  renderSkipToggle();
  // Persist so the toggle survives panel reloads / restarts (mirrors ai-agents-vsc's yoloMode setting).
  vscode.postMessage({ type: "setSkip", skip: skipEnabled });
});

document.getElementById("resumeToggle")?.addEventListener("click", () => {
  resumeEnabled = !resumeEnabled;
  renderResumeToggle();
  // Persist so the toggle survives panel reloads / restarts (mirrors ai-agents-vsc's resumeMode setting).
  vscode.postMessage({ type: "setResume", resume: resumeEnabled });
});

document.getElementById("settings")?.addEventListener("click", () => {
  vscode.postMessage({ type: "openSettings" });
});

// Tell the host we're ready to receive the agent list + matchers. This MUST happen before any
// terminal work that could throw.
vscode.postMessage({ type: "ready" });

// Watchdog: if the host never sends the agent list, surface it instead of a silent empty dropdown.
setTimeout(() => {
  if (agents.length === 0) {
    vscode.postMessage({ type: "agentListMissing" });
  }
}, 3000);

// --- Theme: make xterm follow the active VS Code color theme ---
// xterm paints its own background over the canvas, so it won't inherit the page's `var(--vscode-…)`
// background. We read VS Code's theme CSS variables and translate them into an xterm ITheme, then
// re-apply whenever the theme changes (VS Code rewrites the `body` inline style on theme switch).
function readVscodeColor(name: string): string | undefined {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || undefined;
}

function buildTerminalTheme(): ITheme {
  // Prefer the activity-bar / side-bar background so the embedded terminal blends into the panel's
  // surrounding theme instead of painting a (different-shade) editor background over it.
  const bg =
    readVscodeColor("--vscode-sideBar-background") ??
    readVscodeColor("--vscode-editor-background") ??
    "#1e1e1e";
  const fg =
    readVscodeColor("--vscode-terminal-foreground") ??
    readVscodeColor("--vscode-editor-foreground") ??
    "#cccccc";
  const cursor =
    readVscodeColor("--vscode-terminalCursor-foreground") ??
    readVscodeColor("--vscode-editorCursor-foreground") ??
    "#1E64B4";
  const selBg =
    readVscodeColor("--vscode-terminal-selectionBackground") ??
    readVscodeColor("--vscode-editor-selectionBackground");
  const theme: ITheme = { background: bg, foreground: fg, cursor };
  if (selBg) {
    theme.selectionBackground = selBg;
  }
  return theme;
}

function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const s of sessions) {
    s.term.options.theme = theme;
  }
  const wrap = document.getElementById("content");
  if (wrap) {
    wrap.style.background =
      readVscodeColor("--vscode-sideBar-background") ?? readVscodeColor("--vscode-editor-background") ?? "";
  }
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) {
    return undefined;
  }
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

function buildPayload(m: SerializableMatcher, match: RegExpExecArray): LinkPayload | undefined {
  switch (m.kind) {
    case "url":
      return { kind: "url", url: match[0] };
    case "file": {
      const path = m.fields ? match[m.fields.path] : undefined;
      if (!path) {
        return undefined;
      }
      return { kind: "file", path, line: num(match[m.fields!.line]), column: num(match[m.fields!.column]) };
    }
    case "type": {
      const name = match.groups?.qualified ?? match.groups?.simple;
      return name ? { kind: "type", name } : undefined;
    }
    case "member": {
      const className = match.groups?.class;
      const member = match.groups?.member;
      return className && member ? { kind: "member", className, member } : undefined;
    }
  }
  return undefined;
}

/**
 * Combined link provider: runs every matcher against the line, then returns a non-overlapping set.
 * Overlaps are resolved by keeping the longest match; ties broken by PRIORITY. This is the VS Code
 * equivalent of the IntelliJ filter pipeline, where only the first match per region links.
 */
function provideLinks(lineText: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const { m, re } of compiledMatchers) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    let guard = 0;
    while ((match = re.exec(lineText)) !== null && guard++ < 50) {
      if (match.index === re.lastIndex) {
        re.lastIndex++;
      }
      const payload = buildPayload(m, match);
      if (!payload) {
        continue;
      }
      candidates.push({
        start: match.index,
        length: match[0].length,
        payload,
        priority: PRIORITY[m.kind] ?? 0,
      });
    }
  }

  // Sort by length desc, then priority desc, then start asc.
  candidates.sort((a, b) => b.length - a.length || b.priority - a.priority || a.start - b.start);

  const accepted: Candidate[] = [];
  for (const c of candidates) {
    const end = c.start + c.length;
    const overlaps = accepted.some((a) => c.start < a.start + a.length && end > a.start);
    if (!overlaps) {
      accepted.push(c);
    }
  }
  return accepted;
}

// Hover preview (xterm 5.x DOM-based tooltip): one tooltip element per session, appended to that
// session's term.element. On hover we post a `hover` request to the host, show a "…" placeholder,
// then fill in the resolved text when the host replies with `hoverResult`. Keyed by reqId so stale
// replies are ignored. Only one terminal is visible at a time, so a single hoverReqId/hoverState
// pair is enough — but it must remember WHICH session it belongs to.
let hoverReqId = 0;
let hoverState: { reqId: number; payload: LinkPayload; session: SessionView } | undefined;

/**
 * Tracks the text the user has typed into the embedded terminal but not yet submitted, so the input
 * box never gets linkified. This is the VS Code port of IntelliJ's `TypedInputGuard`: a PTY hands
 * back one undifferentiated byte stream, so "is this the input box?" cannot be answered from the
 * output side. The only reliable signal is the bytes going *to* the PTY — the user's own keystrokes
 * and pastes — which xterm surfaces via `onData`. We accumulate those and suppress any link whose
 * text overlaps them. Cleared on submit (Enter) or abandon (Ctrl-C / Ctrl-U / Ctrl-K).
 */
class TypedInputGuard {
  private typed = "";

  /** Record keystrokes/paste sent *to* the PTY by the user (called from xterm `onData`). */
  onUserInput(input: string): void {
    if (!input) {
      return;
    }
    this.typed = this.fold(this.typed, input);
  }

  /**
   * Ranges (char index, exclusive end) within `line` occupied by the pending typed text. Empty when
   * nothing is pending. A multi-line input (Shift+Enter) is matched per line. If we are tracking
   * input but cannot locate it on this line (byte-stream→buffer desync), the whole line is blanked
   * — while typing the active line is always the input box, so suppressing it is correct.
   */
  spansIn(line: string): Array<[number, number]> {
    const pending = this.typed;
    if (!pending.trim()) {
      return [];
    }
    const spans: Array<[number, number]> = [];
    for (const seg of pending.split("\n")) {
      if (!seg.trim()) {
        continue;
      }
      let from = 0;
      while (from <= line.length - seg.length) {
        const at = line.indexOf(seg, from);
        if (at < 0) {
          break;
        }
        spans.push([at, at + seg.length]);
        from = at + seg.length;
      }
    }
    if (spans.length === 0 && line.length > 0) {
      spans.push([0, line.length]);
    }
    return spans;
  }

  private fold(typed: string, input: string): string {
    const ESC = "\x1b";
    const CR = "\r";
    const LF = "\n";
    const BACKSPACE = "\b";
    const DELETE = "\x7f";
    const PASTE_START = `${ESC}[200~`;
    const PASTE_END = `${ESC}[201~`;
    const CLEAR_KEYS = ["\x03", "\x15", "\x0b"]; // Ctrl-C, Ctrl-U, Ctrl-K

    // Enter / Return submits the input → box is empty again.
    if (input === CR || input === LF || input === CR + LF) {
      return "";
    }
    // Esc + Enter is a newline *inside* the input, not a submit.
    if (input === ESC + CR || input === ESC + LF) {
      return typed + LF;
    }
    // Bracketed paste: keep the pasted body, drop the \e[200~ / \e[201~ markers.
    if (input.startsWith(PASTE_START)) {
      return typed + input.slice(PASTE_START.length).split(PASTE_END)[0];
    }
    // Escape sequence (arrows, function keys, mouse): moves the cursor, leaves text unchanged.
    if (input.startsWith(ESC)) {
      return typed;
    }
    // Backspace / Delete erase the last character.
    if (input === BACKSPACE || input === DELETE) {
      return typed.slice(0, -1);
    }
    // Ctrl-C / Ctrl-U / Ctrl-K clear the input line.
    if (CLEAR_KEYS.includes(input)) {
      return "";
    }
    // Ordinary typing (incl. CJK and tab).
    if (input.split("").every((ch) => ch === "\t" || (ch >= " " && ch !== DELETE))) {
      return typed + input;
    }
    // Any other control byte: leave the pending text alone.
    return typed;
  }
}

function showTooltip(session: SessionView, text: string, event: MouseEvent): void {
  const el = session.hoverEl;
  el.textContent = text;
  el.style.display = "block";
  const rect = (session.term.element ?? document.body).getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  el.style.left = `${x + 12}px`;
  el.style.top = `${Math.max(0, y - el.offsetHeight - 6)}px`;
}

function hideTooltip(): void {
  if (hoverState) {
    hoverState.session.hoverEl.style.display = "none";
  }
  hoverState = undefined;
}

/**
 * Size one session's terminal to its card. A card hidden with `visibility:hidden` keeps its layout
 * box, so every terminal (hidden ones included) stays sized to the panel and its PTY already knows
 * the true width — output written while hidden therefore wraps correctly. (`display:none` would
 * collapse the box to 0 cells and break both.)
 */
function fitSession(s: SessionView): void {
  const d = s.fit.proposeDimensions();
  if (d && !Number.isNaN(d.cols) && !Number.isNaN(d.rows)) {
    if (s.term.cols !== d.cols || s.term.rows !== d.rows) {
      s.fit.fit(); // fires onResize -> posts `resize` -> host resizes this session's PTY
    }
    lastDims = { cols: s.term.cols, rows: s.term.rows };
  } else if (lastDims && (s.term.cols !== lastDims.cols || s.term.rows !== lastDims.rows)) {
    // The panel itself has no size yet (webview not laid out) — fall back to the last good grid.
    s.term.resize(lastDims.cols, lastDims.rows);
  }
}

function fitAll(): void {
  for (const s of sessions) {
    fitSession(s);
  }
}

/**
 * Best-effort grid measurement for the `launch` message, which is sent before any terminal exists.
 * Uses the last known grid when available, else probes with a hidden span of 100 "W"s.
 */
function measureDims(): { cols: number; rows: number } | undefined {
  if (lastDims) {
    return lastDims;
  }
  const host = document.getElementById("content");
  if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) {
    return undefined;
  }
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;";
  probe.textContent = "W".repeat(100);
  host.appendChild(probe);
  const r = probe.getBoundingClientRect();
  const cw = r.width / 100;
  const ch = r.height || 17;
  probe.remove();
  if (!cw || !ch) {
    return undefined;
  }
  return {
    cols: Math.max(20, Math.floor((host.clientWidth - 8) / cw)),
    rows: Math.max(5, Math.floor((host.clientHeight - 8) / ch)),
  };
}

/** Create (or re-attach) one terminal tab. Idempotent by session id. */
function createSession(msg: Extract<HostMessage, { type: "spawned" }>): SessionView | undefined {
  const content = document.getElementById("content");
  if (!content) {
    return undefined;
  }
  const existing = byId(msg.sessionId);
  if (existing) {
    return existing; // re-attach: reuse the tab, the caller replays output into it
  }

  const card = document.createElement("div");
  // Start hidden: activateSession() unhides the tab that should be visible. Without this, a
  // re-attach that recreates several tabs would briefly show them all stacked.
  card.className = "term-card hidden";
  card.dataset.sid = msg.sessionId;
  content.appendChild(card);

  const session: SessionView = {
    id: msg.sessionId,
    agentId: msg.agentId,
    displayName: msg.displayName,
    iconUri: msg.iconUri,
    command: msg.command,
    backend: msg.backend,
    // Seeded with the last good grid so a card created while hidden still has real dimensions.
    term: new Terminal({
      fontFamily: "var(--vscode-editor-font-family, monospace)",
      fontSize: 13,
      cursorBlink: true,
      theme: buildTerminalTheme(),
      // Match VS Code's integrated terminal, which uses Unicode 11. Without this, TUI logos/banners
      // that rely on newer glyphs (box-drawing, special symbols, emoji) render blank or garbled —
      // making the logo appear "missing" compared to the native terminal.
      unicode: { version: 11 },
      cols: lastDims?.cols,
      rows: lastDims?.rows,
    }),
    fit: new FitAddon(),
    guard: new TypedInputGuard(), // one guard per tab (IDEA parity)
    card,
    hoverEl: document.createElement("div"),
  };
  session.hoverEl.className = "xterm-hover";
  session.hoverEl.style.display = "none";

  session.term.loadAddon(session.fit);
  session.term.open(card);
  fitSession(session);
  session.term.element?.appendChild(session.hoverEl);

  session.term.onData((d) => {
    // Track this tab's keystrokes/pastes so its input box is never linkified (IntelliJ-style
    // TypedInputGuard). onData fires only for *user* input, not for term.write() output.
    session.guard.onUserInput(d);
    // Only forward keystrokes when the agent is hosted in the embedded terminal. In the
    // vscode-terminal backend the user types directly in the revealed VS Code terminal; forwarding
    // here would double-type.
    if (session.backend === "embedded") {
      vscode.postMessage({ type: "input", sessionId: session.id, data: d });
    }
  });
  session.term.onResize(({ cols, rows }) => {
    if (cols > 0 && rows > 0) {
      lastDims = { cols, rows };
      vscode.postMessage({ type: "resize", sessionId: session.id, cols, rows });
    }
  });

  registerLinkProvider(session);
  sessions.push(session);
  return session;
}

function onSpawned(msg: Extract<HostMessage, { type: "spawned" }>): void {
  const s = createSession(msg);
  if (!s) {
    return;
  }
  s.backend = msg.backend;
  s.term.reset();
  if (msg.backend === "vscode-terminal") {
    s.term.writeln(`→ launched ${msg.command} in the VS Code Terminal — focus it to interact.`);
    s.term.writeln(
      "(node-pty couldn't spawn a PTY here, so the agent runs in a real VS Code terminal instead.)"
    );
  } else {
    // On re-attach (view was hidden/moved and recreated) the new xterm is blank. Replay the buffered
    // PTY output so the session's screen is restored immediately, then re-sync size to force a live
    // redraw from the agent.
    if (msg.replay) {
      s.term.write(msg.replay);
    }
    if (s.term.cols > 0 && s.term.rows > 0) {
      // Toggle the size (+1/-1) so the running TUI repaints even when the panel size is unchanged:
      // a plain resize to identical dimensions emits no SIGWINCH, which would leave a re-attached
      // terminal blank. The transient off-by-one is harmless.
      vscode.postMessage({ type: "resize", sessionId: s.id, cols: s.term.cols, rows: s.term.rows + 1 });
      vscode.postMessage({ type: "resize", sessionId: s.id, cols: s.term.cols, rows: s.term.rows });
    }
  }
  renderTabs();
  // Activate the new tab (IDEA: selectedIndex = lastIndex) unless re-attaching, where the host
  // tells us which tab was selected.
  if (!activeId || !msg.replay) {
    activateSession(s.id);
  }
}

/** Make `id` the visible tab (IDEA: selectTab + updateTabSelection). */
function activateSession(id: string): void {
  const s = byId(id);
  if (!s) {
    return;
  }
  const prev = byId(activeId);
  if (prev) {
    prev.card.classList.add("hidden");
  }
  activeId = id;
  s.card.classList.remove("hidden");
  fitSession(s);
  s.term.refresh(0, Math.max(0, s.term.rows - 1)); // VS Code analog of IDEA's forceReinitFull()
  // Grab keyboard focus so the user can type into the agent immediately (a real terminal does this).
  s.term.focus();
  renderTabs();
}

function selectSession(id: string): void {
  if (id === activeId) {
    return;
  }
  activateSession(id);
  vscode.postMessage({ type: "selectSession", sessionId: id });
}

/** Tear down a tab after the host confirmed the close (IDEA: closeSession). */
function disposeSession(id: string): void {
  const i = sessions.findIndex((s) => s.id === id);
  if (i < 0) {
    return;
  }
  const s = sessions[i];
  if (hoverState?.session.id === id) {
    hideTooltip();
  }
  try {
    s.term.dispose();
  } catch {
    /* already gone */
  }
  s.card.remove();
  sessions.splice(i, 1);
  if (activeId === id) {
    activeId = sessions.length ? sessions[Math.min(i, sessions.length - 1)].id : undefined;
  }
  for (const o of sessions) {
    o.card.classList.toggle("hidden", o.id !== activeId);
  }
  renderTabs();
  const next = byId(activeId);
  if (next) {
    fitSession(next);
    next.term.focus();
  }
}

function requestClose(id: string): void {
  vscode.postMessage({ type: "closeSession", sessionId: id });
}

/** Paint the tab strip: one entry per session + the overflow chevron (IDEA: tabBar / tabDropdownBtn). */
function renderTabs(): void {
  const bar = document.getElementById("tabbar");
  const tabs = document.getElementById("tabs");
  const empty = document.getElementById("empty");
  const chev = document.getElementById("tabChevron") as HTMLButtonElement | null;
  const menu = document.getElementById("tabMenu");
  if (!bar || !tabs || !empty || !menu) {
    return;
  }
  bar.hidden = sessions.length === 0;
  empty.hidden = sessions.length > 0;
  // IDEA: the switch arrow only appears once there is something to switch to.
  if (chev) {
    chev.hidden = sessions.length <= 1;
  }

  tabs.innerHTML = sessions
    .map(
      (s) => `
    <div class="tab ${s.id === activeId ? "active" : ""}" data-sid="${s.id}" title="${escapeAttr(s.command)}">
      ${s.iconUri ? `<img class="logo" src="${escapeAttr(s.iconUri)}" alt="" />` : `<span class="logo">⚡</span>`}
      <span class="tname">${escapeAttr(s.displayName)}</span>
      <button class="tclose" data-sid="${s.id}" title="Close terminal" type="button">✕</button>
    </div>`
    )
    .join("");

  tabs.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
    // Don't let the tab steal focus from the terminal when clicked.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("tclose")) {
        requestClose(el.dataset.sid!);
        return;
      }
      selectSession(el.dataset.sid!);
    });
  });

  menu.innerHTML = sessions
    .map(
      (s) => `
    <div class="agent-opt tab-opt ${s.id === activeId ? "cur" : ""}" data-sid="${s.id}">
      ${s.iconUri ? `<img class="logo" src="${escapeAttr(s.iconUri)}" alt="" />` : `<span class="logo lightning">⚡</span>`}
      <div class="meta"><div class="name">${escapeAttr(s.displayName)}</div></div>
    </div>`
    )
    .join("");
  menu.querySelectorAll<HTMLElement>(".tab-opt").forEach((el) => {
    el.addEventListener("click", () => {
      menu.hidden = true;
      selectSession(el.dataset.sid!);
    });
  });
}

/**
 * True when the buffer line looks like a soft-wrap continuation: tools that break long paths emit
 * `  rest-of-path` on its own row (isWrapped=false). The fragment is a single token of path
 * characters (no internal spaces) that still reads as part of a path — it holds a separator, is
 * truncated at a hyphen, or carries a file extension / line suffix (e.g. "  per-", "  e/ke",
 * "  /main/java/…", "  core/model/PageResult.java:31"). The token may open with a separator, since
 * a wrap can land right before one ("…/src" + "  /main/java/…"). Bare words such as "  TODO" are
 * rejected so indented prose is never glued onto a path.
 */
function isSoftPathContinuation(lineText: string): boolean {
  // Strip any decorative token a tool prints before the path (e.g. "— /Users", "> /Users") so it
  // doesn't mask the path fragment underneath.
  const core = lineText.replace(Regexes.DECORATIVE_PREFIX, "");
  // Strict form: the whole (decorative-stripped) row is a single path token — covers the lone "-"
  // continuation and any clean fragment.
  const strict = Regexes.SOFT_CONTINUATION.exec(core);
  if (strict) {
    const tok = strict[1];
    if (
      tok.includes("/") ||
      tok.includes("\\") ||
      Regexes.TRAILING_HYPHEN.test(tok) ||
      Regexes.FILE_REF.test(tok) ||
      Regexes.LINE_SUFFIX.test(tok)
    ) {
      return true;
    }
  }
  // Relaxed form: a path token at the start of the row with trailing junk afterwards
  // (e.g. "odel/PageResult.java:31 output the same"). Only accept when the token is a strong path
  // indicator, so prose like "  - some note" is still rejected.
  const lead = Regexes.LEADING_PATH_TOKEN.exec(core);
  if (lead) {
    const tok = lead[1];
    if (
      tok.includes("/") ||
      tok.includes("\\") ||
      Regexes.FILE_REF.test(tok) ||
      Regexes.LINE_SUFFIX.test(tok)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when the text reads as a path that continues on the next row: it contains a separator and
 * ends mid-path rather than on a complete file reference (`.java`, `.java:31`, `:31`). A trailing
 * separator counts as incomplete ("…/keeper/"), which is what lets a chain of fragments keep
 * absorbing the rows that follow. A leading decorative token (see DECORATIVE_PREFIX) is stripped
 * first so it doesn't suppress a genuine origin row.
 */
function looksLikeSoftWrapOrigin(text: string): boolean {
  const t = text.replace(Regexes.DECORATIVE_PREFIX, "").trimEnd();
  if (!t || !Regexes.HAS_SEPARATOR.test(t)) {
    return false;
  }
  if (Regexes.FILE_REF.test(t) || Regexes.LINE_SUFFIX.test(t)) {
    return false;
  }
  return Regexes.ENDS_MID_PATH.test(t);
}

/**
 * True for an indented single identifier token that continues a wrapped name mid-word, e.g.
 * "  isonPatternGenerator" finishing "com.cnsharp…EnumCompar". Used to stitch type/member names that
 * wrap across rows with no separator between the fragments. (A bare word like "  TODO" also matches,
 * but gluing it is harmless — provideLinks() never links plain prose.)
 */
function isSoftIdentifierContinuation(lineText: string): boolean {
  return /^[ \t]*[A-Za-z_$][A-Za-z0-9_$]*$/.test(lineText);
}

/**
 * True when the text reads as a type/member name that continues on the next row: it holds a qualified
 * name (dot-separated identifiers). A bare CamelCase word like "SomeNote" is deliberately excluded so
 * prose is never mistaken for an origin.
 */
function looksLikeSoftTypeNameOrigin(text: string): boolean {
  const t = text.replace(Regexes.DECORATIVE_PREFIX, "").trimEnd();
  return /[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*/.test(t);
}

/** Combined continuation/origin checks that also recognise wrapped type/member names. */
const isSoftContinuation = (line: string): boolean =>
  isSoftPathContinuation(line) || isSoftIdentifierContinuation(line);
// Only a *real* file extension (not any ".word") should block a type origin — otherwise a name like
// "EnumCompar" (which ends in ".Compar") would be mistaken for a complete file reference.
const FILE_EXT_RE = new RegExp(`\\.(?:${PROGRAMMING_EXT})$`);
const isSoftOrigin = (text: string): boolean =>
  looksLikeSoftWrapOrigin(text) ||
  (looksLikeSoftTypeNameOrigin(text) && !FILE_EXT_RE.test(text.trimEnd()));

/**
 * Convert a string (character) index within a buffer line into a 1-based CELL column. xterm link
 * ranges are cell-based, but a regex match index is a character index — and wide glyphs (CJK, etc.)
 * occupy two cells. Without this conversion, every link that follows a wide character is placed at the
 * wrong column, and a link near a line end bleeds onto the next line.
 */
function cellXForCharIndex(line: IBufferLine, charIndex: number): number {
  let chars = 0;
  let x = 0;
  while (chars < charIndex) {
    const cell = line.getCell(x);
    if (!cell) {
      break;
    }
    const w = cell.getWidth();
    if (w === 0) {
      // Continuation cell of a wide glyph; advance without consuming a character.
      x++;
      continue;
    }
    chars++;
    x += w;
  }
  return x;
}

/**
 * Attach the combined link provider to ONE session's terminal.
 *
 * Everything here must resolve per session: `s.term` for the buffer/cols and — critically — that
 * session's own `guard`, so what you type in one tab never suppresses (or leaks into) links in
 * another. A module-level guard here would couple every tab's input state together.
 */
function registerLinkProvider(s: SessionView): void {
  const guard = s.guard;
  s.term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const buffer = s.term.buffer.active;
      // TUIs (interactive prompts, pickers, editors) run in the alternate screen buffer. Disable all
      // terminal linkification there; normal agent output (normal buffer) keeps its links.
      if (buffer.type === "alternate") {
        callback([]);
        return;
      }
      // xterm passes `bufferLineNumber` 1-based, but `getLine()` is 0-based (it forwards straight to
      // the buffer's `lines` array). Without the -1 we read the NEXT line, so each row's links would
      // belong to the row below it and the last row would read past the buffer and get none.
      const idx = bufferLineNumber - 1;
      const firstLine = buffer.getLine(idx);
      if (!firstLine) {
        callback([]);
        return;
      }
      // A path/URL wider than the terminal is stored as several buffer rows (visual wrap), so a regex
      // run per-row sees `…/ke` + `eper/…:31` and links each half. Rebuild the original unwrapped
      // string: walk up to the first row of the wrap run, then append every wrapped continuation.
      let startIdx = idx;
      while (startIdx > 0 && buffer.getLine(startIdx)?.isWrapped) {
        startIdx--;
      }
      let endIdx = idx;
      while (buffer.getLine(endIdx + 1)?.isWrapped) {
        endIdx++;
      }
      // Some tools (e.g. Claude Code CLI) emit explicit `\n  rest-of-path` newlines to break long
      // paths. Those rows have isWrapped=false so the loop above misses them. Extend the range to
      // include adjacent "soft continuation" rows: lines that start with 1–4 spaces followed by a
      // path fragment (word chars + slash), whose predecessor looks like an incomplete path origin.
      // How a row contributes to the rebuilt line: a soft continuation loses its indentation, any
      // other row keeps its cells (minus trailing padding).
      const rowText = (i: number): string => {
        const seg = buffer.getLine(i)!;
        return i > startIdx && !seg.isWrapped
          ? seg.translateToString(true).trimStart()
          : seg.translateToString(true);
      };
      const joinedRange = (from: number, to: number): string => {
        let s = "";
        for (let i = from; i <= to; i++) {
          s += rowText(i);
        }
        return s;
      };
      // Walk up over continuation rows so the block starts where the path really begins. A wrap can
      // split mid-token ("mq-kee" + "per-"), so a continuation need not contain a separator itself.
      // Stop as soon as the row directly above is no longer a path continuation — that row is the
      // genuine origin, and walking past it (e.g. onto a blank line) would make the whole extension
      // get rejected and leave only a fragment link.
      let upIdx = startIdx;
      while (upIdx > 0) {
        const curLine = buffer.getLine(upIdx);
        if (!curLine || curLine.isWrapped) break;
        if (!isSoftContinuation(curLine.translateToString(true))) break;
        const prevLine = buffer.getLine(upIdx - 1);
        if (!prevLine || prevLine.isWrapped) break;
        if (!isSoftContinuation(prevLine.translateToString(true))) {
          // The row above is not a continuation; if it's a genuine origin, include it and stop.
          if (isSoftOrigin(prevLine.translateToString(true))) {
            upIdx--;
          }
          break;
        }
        upIdx--;
      }
      // Keep the upward extension only when the row we landed on really opens a link — otherwise an
      // unrelated line above would be glued onto the fragment.
      if (upIdx !== startIdx) {
        const first = buffer.getLine(upIdx);
        if (first && isSoftOrigin(first.translateToString(true))) {
          startIdx = upIdx;
        }
      }
      // Walk down while the next row continues the path AND everything joined so far is still an
      // incomplete path; testing the accumulated text (not just the current row) is what lets a
      // chain like "…/mq-kee" + "per-" + "core/…":31 rejoin into one link.
      while (true) {
        const nextLine = buffer.getLine(endIdx + 1);
        if (!nextLine || nextLine.isWrapped) break;
        if (!isSoftContinuation(nextLine.translateToString(true))) break;
        if (!isSoftOrigin(joinedRange(startIdx, endIdx))) break;
        endIdx++;
      }
      // Per-segment char offset + 1-based row, so a char index in `combined` maps back to a cell.
      // For xterm visual-wrap rows, use translateToString(false) so char indices align with screen
      // cells. For soft-wrap origins trim trailing padding; for soft-wrap continuations strip the
      // leading indentation (and record how many chars were skipped for the cell-index mapping).
      const segStartChar: number[] = [];
      const segLeadSkip: number[] = [];
      const rowOf: number[] = [];
      let combined = "";
      for (let i = startIdx; i <= endIdx; i++) {
        const seg = buffer.getLine(i);
        if (!seg) {
          break;
        }
        const nextSeg = i < endIdx ? buffer.getLine(i + 1) : null;
        const nextIsSoftCont = nextSeg !== null && !nextSeg.isWrapped;
        let segText: string;
        let leadSkip = 0;
        if (i > startIdx && !seg.isWrapped) {
          // Soft-wrap continuation: strip indentation so the path rejoins correctly.
          const raw = seg.translateToString(true);
          const stripped = raw.trimStart();
          leadSkip = raw.length - stripped.length;
          segText = stripped;
        } else if (nextIsSoftCont) {
          // Soft-wrap origin: trim trailing padding so the continuation follows immediately.
          segText = seg.translateToString(true);
        } else {
          segText = seg.translateToString(false);
        }
        segStartChar.push(combined.length);
        segLeadSkip.push(leadSkip);
        rowOf.push(i + 1);
        combined += segText;
      }
      const segCount = rowOf.length;

      // Map a char index in `combined` to a 1-based {x, y} cell. `isEnd` makes the position exclusive
      // (one cell past the last char, xterm convention); if it lands on a row boundary it carries into
      // the next wrapped row so a spanning link stays contiguous.
      const cellForChar = (charIndex: number, isEnd: boolean): { x: number; y: number } => {
        let k = 0;
        while (k < segCount - 1 && charIndex >= segStartChar[k + 1]) {
          k++;
        }
        const rel = charIndex - segStartChar[k];
        const segLine = buffer.getLine(rowOf[k] - 1)!;
        const cols = s.term.cols;
        // segLeadSkip[k] compensates for stripped leading whitespace in soft-cont rows: rel=0 in
        // `combined` corresponds to char segLeadSkip[k] in the actual buffer line.
        let cellX = cellXForCharIndex(segLine, rel + segLeadSkip[k]);
        let y = rowOf[k];
        if (isEnd && cellX >= cols) {
          if (k < segCount - 1) {
            y = rowOf[k + 1];
            cellX = 0;
          } else {
            cellX = cols;
          }
        }
        return { x: cellX + 1, y };
      };

      const all = provideLinks(combined);
      // Suppress any link whose text overlaps what the user is currently typing into the input box
      // (state-based, mirroring IntelliJ's InputAwareLinkFilter — no timing guesswork). Typed text
      // is tracked via xterm onData, so this catches input boxes that live in the NORMAL buffer too.
      const typedSpans = guard.spansIn(combined);
      const links: ILink[] = all
        .filter((c) => {
          if (typedSpans.length) {
            const cs = c.start;
            const ce = c.start + c.length;
            if (typedSpans.some(([ss, se]) => cs < se && ss < ce)) {
              return false;
            }
          }
          const startCell = cellForChar(c.start, false);
          const endCell = cellForChar(c.start + c.length, true);
          // Only surface the link on rows it actually spans (xterm calls provideLinks per row).
          return startCell.y <= bufferLineNumber && bufferLineNumber <= endCell.y;
        })
        .map((c) => {
          const startCell = cellForChar(c.start, false);
          const endCell = cellForChar(c.start + c.length, true);
          return {
            range: { start: startCell, end: endCell },
            text: combined.substr(c.start, c.length),
            activate: () => vscode.postMessage({ type: "navigate", payload: c.payload }),
            hover: (event) => {
              const reqId = ++hoverReqId;
              hoverState = { reqId, payload: c.payload, session: s };
              showTooltip(s, "…", event);
              vscode.postMessage({ type: "hover", reqId, payload: c.payload });
            },
            leave: () => hideTooltip(),
          };
        });
      callback(links);
    },
  });
}

// --- Startup: no terminal is created up front any more (the panel boots into the empty state and
// terminals appear as tabs when agents are launched). Only the global listeners are wired here, and
// they act on every session. ---
try {
  renderTabs();
  // Keep every tab sized to the panel; a hidden card still has a layout box, so this fits them all.
  window.addEventListener("resize", () => fitAll());
  // When the panel is hidden and reshown (retainContextWhenHidden keeps the context alive), re-fit so
  // the terminals match the panel's current size — the layout may have changed while it was hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      fitAll();
    }
  });

  // Re-theme every xterm when the user switches VS Code color themes. VS Code rewrites the theme CSS
  // variables on `body` (and sometimes `:root`) when the theme changes, so watch both.
  const themeObserver = new MutationObserver(() => applyTheme());
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  // Overflow chevron: list every open terminal for quick switching (IDEA: tabDropdownBtn).
  document.getElementById("tabChevron")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("tabMenu") as HTMLDivElement | null;
    if (menu) {
      menu.hidden = !menu.hidden;
    }
  });
} catch (e) {
  // Startup wiring failed. The agent picker above is unaffected, so the panel stays usable; surface
  // the error instead of silently dying.
  console.error("YOLO panel startup failed:", e);
}
