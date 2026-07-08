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
}

export function deactivate(): void {
  logInfo("Project Monitor extension deactivated.");
}
