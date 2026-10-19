# Codex Feishu Bridge Desktop 0.8.26

Fix Windows Bot recovery when a saved Bridge PID has been reused by a system service, another program, or a later Node process. Status checks, startup, single-instance locks, and shutdown verify the executable, Bridge entry point, and process creation time. New ownership records retain the exact process creation time. Existing records remain compatible when their actual Bridge process predates the lock. Unavailable identity information refuses destructive actions and duplicate consumers.

The Windows deployment helper now opens the installed Start Menu shortcut through the logged-in Explorer desktop shell. Automated deployment must not launch Electron as an SSH or PowerShell child that keeps the maintenance console alive. Normal users continue to open the installed desktop shortcut.

Validation includes actual Windows process inspection, a forced-stop regression proving an unrelated live Node process is preserved, stale/reused PID cases, exact process lifetime matching, legacy ownership records, interrupted lock initialization, and replacement ownership during inspection. Release installation additionally verifies the interactive client has no attached console and each recovered Bot has one event consumer.
