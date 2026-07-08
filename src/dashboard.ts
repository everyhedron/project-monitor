import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { addProjects, removeProjects } from "./config";
import { discoverWorkspace, type InstalledExtensionInfo } from "./discovery";
import { logError } from "./log";
import type { ProjectMonitorConfig } from "./config";
import type { GitStatus, LicenseSummary, Project, ReadmeSummary, ServiceSummary, Suggestion, TodoSummary } from "./types";

export const dashboardViewType = "projectMonitor.dashboard";

type DashboardMessage = {
  command?: string;
  path?: string;
  paths?: string[];
  requestId?: string;
  tab?: string;
  text?: string;
  url?: string;
  value?: boolean;
};

export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private activeTab = "projects-view";
  private timer: NodeJS.Timeout | undefined;
  private nextRefreshAt = 0;
  private lastProjects: Project[] = [];
  private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private getConfig: () => ProjectMonitorConfig
  ) {
    this.statusBarItem.command = "projectMonitor.openDashboard";
    this.context.subscriptions.push(this.statusBarItem);
  }

  hasPanel(): boolean {
    return this.panel !== undefined;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      dashboardViewType,
      "Project Monitor",
      vscode.ViewColumn.One,
      {
        enableFindWidget: false,
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.attachPanel(panel);
  }

  restore(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true
    };
    this.attachPanel(panel);
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;

    panel.onDidDispose(
      () => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
        this.refreshInFlight = undefined;
        this.stopTimer();
      },
      undefined,
      this.context.subscriptions
    );

    panel.webview.onDidReceiveMessage(
      (message: DashboardMessage) => {
        void this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    panel.onDidChangeViewState(
      () => {
        if (this.panel !== panel) {
          return;
        }
        if (panel.visible) {
          void this.refresh(false);
        }
      },
      undefined,
      this.context.subscriptions
    );

    this.startTimer();
    void this.refresh();
  }

  async refresh(resetTimer = true): Promise<void> {
    if (!this.panel) {
      return;
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshNow(resetTimer);
    try {
      await this.refreshInFlight;
    } catch (error) {
      logError("Refresh failed.", error);
    } finally {
      this.refreshInFlight = undefined;
      if (this.panel && !this.timer) {
        this.nextRefreshAt = Date.now() + this.getConfig().refreshIntervalMs;
        this.startTimer();
      }
    }
  }

  restartTimer(): void {
    if (!this.panel) {
      return;
    }
    this.nextRefreshAt = Date.now() + this.getConfig().refreshIntervalMs;
    this.startTimer();
  }

  dispose(): void {
    this.stopTimer();
    this.panel?.dispose();
  }

  private startTimer(): void {
    this.stopTimer();
    if (!this.panel) {
      return;
    }
    const now = Date.now();
    const refreshIntervalMs = this.getConfig().refreshIntervalMs;
    if (this.nextRefreshAt <= now) {
      this.nextRefreshAt = now + refreshIntervalMs;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(false);
    }, Math.max(0, this.nextRefreshAt - now));
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async refreshNow(resetTimer = true): Promise<void> {
    if (!this.panel) {
      return;
    }

    const config = this.getConfig();
    const installedExtensions = new Map<string, InstalledExtensionInfo>(
      vscode.extensions.all.map((extension) => [
        extension.id.toLowerCase(),
        { version: typeof extension.packageJSON?.version === "string" ? extension.packageJSON.version : undefined }
      ])
    );
    const { projects, suggestions } = await discoverWorkspace(config.projects, installedExtensions, {
      includeSuggestions: this.activeTab === "suggestions-view"
    });
    if (!this.panel) {
      return;
    }
    this.lastProjects = projects;
    this.updateStatusBar(projects);
    if (resetTimer || this.nextRefreshAt <= Date.now()) {
      this.nextRefreshAt = Date.now() + config.refreshIntervalMs;
    }
    this.panel.webview.html = renderDashboard(projects, suggestions, this.nextRefreshAt);
    this.startTimer();
  }

  private updateStatusBar(projects: Project[]): void {
    const badCount = projects.filter((project) => project.status === "stopped" || project.status === "stale").length;
    this.statusBarItem.text = `$(folder-library) ${badCount}/${projects.length}`;
    this.statusBarItem.tooltip = createStatusTooltip(projects);
    this.statusBarItem.show();
  }

  private async handleMessage(message: DashboardMessage): Promise<void> {
    try {
      if (message.command === "refresh") {
        await this.refresh();
        return;
      }

      if (message.command === "activeTabChanged" && message.tab) {
        const changed = this.activeTab !== message.tab;
        this.activeTab = message.tab;
        if (changed && message.tab === "suggestions-view") {
          await this.refresh();
        }
        return;
      }

      if (message.command === "openFolder" && message.path) {
        await this.revealFolder(message.path);
        return;
      }

      if (message.command === "openUrl" && message.url) {
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      }

      if (message.command === "openFile" && message.path) {
        await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: false });
        return;
      }

      if (message.command === "openTerminal" && message.path) {
        this.openProjectTerminal(message.path);
        return;
      }

      if (message.command === "openAgent" && message.path) {
        await this.openProjectAgent(message.path);
        return;
      }

      if (message.command === "openClaudeAgent" && message.path) {
        await this.openProjectClaudeAgent(message.path);
        return;
      }

      if (message.command === "copyText" && message.text) {
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.showInformationMessage("Copied to the clipboard.");
        return;
      }

      if (message.command === "reloadWindow") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return;
      }

      if (message.command === "removeSelected" && message.paths && message.paths.length > 0) {
        await this.confirmAndRemoveProjects(message.paths);
        return;
      }

      if ((message.command === "copyContext" || message.command === "attachContext") && message.paths && message.paths.length > 0) {
        await this.copyProjectsContext(message.paths);
        return;
      }

      if (message.command === "addSuggestion" && message.path) {
        await addProjects([message.path]);
        await this.refresh();
        return;
      }

      if (message.command === "addProject") {
        const selection = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: true,
          openLabel: "Add Project"
        });
        if (selection && selection.length > 0) {
          await addProjects(selection.map((uri) => uri.fsPath));
        }
        await this.refresh();
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      logError(`Command failed: ${message.command ?? "unknown"}`, error);
      void vscode.window.showErrorMessage(`Project Monitor: ${messageText}`);
    } finally {
      if (message.requestId) {
        void this.panel?.webview.postMessage({
          command: "operationComplete",
          requestId: message.requestId,
          sourceCommand: message.command
        });
      }
    }
  }

  private async revealFolder(folderPath: string): Promise<void> {
    const folder = vscode.Uri.file(folderPath);
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand("revealInExplorer", folder);
  }

  private openProjectTerminal(projectPath: string): void {
    const terminalName = toProperProjectName(path.basename(projectPath));
    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    const terminal = vscode.window.createTerminal({
      cwd: projectPath,
      name: terminalName
    });
    terminal.show();
  }

  private async openProjectAgent(projectPath: string): Promise<void> {
    const homeDir = os.homedir();
    const projectName = toProperProjectName(path.basename(projectPath));
    const terminalName = `${projectName} | Codex`;
    await vscode.env.clipboard.writeText(projectPath);

    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    const session = await findCodexSession(homeDir, projectName);
    const terminal = vscode.window.createTerminal({
      cwd: homeDir,
      name: terminalName
    });
    terminal.show();
    terminal.sendText(session ? `codex resume ${session.id}` : "codex");
  }

  private async openProjectClaudeAgent(projectPath: string): Promise<void> {
    const homeDir = os.homedir();
    const projectName = toProperProjectName(path.basename(projectPath));
    const terminalName = `${projectName} | Claude`;
    await vscode.env.clipboard.writeText(projectPath);

    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    const terminal = vscode.window.createTerminal({
      cwd: homeDir,
      name: terminalName
    });
    terminal.show();
    terminal.sendText("claude");
  }

  private async confirmAndRemoveProjects(paths: string[]): Promise<void> {
    const count = new Set(paths).size;
    const label = count === 1 ? "Remove Project" : "Remove Projects";
    const confirmation = await vscode.window.showWarningMessage(
      `Remove ${count} selected project${count === 1 ? "" : "s"} from Project Monitor?`,
      { modal: true },
      label
    );

    if (confirmation !== label) {
      return;
    }

    await removeProjects(paths);
    await this.refresh();
  }

  private async copyProjectsContext(paths: string[]): Promise<void> {
    const contextText = this.buildSelectedProjectContext(paths);
    await vscode.env.clipboard.writeText(contextText);
    void vscode.window.showInformationMessage("Selected project context copied to the clipboard.");
  }

  private buildSelectedProjectContext(paths: string[]): string {
    const selectedPaths = new Set(paths);
    const selectedProjects = this.lastProjects.filter((project) => selectedPaths.has(project.path));
    const projects =
      selectedProjects.length > 0
        ? selectedProjects
        : paths.map((projectPath) => ({
            id: projectPath,
            name: projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath,
            path: projectPath,
            kind: "unknown",
            status: "unknown",
            ports: [],
            urls: [],
            evidence: [],
            suggestedCommands: [],
            publishedRoutes: [],
            git: emptyGitStatus(),
            todo: emptyTodoSummary(),
            readme: emptyReadmeSummary(),
            license: emptyLicenseSummary()
          } satisfies Project));

    return [
      "Use these Project Monitor selections as context:",
      "",
      ...projects.map((project) =>
        [
          `Project: ${project.name}`,
          `Path: ${project.path}`,
          `Kind: ${project.kind}`,
          `Status: ${project.status}`,
          `Git: ${project.git.label}`,
          `Git remote: ${project.git.hasRemote ? "yes" : "no"}`,
          `Git committed: ${project.git.committed ? "yes" : "no"}`,
          `Git synced: ${project.git.synced ? "yes" : "no"}`,
          `Ports: ${project.ports.length > 0 ? project.ports.join(", ") : "none"}`,
          `Published: ${project.publishedRoutes.length > 0 ? project.publishedRoutes.map((route) => route.url).join(", ") : "none"}`
        ].join("\n")
      )
    ].join("\n\n");
  }
}

