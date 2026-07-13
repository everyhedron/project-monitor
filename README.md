# Project Monitor

Project Monitor is a VS Code dashboard for keeping track of local project folders: what kind of project each folder is, whether it is running or published, what Git state it is in, and what maintenance files still need attention.

Open the dashboard with `Project Monitor: Open Dashboard`.

## Features

- Explicit project tracking. Add folders with the dashboard's Add Project action or configure `projectMonitor.projects` directly.
- Card and table views with project search, parent-folder filtering, multi-select removal, and copyable context for selected projects.
- Project detection for common local project types including Node, Express, Vite, Next.js, Astro, Python, static sites, PM2 services, and VS Code extensions.
- Running-port and published-route detection from local listening processes and nginx `sites-enabled` routes.
- Git status summaries showing whether a folder has Git metadata, a remote, staged or unstaged work, committed changes, and sync state.
- TODO, README, and LICENSE summaries with direct open actions.
- VS Code extension package status, installed Marketplace version comparison, and local VSIX package links.
- Codex and Claude terminal actions that reuse matching existing sessions when available.
- Background refresh with a configurable interval and a status bar summary.

## Configuration

Tracked projects are stored in the `projectMonitor.projects` setting:

```json
{
  "projectMonitor.projects": [
    "/path/to/project"
  ]
}
```

The dashboard refresh interval is controlled by `projectMonitor.refreshIntervalMs`. The default is `5000` milliseconds and the minimum is `200` milliseconds.

## Notes

Project Monitor reads local filesystem, Git, process, nginx, VS Code extension, Codex session, and Claude session metadata. It does not scan arbitrary folders by default; suggestions are derived from folders related to projects you already track and from nginx routes that point at local folders or processes.
