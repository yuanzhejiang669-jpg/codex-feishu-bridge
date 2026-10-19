# Codex Feishu Bridge Desktop 0.8.27

Correct the Windows deployment launcher to use the automation object belonging to the existing Explorer desktop. A newly created Shell.Application object can still launch Electron as a PowerShell child and leave it attached to the maintenance console. The launcher now resolves the desktop through IShellWindows.FindWindowSW and refuses to continue if it is unavailable.

Interactive Windows verification checks the actual client parent, a visible application window, and AttachConsole returning ERROR_INVALID_HANDLE. The corrected launch also preserves all running Bot processes and their single event consumers. This release includes the PID-reuse recovery fixes from 0.8.26.
