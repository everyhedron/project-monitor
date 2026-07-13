import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { listListeningProcesses } from "./processes";
import { joinUrlPath, readNginxRoutes, type NginxRoute } from "./nginx";
import { logWarningOnce } from "./log";
import type {
  Evidence,
  GitStatus,
  LicenseSummary,
  ListeningProcess,
  Project,
  ProjectKind,
  ReadmeSummary,
  ServiceSummary,
  Suggestion,
  TodoSummary,
  VscodeExtensionSummary
} from "./types";

const execFileAsync = promisify(execFile);

const ignoredChildNames = new Set([
  ".cache",
  ".git",
  ".nvm",
  ".npm",
  ".vscode-server",
  "lost+found",
  "node_modules"
]);

export type DiscoveryResult = {
  projects: Project[];
  suggestions: Suggestion[];
};

export type DiscoveryOptions = {
  includeSuggestions?: boolean;
};

export type InstalledExtensionInfo = {
  version?: string;
};

type MarketplaceVersionCacheEntry = {
  expiresAt: number;
  version?: string;
};

type SystemdServiceRef = {
  name: string;
  path: string;
};

const marketplaceVersionCache = new Map<string, MarketplaceVersionCacheEntry>();
const marketplaceVersionCacheMs = 10 * 60 * 1000;

export async function discoverWorkspace(
  projectPaths: string[],
  installedExtensions = new Map<string, InstalledExtensionInfo>(),
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const canonicalPaths = [...new Set(await Promise.all(projectPaths.map(canonicalize)))];
  const trackedSet = new Set(canonicalPaths);
  const [listeners, serviceRefsByProject] = await Promise.all([
    listListeningProcesses(),
    readSystemdServiceRefs(canonicalPaths)
  ]);

  const projects = await Promise.all(
    canonicalPaths.map((projectPath) =>
      buildProject(projectPath, listeners, installedExtensions, serviceRefsByProject.get(projectPath))
    )
  );
  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const nginxRoutes = await readNginxRoutes();
  const includeSuggestions = options.includeSuggestions === true;
  const [nginxSuggestions, siblingSuggestions] = await Promise.all([
    applyNginxRoutes(nginxRoutes, projects, trackedSet, listeners, includeSuggestions),
    includeSuggestions ? findSiblingSuggestions(canonicalPaths, trackedSet) : Promise.resolve([])
  ]);

  return {
    projects,
    suggestions: dedupeSuggestions([...siblingSuggestions, ...nginxSuggestions])
  };
}

async function buildProject(
  projectPath: string,
  listeners: ListeningProcess[],
  installedExtensions: Map<string, InstalledExtensionInfo>,
  systemdServiceRef: SystemdServiceRef | undefined
): Promise<Project> {
  const [detection, git, todo, readme, license, service] = await Promise.all([
    detectProject(projectPath, installedExtensions),
    readGitStatus(projectPath),
    readTodoSummary(projectPath),
    readReadmeSummary(projectPath),
    readLicenseSummary(projectPath),
    readProjectServiceSummary(projectPath, systemdServiceRef)
  ]);
  const matchedListeners = listeners.filter((listener) => listener.cwd !== undefined && isSameOrInside(listener.cwd, projectPath));
  const ports = [...new Set(matchedListeners.flatMap((listener) => listener.ports))].sort((a, b) => a - b);

  return {
    id: projectPath,
    name: path.basename(projectPath),
    path: projectPath,
    kind: detection.kind,
    status: ports.length > 0 ? "running" : detection.isInstalledVscodeExtension ? "installed" : "stopped",
    ports,
    urls: ports.map((port) => `http://localhost:${port}`),
    evidence: detection.evidence,
    suggestedCommands: detection.suggestedCommands,
    publishedRoutes: [],
    git,
    todo,
    readme,
    license,
    vscodeExtension: detection.vscodeExtension,
    service
  };
}

async function readTodoSummary(projectPath: string): Promise<TodoSummary> {
  try {
    const raw = await fs.readFile(path.join(projectPath, "TODO.md"), "utf8");
    const checkboxLines = raw.split(/\r?\n/).filter((line) => /^\s*-\s+\[[ xX]\]\s+/.test(line));
    return {
      exists: true,
      completed: checkboxLines.filter((line) => /^\s*-\s+\[[xX]\]\s+/.test(line)).length,
      total: checkboxLines.length
    };
  } catch (error) {
    if (!isMissingPathError(error)) {
      logWarningOnce(`todo:${projectPath}`, `Unable to read TODO.md for ${projectPath}.`, error);
    }
    return {
      exists: false,
      completed: 0,
      total: 0
    };
  }
}