function renderDashboard(projects: Project[], suggestions: Suggestion[], nextRefreshAt: number): string {
  const statusTooltip = createStatusTooltip(projects);
  const parentFolders = [...new Set(projects.map((project) => path.dirname(project.path)))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  const nonce = createNonce();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Project Monitor</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --secondary-button: var(--vscode-button-secondaryBackground);
      --secondary-button-fg: var(--vscode-button-secondaryForeground);
      --card: var(--vscode-sideBar-background);
      --running: #2ea043;
      --serving: #58a6ff;
      --installed: #a371f7;
      --stopped: #d29922;
      --git-good: #2ea043;
      --git-bad: #f85149;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .shell {
      width: min(1280px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 0 0 32px;
    }

    header {
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border);
      padding: 24px 0 18px;
      margin-bottom: 18px;
    }

    .header-actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .summary {
      color: var(--muted);
      line-height: 1.5;
    }

    .tracked-count {
      border-bottom: 1px dotted currentColor;
      cursor: help;
    }

    .tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 16px;
    }

    .project-toolbar {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .toolbar-group {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    label {
      color: var(--muted);
    }

    select {
      appearance: none;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      color: var(--vscode-dropdown-foreground);
      font: inherit;
      min-height: 30px;
      max-width: min(560px, calc(100vw - 80px));
      padding: 4px 28px 4px 9px;
    }

    .search-input {
      appearance: none;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      font: inherit;
      min-height: 30px;
      min-width: 180px;
      padding: 4px 9px;
    }

    .find-widget {
      align-items: center;
      background: var(--vscode-editorWidget-background, var(--card));
      border: 1px solid var(--vscode-editorWidget-border, var(--border));
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      color: var(--vscode-editorWidget-foreground, var(--fg));
      display: flex;
      gap: 2px;
      padding: 4px;
      position: fixed;
      right: 24px;
      top: 12px;
      z-index: 50;
    }

    .find-widget.hidden {
      display: none;
    }

    .find-part {
      align-items: center;
      display: flex;
      gap: 2px;
    }

    .find-input {
      appearance: none;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 3px;
      color: var(--vscode-input-foreground);
      font: inherit;
      height: 26px;
      padding: 2px 8px;
      width: 200px;
    }

    .find-toggles {
      display: flex;
      gap: 1px;
      margin-left: -28px;
    }

    .find-toggle {
      appearance: none;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      height: 20px;
      min-height: 0;
      padding: 0 4px;
    }

    .find-toggle.active {
      background: var(--vscode-inputOption-activeBackground, color-mix(in srgb, var(--button) 35%, transparent));
      border-color: var(--vscode-inputOption-activeBorder, var(--button));
      color: var(--vscode-inputOption-activeForeground, var(--fg));
    }

    .find-count {
      color: var(--muted);
      font-size: 12px;
      min-width: 72px;
      padding: 0 6px;
      text-align: center;
      white-space: nowrap;
    }

    .find-nav {
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 3px;
      color: var(--fg);
      cursor: pointer;
      font: inherit;
      height: 26px;
      min-height: 0;
      padding: 0 6px;
    }

    .find-nav:hover,
    .find-toggle:hover {
      background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--fg) 12%, transparent));
    }

    .find-nav:disabled {
      cursor: default;
      opacity: 0.4;
    }

    mark.find-match {
      background: var(--vscode-editor-findMatchHighlightBackground, #ffd54a66);
      color: inherit;
      border-radius: 2px;
    }

    mark.find-match.current {
      background: var(--vscode-editor-findMatchBackground, #ff9632aa);
    }

    .tab {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }

    .tab.active {
      background: var(--button);
      color: var(--button-fg);
    }

    .view-mode {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }

    .view-mode.active {
      background: var(--button);
      color: var(--button-fg);
    }

    .view.hidden,
    .mode-view.hidden,
    .is-filtered {
      display: none;
    }

    button {
      appearance: none;
      border: 0;
      border-radius: 4px;
      background: var(--button);
      color: var(--button-fg);
      cursor: pointer;
      font: inherit;
      min-height: 30px;
      padding: 5px 10px;
    }

    button.secondary {
      background: var(--secondary-button);
      color: var(--secondary-button-fg);
    }

    button.danger {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
    }

    button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      min-width: 0;
      padding: 14px;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    .card.is-selected {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 0 18px color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
    }

    .card.add-card {
      cursor: default;
    }

    .card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .card-heading {
      flex: 1 1 auto;
      min-width: 0;
    }

    .project-title-row {
      align-items: baseline;
      display: flex;
      flex-wrap: nowrap;
      gap: 6px 10px;
      min-width: 0;
    }

    h2 {
      font-size: 16px;
      line-height: 1.25;
      margin: 0;
      letter-spacing: 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title-mismatch {
      color: var(--vscode-errorForeground);
    }

    .project-actions {
      color: var(--muted);
      display: inline-flex;
      flex: 0 0 auto;
      flex-wrap: nowrap;
      gap: 8px;
      margin-top: 3px;
      white-space: nowrap;
    }

    .text-action {
      appearance: none;
      background: transparent;
      border: 0;
      color: var(--muted);
      cursor: pointer;
      display: inline;
      font: inherit;
      min-height: 0;
      padding: 0;
      text-decoration: underline;
    }

    .text-action:hover {
      color: var(--vscode-textLink-activeForeground);
    }

    .path {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .path-button {
      appearance: none;
      background: transparent;
      border: 0;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      display: inline;
      font: inherit;
      min-height: 0;
      padding: 0;
      text-align: left;
    }

    .path-button:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }

    .badge {
      border-radius: 999px;
      border: 1px solid var(--border);
      flex: 0 0 auto;
      font-size: 12px;
      padding: 3px 8px;
      text-transform: capitalize;
    }

    .badge.running {
      border-color: color-mix(in srgb, var(--running) 55%, var(--border));
      color: var(--running);
    }

    .badge.serving {
      border-color: color-mix(in srgb, var(--serving) 55%, var(--border));
      color: var(--serving);
    }

    .badge.installed {
      border-color: color-mix(in srgb, var(--installed) 55%, var(--border));
      color: var(--installed);
    }

    .badge.stale {
      border-color: color-mix(in srgb, var(--git-bad) 60%, var(--border));
      color: var(--git-bad);
    }

    .badge.stopped {
      border-color: color-mix(in srgb, var(--stopped) 55%, var(--border));
      color: var(--stopped);
    }

    button.badge {
      appearance: none;
      background: transparent;
      cursor: pointer;
      font: inherit;
    }

    button.badge:hover {
      text-decoration: underline;
    }

    dl {
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 7px 10px;
      margin: 0;
    }

    dt {
      color: var(--muted);
    }

    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .muted-status {
      color: var(--muted);
    }

    .attention {
      color: var(--vscode-errorForeground, var(--git-bad));
    }

    .inline-link {
      appearance: none;
      background: transparent;
      border: 0;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      display: inline;
      font: inherit;
      min-height: 0;
      padding: 0;
      text-decoration: none;
    }

    .inline-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }

    .readme-link {
      appearance: none;
      background: transparent;
      border: 0;
      color: var(--fg);
      cursor: pointer;
      display: inline;
      font: inherit;
      min-height: 0;
      padding: 0;
      text-align: left;
      text-decoration: none;
    }

    .readme-link:hover {
      text-decoration: underline;
    }

    .readme-link.attention,
    .inline-link.attention {
      color: var(--vscode-errorForeground, var(--git-bad));
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      padding: 24px;
      text-align: center;
      margin-bottom: 12px;
    }

    .add-card {
      align-items: center;
      border: 1px dashed var(--border);
      display: flex;
      justify-content: center;
      min-height: 120px;
    }

    .table-wrap {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: auto;
    }

    table {
      border-collapse: collapse;
      min-width: 980px;
      width: 100%;
    }

    th,
    td {
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }

    th {
      background: var(--card);
      color: var(--muted);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 1;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    tr.is-selected td {
      background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
    }

    .table-name {
      flex: 1 1 auto;
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .table-project-title {
      align-items: baseline;
      display: flex;
      flex-wrap: nowrap;
      gap: 6px 10px;
      min-width: 220px;
    }

    .table-actions {
      white-space: nowrap;
    }

    .git-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .git-segment {
      border: 1px solid var(--border);
      border-radius: 999px;
      display: inline-flex;
      font-size: 11px;
      line-height: 1.2;
      max-width: 100%;
      padding: 2px 7px;
    }

    .git-segment.good {
      border-color: color-mix(in srgb, var(--git-good) 60%, var(--border));
      color: var(--git-good);
    }

    .git-segment.bad {
      border-color: color-mix(in srgb, var(--git-bad) 60%, var(--border));
      color: var(--git-bad);
    }

    .suggestion-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .suggestion-row {
      align-items: center;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      padding: 10px 14px;
    }

    .suggestion-info {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .suggestion-name {
      font-weight: 600;
    }

    .suggestion-meta {
      color: var(--muted);
      font-size: 12px;
    }

    button.is-loading {
      cursor: default;
      opacity: 0.6;
    }

    .loading-dots {
      display: inline-flex;
      gap: 3px;
      margin-left: 6px;
    }

    .loading-dots span {
      background: currentColor;
      border-radius: 50%;
      width: 4px;
      height: 4px;
      animation: pm-loading-bounce 1s infinite ease-in-out;
    }

    .loading-dots span:nth-child(2) {
      animation-delay: 0.15s;
    }

    .loading-dots span:nth-child(3) {
      animation-delay: 0.3s;
    }

    @keyframes pm-loading-bounce {
      0%, 80%, 100% {
        opacity: 0.25;
        transform: scale(0.8);
      }
      40% {
        opacity: 1;
        transform: scale(1);
      }
    }

    @media (max-width: 720px) {
      .shell {
        width: min(100vw - 24px, 1280px);
      }

      header {
        align-items: stretch;
        flex-direction: column;
      }

      .header-actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div id="find-widget" class="find-widget hidden" role="search">
    <div class="find-part">
      <input type="text" id="find-input" class="find-input" placeholder="Find" aria-label="Find">
      <div class="find-toggles">
        <button type="button" class="find-toggle" id="find-case" title="Match Case (Alt+C)" aria-label="Match Case" aria-pressed="false">Aa</button>
        <button type="button" class="find-toggle" id="find-word" title="Match Whole Word (Alt+W)" aria-label="Match Whole Word" aria-pressed="false">ab</button>
        <button type="button" class="find-toggle" id="find-regex" title="Use Regular Expression (Alt+R)" aria-label="Use Regular Expression" aria-pressed="false">.*</button>
      </div>
      <span class="find-count" id="find-count"></span>
      <button type="button" class="find-nav" id="find-prev" title="Previous Match (Shift+Enter)" aria-label="Previous Match">&#8593;</button>
      <button type="button" class="find-nav" id="find-next" title="Next Match (Enter)" aria-label="Next Match">&#8595;</button>
      <button type="button" class="find-nav find-close" id="find-close" title="Close (Escape)" aria-label="Close">&#10005;</button>
    </div>
  </div>
  <main class="shell">
    <header>
      <div>
        <h1>Project Monitor</h1>
        <div class="summary"><span id="selection-summary">0 selected.</span> <span class="tracked-count" title="${escapeAttr(statusTooltip)}">${projects.length} tracked</span>. <span id="refresh-countdown" data-next-refresh-at="${nextRefreshAt}">Refreshing in ${Math.max(1, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s</span>.</div>
      </div>
      <div class="header-actions">
        <input type="search" id="project-search" class="search-input" placeholder="Search projects..." aria-label="Search projects by name">
        <button data-command="refresh">Refresh</button>
        <button class="secondary" data-command="copyContext" disabled>Copy Context</button>
        <button class="danger" data-command="removeSelected" disabled>Remove Selected</button>
      </div>
    </header>
    <nav class="tabs">
      <button class="tab active" data-tab="projects-view">Projects (${projects.length})</button>
      <button class="tab" data-tab="suggestions-view">Suggestions</button>
    </nav>
    <section id="projects-view" class="view">
      <div class="project-toolbar">
        <div class="toolbar-group">
          <label for="parent-filter">Parent</label>
          <select id="parent-filter">
            <option value="">All parent folders</option>
            ${parentFolders.map((folder) => `<option value="${escapeAttr(folder)}">${escapeHtml(folder)}</option>`).join("")}
          </select>
        </div>
        <div class="toolbar-group" role="group" aria-label="Project view">
          <button class="view-mode active" data-view-mode="cards">Cards</button>
          <button class="view-mode" data-view-mode="table">Table</button>
        </div>
      </div>
      ${projects.length === 0 ? `<div class="empty">No projects tracked yet. Use Add Project to get started.</div>` : ""}
      <section class="grid mode-view" data-mode-panel="cards">
        ${projects.map(renderProjectCard).join("")}
        <article class="card add-card">
          <button data-command="addProject">+ Add Project</button>
        </article>
      </section>
      <section class="table-wrap mode-view hidden" data-mode-panel="table">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Kind</th>
              <th>Ports</th>
              <th>Service</th>
              <th>Git</th>
              <th>TODO</th>
              <th>README</th>
              <th>LICENSE</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            ${projects.map(renderProjectRow).join("")}
          </tbody>
        </table>
      </section>
    </section>
    <section id="suggestions-view" class="view hidden">
      ${
        suggestions.length === 0
          ? `<div class="empty">No suggestions right now.</div>`
          : `<div class="suggestion-list">${suggestions.map(renderSuggestionRow).join("")}</div>`
      }
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const loadingCommands = new Set(["refresh", "removeSelected", "addProject", "addSuggestion", "copyContext"]);
    const persistedState = vscode.getState() || {};
    const selectedPaths = new Set(persistedState.selectedPaths || []);
    const pendingOperations = new Map(persistedState.pendingOperations || []);
    const refreshCountdown = document.getElementById("refresh-countdown");
    const nextRefreshAt = Number(refreshCountdown?.dataset.nextRefreshAt || 0);

    function showLoading(button) {
      if (button.classList.contains("is-loading")) {
        return;
      }
      button.disabled = true;
      button.classList.add("is-loading");
      button.insertAdjacentHTML("beforeend", '<span class="loading-dots"><span></span><span></span><span></span></span>');
    }

    function hideLoading(button) {
      button.disabled = false;
      button.classList.remove("is-loading");
      button.querySelector(".loading-dots")?.remove();
    }

    function persistState(extra = {}) {
      vscode.setState({
        activeTab: (vscode.getState() || {}).activeTab || "projects-view",
        parentFilter: document.getElementById("parent-filter")?.value || "",
        searchQuery: document.getElementById("project-search")?.value || "",
        projectViewMode: document.querySelector(".view-mode.active")?.dataset.viewMode || "cards",
        selectedPaths: [...selectedPaths],
        pendingOperations: [...pendingOperations],
        ...extra
      });
    }

    function applyFilters() {
      const parentFilter = document.getElementById("parent-filter")?.value || "";
      const searchQuery = (document.getElementById("project-search")?.value || "").trim().toLowerCase();
      for (const element of document.querySelectorAll("[data-project-path]")) {
        const isAddCard = element.classList.contains("add-card");
        const matchesParent = isAddCard || parentFilter === "" || element.dataset.parentPath === parentFilter;
        const matchesSearch = isAddCard || searchQuery === "" || (element.dataset.projectName || "").includes(searchQuery);
        element.classList.toggle("is-filtered", !(matchesParent && matchesSearch));
      }
      persistState();
      updateSelectionUi();
    }

    function showProjectMode(mode) {
      for (const button of document.querySelectorAll("[data-view-mode]")) {
        button.classList.toggle("active", button.dataset.viewMode === mode);
      }
      for (const panel of document.querySelectorAll("[data-mode-panel]")) {
        panel.classList.toggle("hidden", panel.dataset.modePanel !== mode);
      }
      persistState({ projectViewMode: mode });
    }

    function updateSelectionUi() {
      const visibleProjectPaths = new Set([...document.querySelectorAll("[data-project-path]:not(.is-filtered)")].map((card) => card.dataset.projectPath));
      let prunedSelection = false;
      for (const selectedPath of [...selectedPaths]) {
        if (!visibleProjectPaths.has(selectedPath)) {
          selectedPaths.delete(selectedPath);
          prunedSelection = true;
        }
      }
      if (prunedSelection) {
        persistState();
      }

      for (const projectElement of document.querySelectorAll("[data-project-path]")) {
        projectElement.classList.toggle("is-selected", selectedPaths.has(projectElement.dataset.projectPath));
      }

      const selectedCount = selectedPaths.size;
      const summary = document.getElementById("selection-summary");
      if (summary) {
        summary.textContent = selectedCount + " selected.";
      }

      for (const button of document.querySelectorAll('[data-command="removeSelected"], [data-command="copyContext"]')) {
        button.disabled = selectedCount === 0;
      }
    }

    function completeOperation(requestId) {
      const selector = '[data-request-id="' + requestId + '"]';
      for (const button of document.querySelectorAll(selector)) {
        hideLoading(button);
      }
      pendingOperations.delete(requestId);
      persistState();
      updateSelectionUi();
    }

    function updateRefreshCountdown() {
      if (!refreshCountdown || !nextRefreshAt) {
        return;
      }

      const remainingMs = nextRefreshAt - Date.now();
      if (remainingMs <= 0) {
        refreshCountdown.textContent = "Refreshing...";
        return;
      }

      refreshCountdown.textContent = "Refreshing in " + Math.ceil(remainingMs / 1000) + "s";
    }

    function showTab(tabId) {
      for (const tab of document.querySelectorAll(".tab")) {
        tab.classList.toggle("active", tab.dataset.tab === tabId);
      }
      for (const view of document.querySelectorAll(".view")) {
        view.classList.toggle("hidden", view.id !== tabId);
      }
      vscode.postMessage({
        command: "activeTabChanged",
        tab: tabId
      });
    }

    showTab(persistedState.activeTab || "projects-view");
    showProjectMode(persistedState.projectViewMode || "cards");
    const parentFilter = document.getElementById("parent-filter");
    if (parentFilter) {
      parentFilter.value = persistedState.parentFilter || "";
    }
    const projectSearch = document.getElementById("project-search");
    if (projectSearch) {
      projectSearch.value = persistedState.searchQuery || "";
    }
    applyFilters();
    updateSelectionUi();
    updateRefreshCountdown();
    if (refreshCountdown && nextRefreshAt) {
      setInterval(updateRefreshCountdown, 1000);
    }

    for (const [requestId, command] of pendingOperations) {
      const button = document.querySelector('[data-command="' + command + '"]');
      if (button) {
        button.dataset.requestId = requestId;
        showLoading(button);
      }
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.command === "operationComplete" && message.requestId) {
        completeOperation(message.requestId);
      }
    });

    const findWidget = document.getElementById("find-widget");
    const findInput = document.getElementById("find-input");
    const findCount = document.getElementById("find-count");
    const findOptions = { caseSensitive: false, wholeWord: false, regex: false };
    let findMatches = [];
    let currentMatchIndex = -1;

    const BACKSLASH = String.fromCharCode(92);
    const REGEX_SPECIAL_CHARS = ".*+?^" + "$" + "{}()|[]" + BACKSLASH;

    function escapeRegExp(value) {
      let result = "";
      for (const ch of value) {
        result += REGEX_SPECIAL_CHARS.indexOf(ch) === -1 ? ch : BACKSLASH + ch;
      }
      return result;
    }

    function buildFindMatcher(query) {
      if (!query) {
        return null;
      }
      let source = findOptions.regex ? query : escapeRegExp(query);
      if (findOptions.wholeWord) {
        source = BACKSLASH + "b(?:" + source + ")" + BACKSLASH + "b";
      }
      try {
        return new RegExp(source, "g" + (findOptions.caseSensitive ? "" : "i"));
      } catch {
        return null;
      }
    }

    function collectFindTextNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent || parent.closest("#find-widget, script, style")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest(".view.hidden, .mode-view.hidden, .is-filtered")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      let current;
      while ((current = walker.nextNode())) {
        nodes.push(current);
      }
      return nodes;
    }

    function clearFindHighlights() {
      const parents = new Set();
      for (const mark of document.querySelectorAll("mark.find-match")) {
        const parent = mark.parentNode;
        if (!parent) {
          continue;
        }
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parents.add(parent);
      }
      for (const parent of parents) {
        parent.normalize();
      }
      findMatches = [];
      currentMatchIndex = -1;
    }

    function updateFindCount() {
      if (!findCount || !findInput) {
        return;
      }
      if (!findInput.value) {
        findCount.textContent = "";
      } else if (findMatches.length === 0) {
        findCount.textContent = "No results";
      } else {
        findCount.textContent = (currentMatchIndex + 1) + " of " + findMatches.length;
      }
    }

    function updateActiveFindMatch() {
      for (const mark of findMatches) {
        mark.classList.remove("current");
      }
      const active = findMatches[currentMatchIndex];
      if (active) {
        active.classList.add("current");
        active.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    function runFind() {
      clearFindHighlights();
      const query = findInput?.value || "";
      const matcher = buildFindMatcher(query);
      if (matcher) {
        for (const node of collectFindTextNodes(document.querySelector(".shell"))) {
          const text = node.nodeValue;
          matcher.lastIndex = 0;
          let match;
          let lastIndex = 0;
          let found = false;
          const frag = document.createDocumentFragment();
          while ((match = matcher.exec(text))) {
            if (match[0].length === 0) {
              matcher.lastIndex += 1;
              continue;
            }
            found = true;
            if (match.index > lastIndex) {
              frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            const markEl = document.createElement("mark");
            markEl.className = "find-match";
            markEl.textContent = match[0];
            frag.appendChild(markEl);
            findMatches.push(markEl);
            lastIndex = match.index + match[0].length;
          }
          if (found) {
            if (lastIndex < text.length) {
              frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            }
            node.parentNode.replaceChild(frag, node);
          }
        }
      }
      currentMatchIndex = findMatches.length > 0 ? 0 : -1;
      updateActiveFindMatch();
      updateFindCount();
    }

    function goToFindMatch(delta) {
      if (findMatches.length === 0) {
        return;
      }
      currentMatchIndex = (currentMatchIndex + delta + findMatches.length) % findMatches.length;
      updateActiveFindMatch();
      updateFindCount();
    }

    function toggleFindOption(key, button) {
      findOptions[key] = !findOptions[key];
      button.classList.toggle("active", findOptions[key]);
      button.setAttribute("aria-pressed", String(findOptions[key]));
      runFind();
    }

    function openFindWidget() {
      if (!findWidget || !findInput) {
        return;
      }
      findWidget.classList.remove("hidden");
      findInput.focus();
      findInput.select();
      if (findInput.value) {
        runFind();
      }
    }

    function closeFindWidget() {
      if (!findWidget) {
        return;
      }
      findWidget.classList.add("hidden");
      clearFindHighlights();
      updateFindCount();
    }

    findInput?.addEventListener("input", runFind);
    findInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToFindMatch(event.shiftKey ? -1 : 1);
      }
    });
    document.getElementById("find-close")?.addEventListener("click", closeFindWidget);
    document.getElementById("find-next")?.addEventListener("click", () => goToFindMatch(1));
    document.getElementById("find-prev")?.addEventListener("click", () => goToFindMatch(-1));
    document.getElementById("find-case")?.addEventListener("click", (event) => toggleFindOption("caseSensitive", event.currentTarget));
    document.getElementById("find-word")?.addEventListener("click", (event) => toggleFindOption("wholeWord", event.currentTarget));
    document.getElementById("find-regex")?.addEventListener("click", (event) => toggleFindOption("regex", event.currentTarget));

    document.addEventListener("keydown", (event) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f";
      if (isFindShortcut) {
        event.preventDefault();
        openFindWidget();
        return;
      }

      const widgetOpen = findWidget && !findWidget.classList.contains("hidden");
      if (!widgetOpen) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeFindWidget();
        return;
      }

      if (event.altKey && document.activeElement && findWidget.contains(document.activeElement)) {
        const key = event.key.toLowerCase();
        if (key === "c") {
          event.preventDefault();
          toggleFindOption("caseSensitive", document.getElementById("find-case"));
        } else if (key === "w") {
          event.preventDefault();
          toggleFindOption("wholeWord", document.getElementById("find-word"));
        } else if (key === "r") {
          event.preventDefault();
          toggleFindOption("regex", document.getElementById("find-regex"));
        }
      }
    });

    document.addEventListener("click", (event) => {
      const tabButton = event.target.closest("button[data-tab]");
      if (tabButton) {
        persistState({ activeTab: tabButton.dataset.tab });
        showTab(tabButton.dataset.tab);
        return;
      }

      const viewModeButton = event.target.closest("button[data-view-mode]");
      if (viewModeButton) {
        showProjectMode(viewModeButton.dataset.viewMode);
        return;
      }

      const projectCard = event.target.closest("[data-project-path]");
      const commandElement = event.target.closest("[data-command]");
      if (projectCard && !commandElement && !event.target.closest("a, button")) {
        const projectPath = projectCard.dataset.projectPath;
        if (selectedPaths.has(projectPath)) {
          selectedPaths.delete(projectPath);
        } else {
          selectedPaths.add(projectPath);
        }
        persistState();
        updateSelectionUi();
        return;
      }

      if (!commandElement) {
        return;
      }

      event.preventDefault();

      const command = commandElement.dataset.command;
      const selected = [...selectedPaths];
      if ((command === "removeSelected" || command === "copyContext") && selected.length === 0) {
        return;
      }

      const requestId = command + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      if (loadingCommands.has(commandElement.dataset.command)) {
        commandElement.dataset.requestId = requestId;
        pendingOperations.set(requestId, command);
        persistState();
        showLoading(commandElement);
      }

      vscode.postMessage({
        command,
        path: commandElement.dataset.path,
        paths: selected,
        requestId,
        text: commandElement.dataset.text,
        url: commandElement.dataset.url
      });
    });

    document.addEventListener("input", (event) => {
      if (event.target.id === "project-search") {
        applyFilters();
      }
    });

    document.addEventListener("change", (event) => {
      if (event.target.id === "parent-filter") {
        applyFilters();
      }
    });
  </script>
</body>
</html>`;
}

function createStatusTooltip(projects: Project[]): string {
  const counts = countProjectStatuses(projects);
  return [
    `${counts.running} running`,
    `${counts.serving} serving`,
    `${counts.installed} installed`,
    `${counts.stale} stale`,
    `${counts.stopped} stopped`,
    `${counts.unknown} unknown`
  ].join("\n");
}

function countProjectStatuses(projects: Project[]): Record<Project["status"], number> {
  const counts: Record<Project["status"], number> = {
    running: 0,
    serving: 0,
    installed: 0,
    stale: 0,
    stopped: 0,
    unknown: 0
  };
  for (const project of projects) {
    counts[project.status] += 1;
  }
  return counts;
}

function renderProjectCard(project: Project): string {
  return `<article class="card" data-project-path="${escapeAttr(project.path)}" data-parent-path="${escapeAttr(path.dirname(project.path))}" data-project-name="${escapeAttr(getProjectDisplayName(project).toLowerCase())}">
    <div class="card-top">
      <div class="card-heading">
        <div class="project-title-row">
          ${renderProjectTitle(project, "h2")}
        </div>
        ${renderProjectActions(project)}
        <div class="path"><button class="path-button" data-command="openFolder" data-path="${escapeAttr(project.path)}">${escapeHtml(project.path)}</button></div>
      </div>
      ${renderStatusBadge(project.status)}
    </div>
    <dl>
      <dt>Kind</dt>
      <dd>${escapeHtml(project.kind)}</dd>
      <dt>Git</dt>
      <dd>${renderGitSummary(project.git)}</dd>
      <dt>TODO</dt>
      <dd>${renderTodoSummary(project.todo, project.path)}</dd>
      <dt>README</dt>
      <dd>${renderReadmeSummary(project.readme)}</dd>
      <dt>LICENSE</dt>
      <dd>${renderLicenseSummary(project.license)}</dd>
      ${renderPortOrVersionDefinition(project)}
      ${project.kind === "vsce" || project.kind === "static" ? "" : `<dt>Service</dt><dd>${renderServiceSummary(project.service)}</dd>`}
      ${
        project.publishedRoutes.length > 0
          ? `<dt>Published</dt><dd>${project.publishedRoutes
              .map(
                (route) =>
                  `<button class="inline-link" data-command="openUrl" data-url="${escapeAttr(route.url)}">${escapeHtml(route.url)}</button>`
              )
              .join(", ")}</dd>`
          : ""
      }
    </dl>
  </article>`;
}

function renderProjectRow(project: Project): string {
  return `<tr data-project-path="${escapeAttr(project.path)}" data-parent-path="${escapeAttr(path.dirname(project.path))}" data-project-name="${escapeAttr(getProjectDisplayName(project).toLowerCase())}">
    <td><div class="table-project-title">${renderProjectTitle(project, "div")}${renderProjectActions(project)}</div></td>
    <td>${renderStatusBadge(project.status)}</td>
    <td>${escapeHtml(project.kind)}</td>
    <td>${renderPortOrVersionCell(project)}</td>
    <td>${project.kind === "vsce" || project.kind === "static" ? `<span class="muted-status">n/a</span>` : renderServiceSummary(project.service)}</td>
    <td>${renderGitSummary(project.git)}</td>
    <td>${renderTodoSummary(project.todo, project.path)}</td>
    <td>${renderReadmeSummary(project.readme)}</td>
    <td>${renderLicenseSummary(project.license)}</td>
    <td><div class="path"><button class="path-button" data-command="openFolder" data-path="${escapeAttr(project.path)}">${escapeHtml(project.path)}</button></div></td>
  </tr>`;
}

function renderProjectActions(project: Project): string {
  const projectPath = escapeAttr(project.path);
  return `<span class="project-actions">
    <button class="text-action" data-command="openTerminal" data-path="${projectPath}">terminal</button>
    <button class="text-action" data-command="openAgent" data-path="${projectPath}">codex</button>
    <button class="text-action" data-command="openClaudeAgent" data-path="${projectPath}">claude</button>
  </span>`;
}

function getProjectDisplayName(project: Project): string {
  return project.readme.heading?.trim() || project.name;
}

function renderProjectTitle(project: Project, tagName: "h2" | "div"): string {
  const folderName = project.name;
  const readmeName = project.readme.heading?.trim();
  const displayName = getProjectDisplayName(project);
  const hasReadmeName = readmeName !== undefined && readmeName.length > 0;
  const hasMismatch = hasReadmeName && normalizeProjectName(readmeName) !== normalizeProjectName(folderName);
  const needsReadmeName = !hasReadmeName;
  const className = `${tagName === "h2" ? "" : "table-name"}${hasMismatch || needsReadmeName ? " title-mismatch" : ""}`.trim();
  const tooltip = needsReadmeName ? "README has no title" : hasMismatch ? `README: ${readmeName}\nFolder: ${folderName}` : displayName;
  return `<${tagName}${className ? ` class="${escapeAttr(className)}"` : ""} title="${escapeAttr(tooltip)}">${escapeHtml(displayName)}</${tagName}>`;
}

function renderReadmeSummary(readme: ReadmeSummary): string {
  if (!readme.exists || !readme.path) {
    return `<span class="attention">No README</span>`;
  }

  const description = readme.description || readme.section || "README";
  const section = readme.section || description;
  return `<button class="readme-link${readme.description ? "" : " attention"}" data-command="openFile" data-path="${escapeAttr(readme.path)}" title="${escapeAttr(section)}">${escapeHtml(truncateText(description, 150))}</button>`;
}

function renderLicenseSummary(license: LicenseSummary): string {
  if (!license.exists || !license.path) {
    return `<span class="attention">No LICENSE</span>`;
  }
  const className = license.hasContent ? "readme-link" : "readme-link attention";
  return `<button class="${className}" data-command="openFile" data-path="${escapeAttr(license.path)}" title="${escapeAttr(license.path)}">${escapeHtml(license.label || "LICENSE")}</button>`;
}

function renderPortOrVersionDefinition(project: Project): string {
  if (project.kind === "vsce") {
    return `<dt>Version</dt><dd>${renderVscodeExtensionVersion(project)}</dd>`;
  }

  if (project.kind === "static") {
    return "";
  }

  return `<dt>Ports</dt><dd>${renderPorts(project)}</dd>`;
}

function renderPortOrVersionCell(project: Project): string {
  if (project.kind === "vsce") {
    return renderVscodeExtensionVersion(project);
  }

  if (project.kind === "static") {
    return `<span class="muted-status">n/a</span>`;
  }

  return renderPorts(project);
}

function renderPorts(project: Project): string {
  if (project.ports.length > 0) {
    return project.ports
      .map((port) => {
        const url = `http://localhost:${port}`;
        return `<button class="inline-link" data-command="openUrl" data-url="${escapeAttr(url)}">${port}</button>`;
      })
      .join(", ");
  }

  if (projectNeedsServing(project)) {
    return `<span class="attention">No ports</span>`;
  }

  return `<span class="muted-status">None</span>`;
}

