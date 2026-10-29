"use strict";
(() => {
  // src/webview/manage.ts
  var vscode = acquireVsCodeApi();
  var cards = [];
  var checking = false;
  var statusLine = "";
  var strings = {};
  function t(key, fallback) {
    const v = strings[key];
    return v && v !== key ? v : fallback;
  }
  var grid = document.getElementById("grid");
  var empty = document.getElementById("empty");
  var refreshBtn = document.getElementById("refresh");
  var upgradeAllBtn = document.getElementById("upgradeAll");
  var statusEl = document.getElementById("statusline");
  refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  upgradeAllBtn.addEventListener("click", () => vscode.postMessage({ type: "upgradeAll" }));
  window.addEventListener("message", (e) => {
    const msg = e.data ?? {};
    switch (msg.type) {
      case "init":
        cards = msg.agents ?? [];
        strings = msg.strings ?? {};
        render();
        break;
      case "agentUpdate": {
        const c = cards.find((x) => x.id === msg.agentId);
        if (c) {
          c.status = msg.status;
          c.current = msg.current ?? "";
          c.latest = msg.latest ?? "";
          c.error = msg.error;
          c.installed = c.installed || !!msg.current || msg.status === "UP_TO_DATE" || msg.status === "UPDATE_AVAILABLE" || msg.status === "MANUAL";
          render();
        }
        break;
      }
      case "busy": {
        const c = cards.find((x) => x.id === msg.agentId);
        if (c) {
          c.busy = msg.busy ? msg.label ?? "working\u2026" : void 0;
          render();
        }
        break;
      }
      case "checking":
        checking = !!msg.checking;
        refreshBtn.disabled = checking;
        render();
        break;
      case "result": {
        const c = cards.find((x) => x.id === msg.agentId);
        if (c) {
          c.result = { ok: !!msg.ok, message: String(msg.message ?? "") };
          render();
        }
        break;
      }
      case "status":
        statusLine = String(msg.message ?? "");
        render();
        break;
    }
  });
  function upgradableCount() {
    return cards.filter((c) => c.status === "UPDATE_AVAILABLE" && c.canUpgrade && !c.busy).length;
  }
  function render() {
    cards.sort((a, b) => Number(b.installed) - Number(a.installed));
    statusEl.textContent = statusLine;
    upgradeAllBtn.textContent = upgradableCount() > 0 ? t("manage.updateAllCount", "Update All ({0})").replace("{0}", String(upgradableCount())) : t("manage.updateAll", "Update All");
    upgradeAllBtn.disabled = checking || upgradableCount() === 0;
    empty.hidden = cards.length > 0;
    grid.replaceChildren(...cards.map(cardEl));
  }
  function cardEl(c) {
    const card = document.createElement("div");
    card.className = "card";
    const head = document.createElement("div");
    head.className = "head";
    const logo = document.createElement(c.iconUri ? "img" : "div");
    if (c.iconUri) {
      logo.className = "logo";
      logo.src = c.iconUri;
    } else {
      logo.className = "logo fallback";
      logo.textContent = "\u2301";
    }
    const names = document.createElement("div");
    names.className = "names";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = c.displayName;
    names.append(name);
    head.append(logo, names);
    if (c.status === "UPDATE_AVAILABLE") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = t("manage.updateAvailable", "Update available");
      head.append(badge);
    }
    const rows = document.createElement("div");
    rows.className = "rows";
    rows.append(
      versionRow(t("manage.currentVersion", "Current version"), c),
      versionRow(t("manage.latestVersion", "Latest version"), c, true)
    );
    if (c.error) {
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = c.error;
      rows.append(err);
    }
    if (c.result) {
      const res = document.createElement("div");
      res.className = c.result.ok ? "ok" : "error";
      res.textContent = c.result.message;
      rows.append(res);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    if (c.busy) {
      const b = document.createElement("button");
      b.disabled = true;
      const s = document.createElement("span");
      s.className = "spinner";
      b.append(s, document.createTextNode(c.busy));
      actions.append(b);
    } else {
      if (c.status === "UPDATE_AVAILABLE" && c.canUpgrade) {
        actions.append(actionBtn(t("manage.update", "Update"), true, () => vscode.postMessage({ type: "upgrade", agentId: c.id })));
      } else if (!c.installed && c.canInstall) {
        actions.append(actionBtn(t("manage.install", "Install"), false, () => vscode.postMessage({ type: "install", agentId: c.id })));
      } else if (c.installed && c.canUpgrade && c.status !== "CHECKING" && c.status !== "UP_TO_DATE") {
        actions.append(actionBtn(t("manage.update", "Update"), false, () => vscode.postMessage({ type: "upgrade", agentId: c.id })));
      }
      if (c.url) {
        actions.append(actionBtn(t("manage.openSite", "Website"), false, () => vscode.postMessage({ type: "openUrl", url: c.url })));
      }
    }
    card.append(head, rows, actions);
    return card;
  }
  function versionRow(label, c, latest = false) {
    const row = document.createElement("div");
    row.className = "row";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "v";
    if (latest) {
      v.textContent = c.latest || (c.status === "CHECKING" ? t("manage.checking", "Checking\u2026") : t("manage.unknown", "\u2014"));
      if (c.status === "CHECKING" && !c.latest) v.classList.add("loading");
    } else {
      v.textContent = c.status === "CHECKING" && !c.current ? t("manage.checking", "Checking\u2026") : c.current || (c.installed ? t("manage.unknown", "\u2014") : t("manage.notInstalled", "not installed"));
      if (v.textContent === t("manage.checking", "Checking\u2026")) v.classList.add("loading");
    }
    row.append(k, v);
    return row;
  }
  function actionBtn(label, primary, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.addEventListener("click", onClick);
    return b;
  }
  vscode.postMessage({ type: "ready" });
})();
