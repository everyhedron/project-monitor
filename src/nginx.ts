import * as fs from "fs/promises";
import * as path from "path";
import { logWarningOnce } from "./log";

export type NginxRoute =
  | { kind: "static"; domain: string; locationPath: string; fsPath: string }
  | { kind: "proxy"; domain: string; locationPath: string; port: number };

const sitesEnabledDir = "/etc/nginx/sites-enabled";

type BlockContext = {
  type: string;
  args: string;
  domain?: string;
};

export async function readNginxRoutes(): Promise<NginxRoute[]> {
  try {
    const entries = await fs.readdir(sitesEnabledDir);
    const routes = await Promise.all(entries.map((entry) => readRoutesFromFile(path.join(sitesEnabledDir, entry))));
    return routes.flat();
  } catch (error) {
    logWarningOnce("nginx:sites-enabled", `Unable to read nginx routes from ${sitesEnabledDir}.`, error);
    return [];
  }
}

async function readRoutesFromFile(filePath: string): Promise<NginxRoute[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return parseRoutes(content);
  } catch (error) {
    logWarningOnce(`nginx:file:${filePath}`, `Unable to read nginx site file ${filePath}.`, error);
    return [];
  }
}

function parseRoutes(content: string): NginxRoute[] {
  const routes: NginxRoute[] = [];
  const stack: BlockContext[] = [];

  for (const rawLine of content.split("\n")) {
    const line = stripComment(rawLine).trim();
    if (!line) {
      continue;
    }

    if (line === "}") {
      stack.pop();
      continue;
    }

    const blockMatch = line.match(/^(\S+)\s*(.*?)\{\s*$/);
    if (blockMatch) {
      const [, type, args] = blockMatch;
      stack.push({ type, args: args.trim() });
      continue;
    }

    const directiveMatch = line.match(/^(\S+)\s+(.*?);\s*$/);
    if (!directiveMatch) {
      continue;
    }
    const [, name, value] = directiveMatch;

    const serverContext = findServerContext(stack);
    const locationContext = stack[stack.length - 1];

    if (name === "server_name" && serverContext && !serverContext.domain) {
      serverContext.domain = value.split(/\s+/)[0];
      continue;
    }

    if (!serverContext?.domain || locationContext?.type !== "location") {
      continue;
    }

    const locationPath = normalizeLocationPath(locationContext.args);

    if (name === "alias" || name === "root") {
      routes.push({ kind: "static", domain: serverContext.domain, locationPath, fsPath: value.trim() });
      continue;
    }

    if (name === "proxy_pass") {
      const portMatch = value.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)/);
      if (portMatch) {
        routes.push({ kind: "proxy", domain: serverContext.domain, locationPath, port: Number(portMatch[1]) });
      }
    }
  }

  return routes;
}

function findServerContext(stack: BlockContext[]): BlockContext | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].type === "server") {
      return stack[i];
    }
  }
  return undefined;
}

function normalizeLocationPath(args: string): string {
  const stripped = args.replace(/^(=|~\*|~|\^~)\s*/, "").trim();
  return stripped || "/";
}

function stripComment(line: string): string {
  const index = line.indexOf("#");
  return index === -1 ? line : line.slice(0, index);
}

export function joinUrlPath(domain: string, ...segments: string[]): string {
  const parts = segments
    .join("/")
    .split("/")
    .filter(Boolean);
  return `https://${domain}/${parts.join("/")}${parts.length > 0 ? "/" : ""}`;
}