function renderVscodeExtensionVersion(project: Project): string {
  const extension = project.vscodeExtension;
  const installed = extension?.installedVersion ?? "not installed";
  const latest = extension?.latestVersion ?? "unknown";
  const isCurrent = extension?.installedVersion !== undefined && extension.installedVersion === extension.latestVersion;
  const label = `${installed} / ${latest}`;
  const className = isCurrent ? "readme-link" : "readme-link attention";
  if (extension?.packagePath) {
    return `<button class="${className}" data-command="openFolder" data-path="${escapeAttr(extension.packagePath)}" title="${escapeAttr(extension.packagePath)}">${escapeHtml(label)}</button>`;
  }
  return `<span class="${isCurrent ? "" : "attention"}">${escapeHtml(label)}</span>`;
}

function renderServiceSummary(service: ServiceSummary | undefined): string {
  if (!service) {
    return `<span class="muted-status">None</span>`;
  }

  if (service.projectSymlinkPath) {
    return `<button class="readme-link" data-command="openFile" data-path="${escapeAttr(service.projectSymlinkPath)}" title="${escapeAttr(service.systemPath ?? service.projectSymlinkPath)}">${escapeHtml(service.name ?? path.basename(service.projectSymlinkPath))}</button>`;
  }

  if (service.copyCommand) {
    return `<button class="readme-link attention" data-command="copyText" data-text="${escapeAttr(service.copyCommand)}" title="${escapeAttr(service.copyCommand)}">${escapeHtml(service.name ?? "Missing service symlink")}</button>`;
  }

  return `<span class="muted-status">${escapeHtml(service.name ?? "Service")}</span>`;
}

