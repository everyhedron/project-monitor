import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;
const seenWarnings = new Set<string>();

function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Project Monitor");
  return channel;
}

export function logInfo(message: string): void {
  output().appendLine(`${timestamp()} INFO ${message}`);
}

export function logWarning(message: string, error?: unknown): void {
  output().appendLine(`${timestamp()} WARN ${message}${formatError(error)}`);
}

export function logWarningOnce(key: string, message: string, error?: unknown): void {
  if (seenWarnings.has(key)) {
    return;
  }
  seenWarnings.add(key);
  logWarning(message, error);
}

export function logError(message: string, error?: unknown): void {
  output().appendLine(`${timestamp()} ERROR ${message}${formatError(error)}`);
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  if (error === undefined) {
    return "";
  }
  if (error instanceof Error) {
    return `\n${error.stack ?? error.message}`;
  }
  return `\n${String(error)}`;
}
