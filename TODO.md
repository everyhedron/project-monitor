- [ ] SKIP FOR NOW: if the current installation of a vsce is stale, the window hasnt reloaded since last time, change the Installed button to a clickable Stale button that reloads the window
- [x] is it true that when project monitor is not focused, it pauses its refresh? because when i go to another tab, then comeback, the refresh restarts at 30s. even if it does pause, can we make it continue from the previous countdown? also since now we have the status bar icon, how do we deal with that if we are not updating?
- [ ] you have not answered the previous item. write response under this item
- [x] after i added changes in a project after it synced, it turns into unstaged and unsynced. since the sync is dependednt on the stage>commit flow, unstaged should be enough to mean that its unsynced.
- [ ] i added a new untracked item in a synced folder, it did not become unstaged.
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
- [ ] for previous item, explain if its fixed, how its fixed, what was the issue.
- [ ] If the license has not content, it should also be red instead of just saying "LICENSE"
- [ ] ![alt text](image-2.png) the published and port links have become chunky solid buttons. please revert its visual style. 
