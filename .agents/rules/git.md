---
trigger: always_on
---

# Git Workflow & Small Commits

- **Keep every commit tiny and single-purpose:** One discrete, verified step per commit (e.g., `.gitignore`/config, one module, its tests, one bug fix, or one doc/rule update). Never bundle unrelated changes into a single catch-all commit.
- **Commit immediately after verification:** Run the relevant check (`/check`, `pnpm typecheck`, `pnpm test`, or spike run) and verify it passes before committing.
- **Conventional Commits:** Use clear prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `style:`, `chore:`) with optional scope (e.g., `feat(vad): ...`, `docs(rules): ...`).
- **Push regularly to GitHub:** After committing verified work, push small commits promptly to `origin` (`main`) so remote history stays up to date and never accumulates large unpushed batches.
- **Never commit untracked local/sensitive artifacts:** Keep `.env*`, local SQLite DBs, downloaded ONNX models/WAVs (`spikes/**/out/`), and `Technical Assignment.pdf` out of git.
