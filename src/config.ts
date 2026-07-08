import * as fs from "fs/promises";
import * as vscode from "vscode";
import { logWarningOnce } from "./log";

export type ProjectMonitorConfig = {
  projects: string[];
  refreshIntervalMs: number;
};

export function readConfig(): ProjectMonitorConfig {
  const config = vscode.workspace.getConfiguration("projectMonitor");
  return {
    projects: uniqueStrings(config.get<string[]>("projects", [])).map(normalizePath),
    refreshIntervalMs: Math.max(10000, config.get<number>("refreshIntervalMs", 30000))
  };
}

export async function addProjects(paths: string[]): Promise<void> {
  const canonical = await Promise.all(paths.map(canonicalize));
  const current = readConfig().projects;
  const merged = uniqueStrings([...current, ...canonical]).map(normalizePath);
  await writeProjects(merged);
}

export async function removeProject(targetPath: string): Promise<void> {
  const canonicalTarget = normalizePath(await canonicalize(targetPath));
  const remaining = readConfig().projects.filter((path) => path !== canonicalTarget);
  await writeProjects(remaining);
}

export async function removeProjects(targetPaths: string[]): Promise<void> {
  const canonicalTargets = new Set((await Promise.all(targetPaths.map(canonicalize))).map(normalizePath));
  const remaining = readConfig().projects.filter((path) => !canonicalTargets.has(path));
  await writeProjects(remaining);
}

async function writeProjects(projects: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration("projectMonitor");
  await config.update("projects", projects, vscode.ConfigurationTarget.Global);
}

async function canonicalize(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      logWarningOnce(`config-canonicalize:${targetPath}`, `Unable to resolve configured project path ${targetPath}.`, error);
    }
    return targetPath;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePath(value: string): string {
  return value.replace(/\/+$/, "") || "/";
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
