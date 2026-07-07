import { execFile } from "child_process";
import * as fs from "fs/promises";
import { promisify } from "util";
import { logWarningOnce } from "./log";
import type { ListeningProcess } from "./types";

const execFileAsync = promisify(execFile);

type PortByPid = Map<number, Set<number>>;

export async function listListeningProcesses(): Promise<ListeningProcess[]> {
  const portByPid = await getPortsByPid();
  const processes = await Promise.all(
    [...portByPid.entries()].map(async ([pid, ports]) => {
      const [cwd, commandLine, commandName] = await Promise.all([
        readProcessCwd(pid),
        readProcessCommandLine(pid),
        readProcessCommandName(pid)
      ]);

      return {
        pid,
        commandName,
        commandLine,
        cwd,
        ports: [...ports].sort((a, b) => a - b)
      };
    })
  );

  return processes.filter((process) => process.ports.length > 0);
}

async function getPortsByPid(): Promise<PortByPid> {
  return getSsPortsByPid();
}

async function getSsPortsByPid(): Promise<PortByPid> {
  try {
    return parseSs(await runSs());
  } catch (error) {
    logWarningOnce("ports:ss", "Unable to inspect listening ports with ss.", error);
    return new Map();
  }
}

async function runSs(): Promise<string> {
  const { stdout } = await execFileAsync("ss", ["-H", "-ltnp"], {
    timeout: 2500,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function parseSs(output: string): PortByPid {
  const portByPid: PortByPid = new Map();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const localAddress = line.split(/\s+/)[3];
    const port = localAddress ? parsePort(localAddress) : undefined;
    if (port === undefined) {
      continue;
    }

    for (const pid of parsePids(line)) {
      if (!portByPid.has(pid)) {
        portByPid.set(pid, new Set());
      }
      portByPid.get(pid)?.add(port);
    }
  }

  return portByPid;
}

function parsePids(value: string): number[] {
  const pids: number[] = [];
  const pidPattern = /pid=(\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = pidPattern.exec(value)) !== null) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid)) {
      pids.push(pid);
    }
  }

  return pids;
}

function parsePort(value: string): number | undefined {
  const match = value.match(/:(\d+)(?:\s|$)/);
  if (!match) {
    return undefined;
  }

  const port = Number(match[1]);
  return Number.isInteger(port) ? port : undefined;
}

async function readProcessCwd(pid: number): Promise<string | undefined> {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

async function readProcessCommandLine(pid: number): Promise<string> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

async function readProcessCommandName(pid: number): Promise<string> {
  try {
    return (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return "";
  }
}
