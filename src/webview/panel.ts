// Bundled webview entry (compiled by esbuild -> media/dist/panel.js).
// Owns the xterm.js terminal, the combined link provider (de-duplicated + prioritized), and the
// message bridge to the extension host.
//
// IMPORTANT: the agent picker + the `ready` handshake MUST be wired up BEFORE the xterm terminal is
// initialised. A failure while creating the terminal (e.g. a layout/element issue) must never prevent
// the host from learning the webview is ready and shipping the agent list — otherwise the dropdown
// stays empty. Terminal init is therefore isolated in a try/catch.

import { Terminal, type ILink, type ITheme, type Terminal as ITerminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

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
}

type HostMessage =
  | InitMessage
  | { type: "data"; data: string }
  | { type: "spawned"; command: string; backend?: "embedded" | "vscode-terminal" }
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

// --- Agent picker (custom listbox; native <select> can't show the resolved path/command on hover) ---
let agents: AgentOption[] = [];
let selectedAgentId = "";

// --- YOLO (skip-permissions) toggle state + icon set (icons come from the host / IDEA edition) ---
let skipEnabled = false;
let skipIcons: SkipIconSet | undefined;

// --- Resume toggle state + icon set (icons come from the host / IDEA edition) ---
let resumeEnabled = false;
let resumeIcons: SkipIconSet | undefined;

// Which backend is currently hosting the running agent. When "vscode-terminal", the agent runs in a
// real VS Code terminal (revealed) and the embedded xterm only shows a notice — keystrokes/ output are
// not bridged, so we must not forward input (that would double-type into the revealed terminal).
let backend: "embedded" | "vscode-terminal" | undefined;

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
    <img class="ic ic-off-dark" src="${escapeAttr(skipIcons.offDark)}" alt="" />
    <img class="ic ic-on" src="${escapeAttr(skipIcons.on)}" alt="" />
    <img class="ic ic-on-dark" src="${escapeAttr(skipIcons.onDark)}" alt="" />`;
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
      <img class="ic ic-off-dark" src="${escapeAttr(resumeIcons.offDark)}" alt="" />
      <img class="ic ic-on" src="${escapeAttr(resumeIcons.on)}" alt="" />
      <img class="ic ic-on-dark" src="${escapeAttr(resumeIcons.onDark)}" alt="" />`;
  }
}

function renderAgentMenu(): void {
  const menu = document.getElementById("agentMenu") as HTMLDivElement | null;
  if (!menu) {
    return;
  }
  // Only show agents that resolved on PATH.
  const visible = agents.filter((a) => a.resolvedPath);
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
      agents = msg.agents || [];
      renderAgentMenu();
      if (!selectedAgentId) {
        const firstInstalled = agents.find((a) => a.resolvedPath);
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
      // Only the embedded backend pipes output here; the vscode-terminal backend renders in the
      // revealed VS Code terminal instead.
      if (backend === "embedded") {
        term?.write(msg.data);
      }
      break;
    case "spawned":
      backend = msg.backend;
      if (backend === "vscode-terminal") {
        term?.reset();
        term?.writeln(
          `→ launched ${msg.command} in the VS Code Terminal — focus it to interact.`
        );
        term?.writeln(
          "(node-pty couldn't spawn a PTY here, so the agent runs in a real VS Code terminal instead.)"
        );
      } else {
        term?.reset();
      }
      break;
    case "hoverResult":
      // Only apply if this reply matches the link currently being hovered.
      if (hoverState && msg.reqId === hoverState.reqId && msg.text) {
        hoverEl.textContent = msg.text;
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
  vscode.postMessage({ type: "launch", agentId: selectedAgentId, skip: skipEnabled, resume: resumeEnabled });
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
  const bg =
    readVscodeColor("--vscode-terminal-background") ??
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
  if (!term) {
    return;
  }
  term.options.theme = buildTerminalTheme();
  const wrap = document.getElementById("terminal");
  if (wrap) {
    wrap.style.background = readVscodeColor("--vscode-editor-background") ?? "";
  }
}

// --- Terminal (xterm) — isolated so a failure here can't break the agent picker above ---
let term: ITerminal | undefined;

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
  for (const m of matchers) {
    const re = new RegExp(m.source, m.flags.includes("g") ? m.flags : m.flags + "g");
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

// Hover preview (xterm 5.x DOM-based tooltip): one shared element appended to term.element. On hover
// we post a `hover` request to the host, show a "…" placeholder, then fill in the resolved text when
// the host replies with `hoverResult`. Keyed by reqId so stale replies are ignored.
let hoverReqId = 0;
let hoverState: { reqId: number; payload: LinkPayload } | undefined;
const hoverEl = document.createElement("div");
hoverEl.className = "xterm-hover";
hoverEl.style.display = "none";

function showTooltip(text: string, event: MouseEvent): void {
  hoverEl.textContent = text;
  hoverEl.style.display = "block";
  const rect = (term?.element ?? document.body).getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  hoverEl.style.left = `${x + 12}px`;
  hoverEl.style.top = `${Math.max(0, y - hoverEl.offsetHeight - 6)}px`;
}

function hideTooltip(): void {
  hoverEl.style.display = "none";
  hoverState = undefined;
}

function initTerminal(): void {
  const el = document.getElementById("terminal");
  if (!el) {
    return;
  }
  const t = new Terminal({
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    fontSize: 13,
    cursorBlink: true,
    theme: buildTerminalTheme(),
  });
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open(el);
  fit.fit();
  t.element?.appendChild(hoverEl);

  t.onData((d) => {
    // Only forward keystrokes when the agent is hosted in the embedded terminal. In the
    // vscode-terminal backend the user types directly in the revealed VS Code terminal; forwarding
    // here would double-type.
    if (backend === "embedded") {
      vscode.postMessage({ type: "input", data: d });
    }
  });
  t.onResize(({ cols, rows }) => vscode.postMessage({ type: "resize", cols, rows }));
  window.addEventListener("resize", () => fit.fit());

  // Re-theme xterm when the user switches VS Code color themes. VS Code rewrites the theme CSS
  // variables on `body` (and sometimes `:root`) when the theme changes, so watch both.
  const themeObserver = new MutationObserver(() => applyTheme());
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  t.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = t.buffer.active.getLine(bufferLineNumber);
      if (!line) {
        callback([]);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = provideLinks(text).map((c) => ({
        range: {
          start: { x: c.start + 1, y: bufferLineNumber },
          end: { x: c.start + c.length + 1, y: bufferLineNumber },
        },
        text: text.substr(c.start, c.length),
        activate: () => vscode.postMessage({ type: "navigate", payload: c.payload }),
        hover: (event) => {
          const reqId = ++hoverReqId;
          hoverState = { reqId, payload: c.payload };
          showTooltip("…", event);
          vscode.postMessage({ type: "hover", reqId, payload: c.payload });
        },
        leave: () => hideTooltip(),
      }));
      callback(links);
    },
  });

  term = t;
}

try {
  initTerminal();
} catch (e) {
  // Terminal init failed (layout/element/xterm issue). The agent picker above is unaffected, so the
  // panel stays usable; surface the error instead of silently dying.
  console.error("YOLO terminal init failed:", e);
  const el = document.getElementById("terminal");
  if (el) {
    el.textContent = "Terminal failed to initialise: " + String(e);
  }
}
