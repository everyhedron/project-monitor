- [ ] SKIP FOR NOW: if the current installation of a vsce is stale, the window hasnt reloaded since last time, change the Installed button to a clickable Stale button that reloads the window
- [x] is it true that when project monitor is not focused, it pauses its refresh? because when i go to another tab, then comeback, the refresh restarts at 30s. even if it does pause, can we make it continue from the previous countdown? also since now we have the status bar icon, how do we deal with that if we are not updating?
- [x] after i added changes in a project after it synced, it turns into unstaged and unsynced. since the sync is dependednt on the stage>commit flow, unstaged should be enough to mean that its unsynced.
- [x] if there is no project name got from readme, we should also show name as red, such as no readme, readme is empty, or has no title line. in fact we should get rid of the logic to parse a proper case name from the project folder altogether, if there is no name from readme, we just use the kebab case, so its more obvious to user that they need to fix this.
- [x] I have gotten an error like this in the output "2026-07-07T19:29:47.986Z INFO Restored existing dashboard webview panel.
2026-07-07T19:29:48.365Z WARN Unable to inspect nginx static route /home/admin/portfolio/public/tmp/.
Error: ENOENT: no such file or directory, realpath '/home/admin/portfolio/public/tmp/'
	at async Object.realpath (node:internal/fs/promises:1181:10)
	at async applyStaticRoute (/home/django/.vscode-server/extensions/everyhedron.project-monitor-0.0.10/out/discovery.js:449:23)
	at async applyNginxRoutes (/home/django/.vscode-server/extensions/everyhedron.project-monitor-0.0.10/out/discovery.js:424:13)
	at async Promise.all (index 0)
	at async discoverWorkspace (/home/django/.vscode-server/extensions/everyhedron.project-monitor-0.0.10/out/discovery.js:65:52)
	at async Dashboard.refreshNow (/home/django/.vscode-server/extensions/everyhedron.project-monitor-0.0.10/out/dashboard.js:166:43)
" is this an easy fix? also can you make sure we are not silently swallowing any error? we should be printing all errors to the output.
- [x] for some reason when clicking on the published link of projects it opens two identical tabs in the browser instead of just one. clicking on the port would open one tab with simple browser in vscode, another in the browser. please fix.
