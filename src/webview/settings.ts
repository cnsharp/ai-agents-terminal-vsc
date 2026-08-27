// Bundled settings webview entry (esbuild -> media/dist/settings.js).
// Renders a per-agent permission table (skip flag + base args) and the global skip toggle, plus a
// Custom Tools editor (add / edit / remove fully custom agents) with inline "installed?" validation.

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

interface AgentRow {
  id: string;
  displayName: string;
  command: string;
}
interface CustomToolRow {
  id: string;
  displayName: string;
  command: string;
  baseArgs: string;
  iconPath: string;
}
interface SettingsState {
  agents: AgentRow[];
  skipEnabled: boolean;
  flags: Record<string, string>; // command -> flag
  baseArgs: Record<string, string>; // id -> baseArgs
  customTools: CustomToolRow[];
}

let state: SettingsState = {
  agents: [],
  skipEnabled: false,
  flags: {},
  baseArgs: {},
  customTools: [],
};

// command -> resolved absolute path (or undefined). Updated by the host's validateResult message.
let validation: Record<string, string | undefined> = {};

function render(): void {
  const root = document.getElementById("root")!;
  const agentRows = state.agents
    .map((a) => {
      const flag = state.flags[a.command] ?? "";
      const args = state.baseArgs[a.id] ?? "";
      return `<div class="row">
        <span class="name">${escapeHtml(a.displayName)}</span>
        <span class="cmd">${escapeHtml(a.command)}</span>
        <label class="f">skip flag<input data-kind="flag" data-cmd="${escapeAttr(a.command)}" value="${escapeAttr(flag)}" placeholder="--dangerously-skip-permissions" /></label>
        <label class="b">base args<input data-kind="base" data-id="${escapeAttr(a.id)}" value="${escapeAttr(args)}" placeholder="" /></label>
      </div>`;
    })
    .join("");

  const toolCards = state.customTools
    .map((t) => {
      const resolved = validation[t.command];
      const badge = !t.command.trim()
        ? `<span class="badge">—</span>`
        : resolved
        ? `<span class="badge ok">✓ installed</span>`
        : `<span class="badge missing">⚠ not found on PATH</span>`;
      return `<div class="ctool" data-id="${escapeAttr(t.id)}">
        <input data-ct="displayName" value="${escapeAttr(t.displayName)}" placeholder="Display name" />
        <input data-ct="command" value="${escapeAttr(t.command)}" placeholder="command (e.g. my-agent)" />
        <input data-ct="iconPath" value="${escapeAttr(t.iconPath)}" placeholder="icon path (optional)" />
        <span class="delwrap">${badge} <button class="delbtn" data-del="${escapeAttr(t.id)}" title="Remove">✕</button></span>
      </div>`;
    })
    .join("");

  root.innerHTML = `
    <label class="global"><input type="checkbox" id="globalSkip" ${
      state.skipEnabled ? "checked" : ""
    }/> Inject skip-permission flag by default when launching</label>
    <div class="head"><span>Agent</span><span>Command</span><span>Skip flag</span><span>Base args</span></div>
    ${agentRows}
    <h2>Custom tools</h2>
    <div class="ctools">${toolCards}</div>
    <button class="addbtn" id="addTool">+ Add custom tool</button>
    <button id="save">Save</button>
    <span id="status"></span>`;

  document.getElementById("save")!.addEventListener("click", save);
  document.getElementById("addTool")!.addEventListener("click", addTool);
  root.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach((b) => {
    b.addEventListener("click", () => removeTool(b.dataset.del!));
  });
  // Re-validate whenever a command field changes.
  root.querySelectorAll<HTMLInputElement>("input[data-ct='command']").forEach((el) => {
    el.addEventListener("input", requestValidation);
  });

  requestValidation();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
}

function addTool(): void {
  const id = `custom.${slug("tool" + (state.customTools.length + 1))}`;
  state.customTools = [
    ...state.customTools,
    { id, displayName: "", command: "", baseArgs: "", iconPath: "" },
  ];
  render();
}

function removeTool(id: string): void {
  state.customTools = state.customTools.filter((t) => t.id !== id);
  render();
}

/** Collect every custom-tool command and ask the host to resolve each to an absolute path. */
function requestValidation(): void {
  const commands = state.customTools.map((t) => t.command).filter((c) => c.trim().length > 0);
  if (commands.length > 0) {
    vscode.postMessage({ type: "validate", commands });
  }
}

function save(): void {
  const skipEnabled = (document.getElementById("globalSkip") as HTMLInputElement).checked;
  const flags: Record<string, string> = {};
  const baseArgs: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>("input[data-kind='flag']").forEach((el) => {
    const cmd = el.dataset.cmd!;
    if (el.value.trim()) {
      flags[cmd] = el.value.trim();
    }
  });
  document.querySelectorAll<HTMLInputElement>("input[data-kind='base']").forEach((el) => {
    const id = el.dataset.id!;
    if (el.value.trim()) {
      baseArgs[id] = el.value.trim();
    }
  });

  const customTools = state.customTools
    .map((t) => {
      const card = document.querySelector<HTMLDivElement>(`.ctool[data-id='${cssEscape(t.id)}']`);
      return {
        id: t.id,
        displayName: card?.querySelector<HTMLInputElement>("input[data-ct='displayName']")?.value?.trim() || t.displayName,
        command: card?.querySelector<HTMLInputElement>("input[data-ct='command']")?.value?.trim() || t.command,
        // baseArgs are edited in the per-agent permission table (keyed by this tool's id).
        baseArgs: t.baseArgs,
        iconPath: card?.querySelector<HTMLInputElement>("input[data-ct='iconPath']")?.value?.trim() || t.iconPath,
      };
    })
    .filter((t) => t.command.length > 0);

  vscode.postMessage({ type: "save", skipEnabled, flags, baseArgs, customTools });
  const status = document.getElementById("status")!;
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 1500);
}

// Minimal CSS.escape fallback for attribute selectors.
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === "config") {
    state = msg.state;
    render();
  } else if (msg.type === "validateResult") {
    validation = msg.results ?? {};
    // Update only the badges rather than full re-render (preserves input focus).
    state.customTools.forEach((t) => {
      const card = document.querySelector<HTMLDivElement>(`.ctool[data-id='${cssEscape(t.id)}'] .delwrap`);
      if (!card) return;
      const resolved = validation[t.command];
      card.innerHTML = !t.command.trim()
        ? `<span class="badge">—</span>`
        : resolved
        ? `<span class="badge ok">✓ installed</span>`
        : `<span class="badge missing">⚠ not found on PATH</span>` +
          ` <button class="delbtn" data-del="${escapeAttr(t.id)}" title="Remove">✕</button>`;
    });
    document.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach((b) => {
      b.addEventListener("click", () => removeTool(b.dataset.del!));
    });
  }
});

vscode.postMessage({ type: "ready" });
