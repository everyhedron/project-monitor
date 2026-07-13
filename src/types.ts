export type ProjectKind = "node" | "express" | "next" | "vite" | "astro" | "python" | "static" | "pm2" | "vsce" | "unknown";

export type ProjectStatus = "running" | "serving" | "installed" | "stopped" | "unknown";

export type PublishedRoute = {
  domain: string;
  url: string;
};

export type GitStatus = {
  hasGit: boolean;
  hasRemote: boolean;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedChanges: boolean;
  allChangesStaged: boolean;
  committed: boolean;
  hasUnpushedCommits: boolean;
  hasUnpulledCommits: boolean;
  synced: boolean;
  label: string;
};

export type TodoSummary = {
  exists: boolean;
  completed: number;
  total: number;
};

export type ReadmeSummary = {
  exists: boolean;
  path?: string;
  heading?: string;
  description?: string;
  section?: string;
};

export type LicenseSummary = {
  exists: boolean;
  path?: string;
  label?: string;
  hasContent?: boolean;
};

export type VscodeExtensionSummary = {
  id?: string;
  installedVersion?: string;
  latestVersion?: string;
  publishedVersion?: string;
  packagePath?: string;
};

export type ServiceSummary = {
  name?: string;
  systemPath?: string;
  projectSymlinkPath?: string;
  copyCommand?: string;
};

export type Evidence = {
  label: string;
  path?: string;
  proof?: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
  status: ProjectStatus;
  ports: number[];
  urls: string[];
  evidence: Evidence[];
  suggestedCommands: string[];
  publishedRoutes: PublishedRoute[];
  git: GitStatus;
  todo: TodoSummary;
  readme: ReadmeSummary;
  license: LicenseSummary;
  vscodeExtension?: VscodeExtensionSummary;
  service?: ServiceSummary;
};

export type Suggestion = {
  path: string;
  name: string;
  reason: string;
};

export type ListeningProcess = {
  pid: number;
  commandName: string;
  commandLine: string;
  cwd?: string;
  ports: number[];
};
