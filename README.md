# Project Monitor

Project Monitor opens a VS Code webview dashboard for local project folders.

Projects are tracked explicitly — there's no folder scanning by default. Add a
project with the **+ Add Project** button (opens a folder picker) on the
Projects tab. Each card shows best-effort type detection, running-port
status, and any live domain/URL it's actually published at (resolved from
`/etc/nginx/sites-enabled`, following `alias`/`root` symlinks and
`proxy_pass` ports). Use **Remove** on a card to stop tracking it.

The **Suggestions** tab proposes folders you probably want to add next:

- sibling folders of projects you already track
- folders nginx is actually serving (via a symlink under an `alias`/`root`,
  or a `proxy_pass` to a port some running process owns) that aren't tracked
  yet

Click **Add** on a suggestion to start tracking it.

Open the dashboard with:

```text
Project Monitor: Open Dashboard
```

Tracked projects are stored in:

```json
{
  "projectMonitor.projects": [
    "/home/django/rampulla/batch-fetch"
  ]
}
```