async function readReadmeSummary(projectPath: string): Promise<ReadmeSummary> {
  const readmePath = path.join(projectPath, "README.md");
  try {
    const raw = await fs.readFile(readmePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const firstHeadingIndex = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
    if (firstHeadingIndex === -1) {
      return {
        exists: true,
        path: readmePath
      };
    }

    const nextHeadingIndex = lines.findIndex((line, index) => index > firstHeadingIndex && /^#{1,6}\s+\S/.test(line));
    const sectionLines = lines.slice(firstHeadingIndex + 1, nextHeadingIndex === -1 ? lines.length : nextHeadingIndex);
    return {
      exists: true,
      path: readmePath,
      heading: stripMarkdownInline(lines[firstHeadingIndex].replace(/^#{1,6}\s+/, "").trim()),
      description: firstParagraph(sectionLines),
      section: sectionLines.join("\n").trim()
    };
  } catch (error) {
    if (!isMissingPathError(error)) {
      logWarningOnce(`readme:${projectPath}`, `Unable to read README.md for ${projectPath}.`, error);
    }
    return {
      exists: false
    };
  }
}

async function readLicenseSummary(projectPath: string): Promise<LicenseSummary> {
  const names = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "LICENCE.txt"];
  for (const name of names) {
    const licensePath = path.join(projectPath, name);
    try {
      const raw = await fs.readFile(licensePath, "utf8");
      const firstLine = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return {
        exists: true,
        path: licensePath,
        label: firstLine ? stripMarkdownInline(firstLine) : name,
        hasContent: firstLine !== undefined
      };
    } catch (error) {
      if (!isMissingPathError(error)) {
        logWarningOnce(`license:${licensePath}`, `Unable to read license file at ${licensePath}.`, error);
      }
    }
  }

  return { exists: false };
}

async function readSystemdServiceRefs(projectPaths: string[]): Promise<Map<string, SystemdServiceRef>> {
  const serviceDir = "/etc/systemd/system";
  const refs = new Map<string, SystemdServiceRef>();
  let entries: string[];
  try {
    entries = await fs.readdir(serviceDir);
  } catch (error) {
    logWarningOnce("systemd:services", `Unable to read systemd services from ${serviceDir}.`, error);
    return refs;
  }

  const serviceFiles = entries.filter((entry) => entry.endsWith(".service"));
  await Promise.all(
    serviceFiles.map(async (entry) => {
      const servicePath = path.join(serviceDir, entry);
      let raw: string;
      try {
        raw = await fs.readFile(servicePath, "utf8");
      } catch (error) {
        logWarningOnce(`systemd:service:${servicePath}`, `Unable to read systemd service ${servicePath}.`, error);
        return;
      }

      for (const projectPath of projectPaths) {
        if (!refs.has(projectPath) && raw.includes(projectPath)) {
          refs.set(projectPath, { name: entry, path: servicePath });
        }
      }
    })
  );

  return refs;
}

async function readProjectServiceSummary(
  projectPath: string,
  systemdServiceRef: SystemdServiceRef | undefined
): Promise<ServiceSummary | undefined> {
  const serviceSymlink = await findProjectServiceSymlink(projectPath, systemdServiceRef?.name);
  if (serviceSymlink) {
    return {
      name: path.basename(serviceSymlink),
      projectSymlinkPath: serviceSymlink,
      systemPath: await safeRealpath(serviceSymlink)
    };
  }

  if (!systemdServiceRef) {
    return undefined;
  }

  return {
    name: systemdServiceRef.name,
    systemPath: systemdServiceRef.path,
    copyCommand: `ln -s ${shellQuote(systemdServiceRef.path)} ${shellQuote(path.join(projectPath, systemdServiceRef.name))}`
  };
}

async function findProjectServiceSymlink(projectPath: string, preferredName: string | undefined): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectPath);
  } catch (error) {
    logWarningOnce(`service-symlink:${projectPath}`, `Unable to scan service symlinks in ${projectPath}.`, error);
    return undefined;
  }

  const serviceNames = entries.filter((entry) => entry.endsWith(".service"));
  const orderedNames =
    preferredName && serviceNames.includes(preferredName)
      ? [preferredName, ...serviceNames.filter((entry) => entry !== preferredName)]
      : serviceNames;

  for (const entry of orderedNames) {
    const candidate = path.join(projectPath, entry);
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink()) {
        return candidate;
      }
    } catch (error) {
      logWarningOnce(`service-symlink:${candidate}`, `Unable to inspect service symlink ${candidate}.`, error);
    }
  }

  return undefined;
}

