import * as vscode from "vscode";
import { readConfig, type ProjectMonitorConfig } from "./config";
import { Dashboard, dashboardViewType } from "./dashboard";
import { logInfo } from "./log";

let config: ProjectMonitorConfig;

export function activate(context: vscode.ExtensionContext): void {
  config = readConfig();
  const dashboard = new Dashboard(context, () => config);

  context.subscriptions.push(
    dashboard,
    vscode.window.registerWebviewPanelSerializer(dashboardViewType, {
      async deserializeWebviewPanel(panel) {
        dashboard.restore(panel);
        logInfo("Restored existing dashboard webview panel.");
      }
    }),
    vscode.commands.registerCommand("projectMonitor.openDashboard", () => dashboard.open()),
    vscode.commands.registerCommand("projectMonitor.refresh", () => dashboard.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("projectMonitor")) {
        config = readConfig();
        dashboard.restartTimer();
        void dashboard.refresh();
      }
    })
  );

  if (config.openOnStartup) {
    setTimeout(() => {
      if (!dashboard.hasPanel() && !hasExistingDashboardTab()) {
        dashboard.open(config.pinOnStartup);
      }
    }, 1000);
  }
}

export function deactivate(): void {
  logInfo("Project Monitor extension deactivated.");
}

function hasExistingDashboardTab(): boolean {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .some((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(dashboardViewType));
}