function renderStatusBadge(status: Project["status"]): string {
  if (status === "stale") {
    return `<button class="badge stale" data-command="reloadWindow" title="Reload the VS Code window to activate the installed extension">Stale</button>`;
  }
  return `<span class="badge ${status}">${escapeHtml(status)}</span>`;
}

function renderGitSummary(git: GitStatus): string {
  if (!git.hasGit) {
    return `<div class="git-summary"><span class="git-segment bad">No git</span></div>`;
  }

  const segments: string[] = [];
  if (git.hasUnstagedChanges) {
    segments.push(gitSegment("unstaged", false));
  } else if (git.hasStagedChanges) {
    segments.push(gitSegment("uncommitted", false));
  } else if (!git.hasRemote) {
    segments.push(gitSegment("committed", true));
  }

  if (!git.hasRemote) {
    segments.push(gitSegment("no remote", false));
  } else if (git.synced) {
    segments.push(gitSegment("synced", true));
  } else if (!git.hasUnstagedChanges && !git.hasUntrackedChanges) {
    segments.push(gitSegment("unsynced", false));
  }

  return `<div class="git-summary">${segments.join("")}</div>`;
}

function gitSegment(label: string, isGood: boolean): string {
  return `<span class="git-segment ${isGood ? "good" : "bad"}">${escapeHtml(label)}</span>`;
}