async function safeRealpath(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return undefined;
  }
}

function firstParagraph(lines: string[]): string | undefined {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }

  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  const paragraph = paragraphs.find((candidate) => candidate.length > 0);
  return paragraph ? stripMarkdownInline(paragraph) : undefined;
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readGitStatus(projectPath: string): Promise<GitStatus> {
  const fallback: GitStatus = {
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

  if (!(await hasGitMetadata(projectPath)) || !(await isInsideGitWorkTree(projectPath))) {
    return fallback;
  }

  const [statusOutput, remoteOutput, upstreamOutput] = await Promise.all([
    runGit(projectPath, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]),
    runGit(projectPath, ["remote"]),
    runGit(projectPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], false)
  ]);

  const statusLines = statusOutput.split(/\r?\n/).filter(Boolean);
  const changeLines = statusLines.filter((line) => !line.startsWith("## "));
  const branchLine = statusLines.find((line) => line.startsWith("## ")) ?? "";
  const hasStagedChanges = changeLines.some((line) => line[0] !== " " && line[0] !== "?");
  const hasUnstagedChanges = changeLines.some((line) => line[1] !== " " || line.startsWith("??"));
  const hasUntrackedChanges = changeLines.some((line) => line.startsWith("??"));
  const hasUncommittedChanges = changeLines.length > 0;
  const hasRemote = remoteOutput.trim().length > 0 || upstreamOutput.trim().length > 0;
  const aheadBehind = parseAheadBehind(branchLine);

  return {
    hasGit: true,
    hasRemote,
    hasStagedChanges,
    hasUnstagedChanges,
    hasUntrackedChanges,
    allChangesStaged: hasUncommittedChanges && hasStagedChanges && !hasUnstagedChanges && !hasUntrackedChanges,
    committed: !hasUncommittedChanges,
    hasUnpushedCommits: aheadBehind.ahead > 0,
    hasUnpulledCommits: aheadBehind.behind > 0,
    synced: hasRemote && !hasUncommittedChanges && aheadBehind.ahead === 0 && aheadBehind.behind === 0,
    label: buildGitLabel(hasRemote, hasUncommittedChanges, aheadBehind.ahead, aheadBehind.behind)
  };
}

async function hasGitMetadata(projectPath: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(projectPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isInsideGitWorkTree(projectPath: string): Promise<boolean> {
  return (await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
}

async function runGit(projectPath: string, args: string[], logFailures = true): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 1200
    });
    return stdout;
  } catch (error) {
    if (logFailures) {
      logWarningOnce(`git:${projectPath}:${args.join(" ")}`, `Git command failed in ${projectPath}: git ${args.join(" ")}`, error);
    }
    return "";
  }
}

function parseAheadBehind(branchLine: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(branchLine)?.[1];
  const behind = /behind (\d+)/.exec(branchLine)?.[1];
  return {
    ahead: ahead ? Number(ahead) : 0,
    behind: behind ? Number(behind) : 0
  };
}

function buildGitLabel(hasRemote: boolean, hasUncommittedChanges: boolean, ahead: number, behind: number): string {
  if (!hasRemote) {
    return hasUncommittedChanges ? "Local changes" : "Local repo";
  }
  return hasUncommittedChanges || ahead > 0 || behind > 0 ? "Unsynced" : "Synced";
}

