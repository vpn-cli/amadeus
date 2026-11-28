---
trigger: always_on
---

# Session start (applies to every task)

1. Before doing anything else in a task, read AGENTS.md at the repo root and follow it.
2. Never open, print, or edit .env (or any file containing API keys).
3. Never push unless the user's current prompt explicitly says to push.
4. For any non-trivial task: present a plan and wait for approval before writing code.
5. Paste verification commands with their full output and exit codes; never summarize results instead of showing them.
6. After each task, append an entry to handoff/antigravity-log.md.