function emptyGitStatus(): GitStatus {
  return {
    hasGit: false,
    hasRemote: false,
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedChanges: false,
    allChangesStaged: false,
    committed: false,
    hasUnpushedCommits: false,
    hasUnpulledCommits: false,
    synced: false,
    label: "No git"
  };
}

function renderTodoSummary(todo: TodoSummary, projectPath: string): string {
  if (!todo.exists) {
    return `<span class="attention">No TODO</span>`;
  }
  const todoPath = path.join(projectPath, "TODO.md");
  if (todo.total === 0) {
    return `<a class="inline-link" href="#" data-command="openFile" data-path="${escapeAttr(todoPath)}">0 checklist items</a>`;
  }
  return `<a class="inline-link" href="#" data-command="openFile" data-path="${escapeAttr(todoPath)}">${todo.completed}/${todo.total} complete</a>`;
}

function emptyTodoSummary(): TodoSummary {
  return {
    exists: false,
    completed: 0,
    total: 0
  };
}

function emptyReadmeSummary(): ReadmeSummary {
  return {
    exists: false
  };
}

function emptyLicenseSummary(): LicenseSummary {
  return {
    exists: false
  };
}

function projectNeedsServing(project: Project): boolean {
  return project.kind !== "vsce" && project.kind !== "static" && project.kind !== "unknown";
}

