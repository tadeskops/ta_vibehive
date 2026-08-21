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

## 4. Implementation invariants (apply to every slice)

### 4.1 Scalable · abstracted · modular · no conflicts
- **One module = one responsibility.** Cross-module data access happens ONLY through the module's public contract (see `tvh_architecture.md` §3). No sneaking into another module's DB tables.
- **Adapters for swap points.** Payment provider, notification channel, archive store, auth provider are behind adapter interfaces so implementations can be swapped without touching the caller.
- **Feature Registry is the single source of truth** for what is enabled where. New behaviour that could conflict with an existing feature MUST declare its dependency + conflict rules in the registry (`F-FR05` dependency validation catches it before it ships).
- **No hard-coded societal facts.** Amounts, dates, tier values, minimums, capacity caps, emergency thresholds, retention windows — every one is a config parameter, never a magic number in code.
- **Extension over modification.** New event cluster? New template + registry entry, no changes to the Event Engine core. New payment method? New adapter, no changes to the Contribution Engine.
- **Every public function has a test.** Every module has a `README.md` that lists its public surface + a 5-line threat model (see arch §15.4).

### 4.2 Configuration parameters — the contract
Every configurable setting MUST expose the following metadata (schema enforced at load time; missing fields = build fails):

| Field | Purpose |
|---|---|
| `key` | Machine identifier, stable, snake_case (e.g. `payment.upi.vpa`) |
| `label` | Human title shown to the moderator (e.g. "UPI VPA (society bank)") |
| `description` | 1–3 sentence plain-English explanation of what this setting does + why it matters |
| `type` | `string` \| `int` \| `decimal` \| `bool` \| `enum` \| `date` \| `duration` \| `secret` \| `json` \| `image` |
| `allowed_values` | For `enum`: the exact choices with a per-choice caption |
| `min` / `max` / `pattern` | Validation constraints |
| `default` | Sensible starting value that works for a fresh society |
| `unit` | Human unit (₹, minutes, %, MB) |
| `scope` | `system` \| `event_type` \| `event` \| `user` (per arch §5) |
| `editable_by` | Roles allowed to change it (per RBAC grid arch §4.2) |
| `depends_on` | Array of other keys this setting requires or influences, each with a rule (`requires` / `disables` / `implies` / `conflicts_with`) |
| `example` | A working sample value shown to the moderator |
| `warning` | Text shown if the setting is dangerous or has cost implications |
| `audit` | Boolean: is a change to this value written to the audit log? (default `true`) |
| `revealed_when` | Optional condition — hide this key in the UI unless another key has a specific value (progressive disclosure) |

**Rule for moderators:** if a moderator can see a config field in the UI, they can also see its `label` + `description` + `default` + `depends_on` inline, without opening docs.

### 4.3 Draft-until-saved (edit UX contract)
- Config edits ALWAYS start in a **draft state**. No auto-save. No "changes are saved automatically."
- Draft is persisted to `localStorage` under `draft:<config_scope>:<user_id>:<config_id>` so a browser refresh, tab close, or crash preserves the work.
- Draft is also persisted server-side as a `config_draft` row keyed by `(user_id, scope, target_id, saved_at=null)` on every field-blur so multi-device continuation works.
- Explicit **Save** button commits the draft to the active `config` table (with an audit-log entry) and clears both localStorage and the draft row.
- Explicit **Discard draft** button removes both stores after a confirmation modal.
- If the moderator navigates away with unsaved changes, browser `beforeunload` shows the native "unsaved changes" prompt.
- On page load, if a draft exists for `(user, scope, target)`, the UI shows a banner: *"You have unsaved changes from &lt;relative_time&gt;. Resume or discard?"*
- Two moderators editing the same config on different devices: the second Save shows a conflict warning with the field-level diff; the second moderator picks per-field which value wins. No silent overwrite.
- Draft state MUST NOT be readable by anyone other than the drafting moderator.

### 4.4 Caching (so refresh doesn't lose information)
- **Client-side:** every config surface writes to `localStorage` on every field-blur (throttled to 300ms). Draft key naming as in §4.3.
- **Server-side:** GET on any config surface returns an `ETag`; browser + service worker use `stale-while-revalidate`. Immediate refresh returns cached UI instantly; new data loads in the background and refreshes without dropping the draft overlay.
- **Draft-then-refresh contract:** if the moderator has an active draft, the refresh MUST NOT overwrite draft field values with server values. Only untouched fields are refreshed from the server. If a server field diverges from the draft baseline, the field is flagged with a "server changed — review before save" pill.
- **Cache invalidation on save:** the successful Save response invalidates both the ETag (via `Cache-Control: no-cache` on next GET) and clears the draft.
- **No infinite-lived caches.** Every cache entry has a max-age (24h ceiling) and a version tag tied to the deployed schema.

### 4.5 Enforcement (how we prevent regressions)
- CI check: every config key added to `config/schema/*.json` MUST have all §4.2 fields present (a JSON-schema-of-schemas validates this on every push).
- CI check: every draft-editable page in the UI MUST call `useDraft(scope, target)` (grep-based check in CI).
- CI check: `beforeunload` handler MUST be registered on any draft page (Playwright integration test).
- CI check: no hard-coded amount / date / tier / minimum / capacity in application source (grep for numeric literals in `modules/**/*.py`; whitelist limited to test files + calibration constants).
- The `just verify` local harness runs all four checks before push.

### 4.6 Documentation for the moderator
- Every config page auto-generates a printable "Settings reference" PDF from the schema, so committee members can review offline.
- Every dependent config (e.g. "if you enable anonymous contributions, then the public dashboard privacy mode 'partial' is implied") is called out inline AND shown in a side panel "Related settings you might want to change."
