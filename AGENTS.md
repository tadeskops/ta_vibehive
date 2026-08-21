# ta_vibehive — Agent / Copilot Working Rules

These rules apply to every prompt inside `ta_vibehive/`.

## 1. `temp/` folder is local-only, never pushed
- Path: `ta_vibehive/temp/`
- Purpose: Copilot chat history, scratch notes, intermediate drafts, receipts, PDFs, anything not part of the shipped project.
- Enforced by `temp/` entry in `.gitignore`.
- Anything the agent needs to stash temporarily (transcripts, planning notes, prompt drafts) goes here.

## 2. Requirements-first workflow
Once development starts, this repo will maintain two authoritative requirements files at the repo root:

- `tvh_requirements.md` — functional / backend / behavioral requirements.
- `tvh_requirements_ui.md` — UI / UX / visual / interaction requirements.

**Every prompt must follow this loop, in order:**

1. **Read first.** Before writing or changing any code, open and re-read both `tvh_requirements.md` and `tvh_requirements_ui.md`. Treat them as the single source of truth.
2. **Align implementation.** Every code change must map to an existing requirement. If a change is needed that isn't covered, pause and add/adjust the requirement first, then implement.
3. **Update after.** After implementation, update the relevant requirements file(s) to reflect the new/changed behavior. Keep entries properly clustered:
   - Group by feature / module (not by chronological order).
   - Keep functional items in `tvh_requirements.md`.
   - Keep UI/UX items in `tvh_requirements_ui.md`.
   - No duplication across the two files — cross-reference instead.

## 3. Push identity lock (already enforced)
- Only `tadeskops <ta.deskops@gmail.com>` may commit or push. Enforced by local `.git/hooks/pre-commit` and `.git/hooks/pre-push`.