type CodexSessionIndexEntry = {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
};

type CodexSession = {
  id: string;
  threadName: string;
  updatedAt: number;
};

async function findCodexSession(homeDir: string, projectName: string): Promise<{ id: string } | undefined> {
  const sessionIndexPath = path.join(homeDir, ".codex", "session_index.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(sessionIndexPath, "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) {
      logError(`Unable to read Codex session index at ${sessionIndexPath}.`, error);
    }
    return undefined;
  }

  const normalizedProjectName = normalizeSessionName(projectName);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseCodexSessionLine(line, sessionIndexPath))
    .filter((session): session is CodexSession => session !== undefined)
    .filter((session) => normalizeSessionName(session.threadName) === normalizedProjectName)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function parseCodexSessionLine(line: string, sessionIndexPath: string): CodexSession | undefined {
  try {
    const parsed = JSON.parse(line) as CodexSessionIndexEntry;
    if (typeof parsed.id !== "string" || typeof parsed.thread_name !== "string") {
      return undefined;
    }
    const updatedAt = typeof parsed.updated_at === "string" ? Date.parse(parsed.updated_at) : 0;
    return {
      id: parsed.id,
      threadName: parsed.thread_name,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
    };
  } catch (error) {
    logError(`Unable to parse Codex session index line in ${sessionIndexPath}.`, error);
    return undefined;
  }
}

function toProperProjectName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSessionName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProjectName(value: string): string {
  return value.trim().replace(/[-_\s]+/g, " ").toLowerCase();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function renderSuggestionRow(suggestion: Suggestion): string {
  return `<div class="suggestion-row">
    <div class="suggestion-info">
      <div class="suggestion-name">${escapeHtml(suggestion.name)}</div>
      <div class="suggestion-meta">${escapeHtml(suggestion.path)}</div>
      <div class="suggestion-meta">${escapeHtml(suggestion.reason)}</div>
    </div>
    <button data-command="addSuggestion" data-path="${escapeAttr(suggestion.path)}">Add</button>
  </div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