async function findSiblingSuggestions(canonicalPaths: string[], trackedSet: Set<string>): Promise<Suggestion[]> {
  const trackedNamesByParent = new Map<string, string[]>();
  for (const projectPath of canonicalPaths) {
    const parent = path.dirname(projectPath);
    const names = trackedNamesByParent.get(parent) ?? [];
    names.push(path.basename(projectPath));
    trackedNamesByParent.set(parent, names);
  }

  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();

  for (const [parentDir, trackedNames] of trackedNamesByParent) {
    let children: Dirent[];
    try {
      children = await fs.readdir(parentDir, { withFileTypes: true });
    } catch (error) {
      logWarningOnce(`siblings:${parentDir}`, `Unable to scan sibling projects in ${parentDir}.`, error);
      continue;
    }

    for (const child of children) {
      if (ignoredChildNames.has(child.name)) {
        continue;
      }

      const fullPath = path.join(parentDir, child.name);
      if (!(await isDirectoryEntry(child, fullPath))) {
        continue;
      }

      const canonicalPath = await canonicalize(fullPath);
      if (trackedSet.has(canonicalPath) || seen.has(canonicalPath)) {
        continue;
      }

      seen.add(canonicalPath);
      suggestions.push({
        path: canonicalPath,
        name: path.basename(canonicalPath),
        reason: `Sibling of ${trackedNames[0]}`
      });
    }
  }

  return suggestions;
}

async function applyNginxRoutes(
  routes: NginxRoute[],
  projects: Project[],
  trackedSet: Set<string>,
  listeners: ListeningProcess[],
  includeSuggestions: boolean
): Promise<Suggestion[]> {
  const projectByPath = new Map(projects.map((project) => [project.path, project]));
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();

  for (const route of routes) {
    if (route.kind === "static") {
      await applyStaticRoute(route, projectByPath, trackedSet, suggestions, seen, includeSuggestions);
      continue;
    }

    const url = joinUrlPath(route.domain, route.locationPath);
    const owner = projects.find((project) => project.ports.includes(route.port));
    if (owner) {
      addPublishedRoute(owner, route.domain, url);
      continue;
    }

    const listener = listeners.find((candidate) => candidate.cwd && candidate.ports.includes(route.port));
    if (!listener?.cwd) {
      continue;
    }

    const cwd = await canonicalize(listener.cwd);
    if (includeSuggestions && !trackedSet.has(cwd) && !seen.has(cwd)) {
      seen.add(cwd);
      suggestions.push({ path: cwd, name: path.basename(cwd), reason: `Published at ${url}` });
    }
  }

  return suggestions;
}

async function applyStaticRoute(
  route: NginxRoute & { kind: "static" },
  projectByPath: Map<string, Project>,
  trackedSet: Set<string>,
  suggestions: Suggestion[],
  seen: Set<string>,
  includeSuggestions: boolean
): Promise<void> {
  let resolvedDir: string;
  let entries: Dirent[];
  try {
    resolvedDir = await fs.realpath(route.fsPath);
    entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  } catch (error) {
    logWarningOnce(`static-route:${route.fsPath}`, `Unable to inspect nginx static route ${route.fsPath}.`, error);
    return;
  }

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }

    const symlinkPath = path.join(resolvedDir, entry.name);
    const target = await canonicalize(symlinkPath);
    if (target === symlinkPath) {
      logWarningOnce(`static-route-symlink:${symlinkPath}`, `Unable to resolve nginx static symlink ${symlinkPath}.`);
      continue;
    }
    const url = joinUrlPath(route.domain, route.locationPath, entry.name);

    const project = projectByPath.get(target);
    if (project) {
      addPublishedRoute(project, route.domain, url);
      if (project.ports.length === 0) {
        project.status = "serving";
      }
      continue;
    }

    if (includeSuggestions && !trackedSet.has(target) && !seen.has(target)) {
      seen.add(target);
      suggestions.push({ path: target, name: path.basename(target), reason: `Published at ${url}` });
    }
  }
}

function addPublishedRoute(project: Project, domain: string, url: string): void {
  if (!project.publishedRoutes.some((route) => route.url === url)) {
    project.publishedRoutes.push({ domain, url });
  }
}

function dedupeSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return suggestions
    .filter((suggestion) => {
      if (seen.has(suggestion.path)) {
        return false;
      }
      seen.add(suggestion.path);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function isDirectoryEntry(dirent: Dirent, fullPath: string): Promise<boolean> {
  if (dirent.isDirectory()) {
    return true;
  }
  if (!dirent.isSymbolicLink()) {
    return false;
  }
  try {
    const stats = await fs.stat(fullPath);
    return stats.isDirectory();
  } catch (error) {
    logWarningOnce(`symlink-dir:${fullPath}`, `Unable to inspect symlink target ${fullPath}.`, error);
    return false;
  }
}

async function canonicalize(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      logWarningOnce(`canonicalize:${targetPath}`, `Unable to resolve real path for ${targetPath}.`, error);
    }
    return targetPath;
  }
}

