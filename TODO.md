- [ ] SKIP FOR NOW: if the current installation of a vsce is stale, the window hasnt reloaded since last time, change the Installed button to a clickable Stale button that reloads the window
- [x] change the left number on the x/y displayed in the status bar to the inverse. which is we want the x to be the number of bad projects "stopped" or "stale"
- [x] there is a slight issue with the focusing on the agent terminal instead of creating duplicate. im asking the agent monitor projects coding agent to inspect project monitor for differences, because the logic need to be the same for both to work together. Take a look at the other agent's diagnosis in the agent monitor todo. write below your suggested plan.

Suggested plan:

- Replace Project Monitor's terminal reuse source of truth with the same name-based lookup Agent Monitor uses: compute the intended terminal name, scan `vscode.window.terminals.find((terminal) => terminal.name === terminalName)`, and focus it before creating anything.
- Keep terminal names stable as `Project Name` for normal project terminals and `Project Name | Codex` for agent terminals; do not include session ids or paths in names.
- Keep the current in-memory map only as an optional fast path, or remove it entirely. Name-based lookup is the important behavior because it survives extension-host reloads and terminals created by the other monitor.
- For `openAgent`, copy the project path before focusing or creating the terminal. If the terminal already exists, focus it and do not resend `codex` or `codex resume`, because that would duplicate commands in an active session.
- After both extensions share this lookup rule, opening `Agent Monitor | Codex` from either monitor should focus the same terminal instead of creating duplicates.

- [x] ![alt text](image-1.png) many projects are overflowing. I change my mind, let them be on separate lines, but the terminal and agent should be closer to the title than to the project path. Do keep the status tag fixed at the top right corner, it should not be pushed off even if the name is too long. If the name is too long, the name should be truncated with "...", not just cut off visually.
- [x] "Refreshing in 27s on Projects" Here omit the "on Projects", just "Refreshing in [countdown]s" is enough