async function detectProject(projectPath: string, installedExtensions: Map<string, InstalledExtensionInfo>): Promise<{
  kind: ProjectKind;
  evidence: Evidence[];
  suggestedCommands: string[];
  isInstalledVscodeExtension: boolean;
  vscodeExtension?: VscodeExtensionSummary;
}> {
  const evidence: Evidence[] = [];
  const suggestedCommands: string[] = [];
  const names = new Set(await safeReadNames(projectPath));

  const pm2Config = findKnownName(names, ["ecosystem.config.js", "ecosystem.config.cjs", "ecosystem.config.json"]);
  if (pm2Config) {
    evidence.push(fileEvidence(projectPath, pm2Config, "This is a PM2 project."));
    suggestedCommands.push("pm2 start ecosystem.config.js");
    return { kind: "pm2", evidence, suggestedCommands, isInstalledVscodeExtension: false };
  }

  if (names.has("package.json")) {
    const packageInfo = await readPackageInfo(path.join(projectPath, "package.json"));
    for (const scriptName of ["dev", "start", "serve", "preview"]) {
      if (packageInfo.scripts.has(scriptName)) {
        suggestedCommands.push(`npm run ${scriptName}`);
      }
    }

    const viteConfig = findKnownName(names, ["vite.config.js", "vite.config.ts", "vite.config.mjs"]);
    if (viteConfig) {
      evidence.push(fileEvidence(projectPath, viteConfig, "This is a Vite project."));
    }
    const nextConfig = findKnownName(names, ["next.config.js", "next.config.mjs", "next.config.ts"]);
    if (nextConfig) {
      evidence.push(fileEvidence(projectPath, nextConfig, "This is a Next.js project."));
    }
    const astroConfig = findKnownName(names, ["astro.config.js", "astro.config.mjs", "astro.config.ts"]);
    if (astroConfig) {
      evidence.push(fileEvidence(projectPath, astroConfig, "This is an Astro project."));
    }
    const hasExpress = packageInfo.dependencies.has("express");

    const kind = packageInfo.isVscodeExtension
      ? "vsce"
      : nextConfig
        ? "next"
        : viteConfig
          ? "vite"
          : astroConfig
            ? "astro"
            : hasExpress
              ? "express"
              : "node";
    const packageProof =
      kind === "vsce"
        ? "This is a VS Code extension."
        : kind === "express"
          ? "This is an Express project."
        : kind === "node"
          ? "This is a Node.js project."
          : `This project uses ${kind}.`;
    evidence.unshift(fileEvidence(projectPath, "package.json", packageProof));

    const installedExtension =
      packageInfo.extensionId !== undefined ? installedExtensions.get(packageInfo.extensionId) : undefined;
    const isInstalledVscodeExtension = installedExtension !== undefined;
    const publishedVersion = packageInfo.extensionId ? await readMarketplaceExtensionVersion(packageInfo.extensionId) : undefined;

    return {
      kind,
      evidence,
      suggestedCommands: suggestedCommands.length > 0 ? suggestedCommands : ["npm install", "npm run dev"],
      isInstalledVscodeExtension,
      vscodeExtension: packageInfo.isVscodeExtension
        ? {
            id: packageInfo.extensionId,
            installedVersion: installedExtension?.version,
            latestVersion: packageInfo.version,
            publishedVersion,
            packagePath: await findVscodePackagePath(projectPath, packageInfo.name, packageInfo.version)
          }
        : undefined
    };
  }

  if (names.has("manage.py")) {
    evidence.push(fileEvidence(projectPath, "manage.py", "This is a Django project."));
    suggestedCommands.push("python manage.py runserver");
    return { kind: "python", evidence, suggestedCommands, isInstalledVscodeExtension: false };
  }

  const pythonFile = findKnownName(names, ["pyproject.toml", "requirements.txt", "app.py", "main.py"]);
  if (pythonFile) {
    evidence.push(fileEvidence(projectPath, pythonFile, "This is a Python project."));
    suggestedCommands.push("python -m http.server 8000");
    return { kind: "python", evidence, suggestedCommands, isInstalledVscodeExtension: false };
  }

  if (names.has("index.html")) {
    evidence.push(fileEvidence(projectPath, "index.html", "This is a static site."));
    suggestedCommands.push("python3 -m http.server 8000", "npx serve .");
    return { kind: "static", evidence, suggestedCommands, isInstalledVscodeExtension: false };
  }

  return {
    kind: "unknown",
    evidence: [{ label: "No recognizable project files found" }],
    suggestedCommands: [],
    isInstalledVscodeExtension: false
  };
}

async function readMarketplaceExtensionVersion(extensionId: string): Promise<string | undefined> {
  const normalizedId = extensionId.toLowerCase();
  const cached = marketplaceVersionCache.get(normalizedId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.version;
  }

  try {
    const response = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
      method: "POST",
      headers: {
        "Accept": "application/json;api-version=7.2-preview.1;excludeUrls=true",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filters: [
          {
            criteria: [{ filterType: 7, value: normalizedId }]
          }
        ],
        flags: 1
      })
    });
    if (!response.ok) {
      throw new Error(`Marketplace request failed with HTTP ${response.status}.`);
    }

    const data = (await response.json()) as {
      results?: Array<{
        extensions?: Array<{
          versions?: Array<{
            version?: unknown;
          }>;
        }>;
      }>;
    };
    const version = data.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
    const publishedVersion = typeof version === "string" ? version : undefined;
    marketplaceVersionCache.set(normalizedId, { version: publishedVersion, expiresAt: Date.now() + marketplaceVersionCacheMs });
    return publishedVersion;
  } catch (error) {
    logWarningOnce(`marketplace:${normalizedId}`, `Unable to check Visual Studio Marketplace version for ${normalizedId}.`, error);
    marketplaceVersionCache.set(normalizedId, { expiresAt: Date.now() + marketplaceVersionCacheMs });
    return undefined;
  }
}

async function safeReadNames(projectPath: string): Promise<string[]> {
  try {
    return await fs.readdir(projectPath);
  } catch (error) {
    logWarningOnce(`readdir:${projectPath}`, `Unable to read project directory ${projectPath}.`, error);
    return [];
  }
}

async function readPackageInfo(packageJsonPath: string): Promise<{
  scripts: Set<string>;
  dependencies: Set<string>;
  name?: string;
  extensionId?: string;
  version?: string;
  isVscodeExtension: boolean;
}> {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      engines?: { vscode?: unknown };
      name?: unknown;
      publisher?: unknown;
      version?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const scripts = new Set(Object.entries(parsed.scripts ?? {}).filter(([, value]) => typeof value === "string").map(([key]) => key));
    const dependencies = new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {})
    ]);
    const isVscodeExtension = typeof parsed.engines?.vscode === "string";
    const extensionId =
      typeof parsed.publisher === "string" &&
      typeof parsed.name === "string" &&
      isVscodeExtension
        ? `${parsed.publisher}.${parsed.name}`.toLowerCase()
        : undefined;
    const version = typeof parsed.version === "string" ? parsed.version : undefined;
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    return { scripts, dependencies, name, extensionId, version, isVscodeExtension };
  } catch (error) {
    logWarningOnce(`package-json:${packageJsonPath}`, `Unable to parse package.json at ${packageJsonPath}.`, error);
    return { scripts: new Set(), dependencies: new Set(), isVscodeExtension: false };
  }
}

async function findVscodePackagePath(
  projectPath: string,
  packageName: string | undefined,
  version: string | undefined
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectPath);
  } catch (error) {
    logWarningOnce(`vsix:${projectPath}`, `Unable to scan VSIX packages in ${projectPath}.`, error);
    return undefined;
  }

  const vsixFiles = entries.filter((entry) => entry.endsWith(".vsix"));
  if (vsixFiles.length === 0) {
    return undefined;
  }

  const expectedName = packageName && version ? `${packageName}-${version}.vsix` : undefined;
  const selected = expectedName && vsixFiles.includes(expectedName) ? expectedName : vsixFiles.sort().reverse()[0];
  return path.join(projectPath, selected);
}

function findKnownName(names: Set<string>, candidates: string[]): string | undefined {
  return candidates.find((candidate) => names.has(candidate));
}

function fileEvidence(projectPath: string, fileName: string, proof: string): Evidence {
  return { label: fileName, path: path.join(projectPath, fileName), proof };
}

function isSameOrInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
