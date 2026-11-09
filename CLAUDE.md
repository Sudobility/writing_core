# @sudobility/writing_core

> **Git policy.** Commit on `main` while executing a plan task. Push only when
> the user explicitly asks in that turn.

Headless, platform-free writing engine for the Fadewright family (screenplays,
teleplays, stage plays, AV/radio scripts, graphic novels, manuscripts). It owns
the document model (Yjs), data-driven templates, editing commands, SmartType,
per-session undo, and a deterministic layout/pagination engine. It knows nothing
about accounts, servers, UI, fonts-on-disk or any render target — `DocLine`/
`GlyphRun` are host-agnostic draw instructions; renderers read them and never
feed back into layout. Specs live in `~/projects/screenwriter_plans/specs/`
(01 model, 02 layout, 08 commands, 11 §4.2 content hash; master registry wins).

## Tech stack

- TypeScript (strict, `noUncheckedIndexedAccess`), ESM only. Build = `tsc -p tsconfig.esm.json` → `dist/`.
- Vitest for tests; **Bun** for installs and running `scripts/*.ts`.
- Deps: `yjs`, `zod`, `@noble/hashes`, `harfbuzzjs`. Dev-only: `fontkit`, `pdfjs-dist`, `fast-xml-parser`, `fast-check`.
- Published to **GitHub Packages** (`npm.pkg.github.com`, `@sudobility` scope) via `johnqh/workflows` unified-cicd on push to `main`/`develop`. NOT public npm.

## Commands

- `bun run verify` — typecheck + lint + `test:unit` + build. **Required before every commit.**
- `bun run test:unit` (vitest; `test:watch` to watch). There is **no** `bun run test` script.
- `bun run typecheck` (src via tsconfig.json, then tests+`scripts/` via tsconfig.test.json) · `bun run lint` (eslint src scripts) · `bun run build`.
- `bun run bench:layout` (`:update` rewrites baseline) · `bun test src/layout/determinism.test.ts` (JSC-via-Bun determinism).
- Generators, by hand only: `templates:generate`, `hash:vectors`, `fonts:generate`, `ucd:generate`, `dict:generate`, `fixtures:build`, `golden:update`.
- `templates/generator/golden.test.ts` reads `FADEWRIGHT_TEMPLATES_DIR` (default `../screenwriter_plans/research/templates`) and skips when absent.

## Architecture (public API is `src/index.ts`; `/internal` is framework-extension escape hatch)

- `units.ts` — EMU (914 400/in). **All lengths are integers everywhere.**
- `ids/` — prefixed ULIDs; `IdSource` is injected (`createSeededIdSource` in tests).
- `hash/` — canonical JSON + SHA-256 content hashes (spec 11 §4.2), pinned by `vectors.json` under `HASH_VERSION`.
- `schema/` — Zod schemas; types are `z.infer`. `vocab.ts` is the single vocabulary declaration.
- `template/` + `templates/` — style resolution, validation, Enter/Tab flow; built-in Fade In templates (generated), locale variants, catalogue (`getBuiltinTemplate`, default `screenplay-standard`).
- `model/` — Yjs doc creation, JSON conversion, template apply/export, portable positions, validation (`validate/`), migrations (`DOC_SCHEMA_VERSION`).
- `read-model/` — `openDocument`: order index, element views, scenes, dialogue blocks, outline, entities, suggestions, hashes. Views are **frozen and replaced, never mutated**.
- `commands/` — command registry + `executeCommand`/`executeBatch`; text/mark/element/entity/SmartType/page-setup/dual/locking/revision commands.
- `layout/` — `layoutDocument` + incremental `createLayoutEngine`; pagination, decorations (headers/footers, scene numbers), title pages, continueds/`(MORE)`/`(CONT'D)`, dual-column geometry, page-locks, source↔layout mapping (`mapping.ts`), bounded LRU `ParagraphCache`, eighths/running-time, PDF-line extraction.
- `smarttype/` — name normalization and harvesting. `undo/` — per-session undo.

## Conventions

- Every write goes through `executeCommand`/`executeBatch` → one `doc.transact` per invocation, carrying a `TransactionOrigin`.
- Every invocation is rehearsed on a throwaway document replica first, so a refusal after a partial write never reaches the live doc. A command's `run` makes all refusal checks before its first write.
- `readOnly` defaults to `isNewerThanCode(doc)` (invariant I20); override only by passing `false` explicitly.
- Element order is `pos` (fractional, base-62) then id. **Never use `Y.Array` for anything people reorder.**

## Gotchas (non-obvious; verified in-tree)

- **No `bun run test`** — the script is `test:unit`.
- **`Math.round` is banned in layout.** Use `round.ts`'s named rules (`roundHalfEven`, `snapToHundredthInch`, …); spec 02 says which applies where. Grep before trusting a new layout calc.
- **`Intl` is banned** (`__guards/platform-free.test.ts`). CLDR-derived data arrives only via the injected `LocaleDataPort` (`template/locale-data.ts`).
- **`fastPath: true` skips rehearsal**, so such a command MUST refuse before its first write. Allowlist (pinned by a guard test): `text.insert`, `text.insertSoftReturn`, `text.deleteBackward`, `text.deleteForward`, `element.split`, `element.setStyle`, `element.cycleStyle`. Never set it on a batch. Rehearsal clones the whole doc (O(size); guarded at 3000 elements).
- **The command registry is a process-wide singleton.** Registering the same id twice throws, so the whole suite in ONE process (`bun test`) fails where `vitest run` (one process per file) passes. Use `createCommandRegistry()` to scope.
- **`ctx.model` is stale inside a command.** The read model's indexes/caches refresh only when the transaction ENDS. Read `ctx.model` before your first write; after writing, read the Y.Doc directly. `executeBatch` gives each command after a mutating one a fresh throwaway model so batch ≡ sequential.
- **Rebalancing must be deterministic** (`pos` is last-writer-wins). I19 auto-repair uses `rebalanceDegenerateRuns` (touches only over-long contiguous runs); the raw destructive `rebalancePositions` reshuffles the whole key space and can lose a concurrent insert — callers of it directly own that risk.
- **Relative positions do not survive a new `Y.Doc`** — stored as `o:<offset>`, rebuilt by `materializeDocument`.
- **Undo grouping is ours, not Yjs's** — `Y.UndoManager` with infinite capture timeout; `stopCapturing()` driven by an injected clock; tracked origins are per-session so other sessions' typing is never undone.
- **Built-in templates are generated** — edit sources (`osf.ts`/`shared.ts`/authored modules) and regenerate; never hand-edit `builtin/generated` (its `checksums.json` is golden-tested).
- **Changing any hash rule bumps `HASH_VERSION`**; never regenerate `vectors.json` for the same version. Layout fingerprints / `docVersionOf` are NOT content hashes and must never live in `src/hash`.
- **`resolveStyle` is memoized on template object identity** (WeakMap); the cached resolution is frozen — mutate a copy.
- **`textVersion`/`attrsVersion` are per-id high-water marks**, never reset on delete (an id can return via undo/re-import).
- **Automatic `(CONT'D)`** (`layout/context.ts`): same normalized speaker speaks again in the same scene with nobody between, cue not already marked, and `pagination.automaticContinueds.enabled`. No longer requires a non-dialogue interruption (changed per user requirement, 2026-09-28). A dual block resets last speaker.
- **Speaker-name folding strips only known extensions** — `entityNameKey` folds `(V.O.)`/`(O.S.)`/`(CONT'D)` + template extensions; `MAYA (YOUNG)` ≠ `MAYA`.
- **`breakOnSentences` dialogue only splits after a line that ENDS a sentence** — test speeches need one short sentence per line or nothing splits.
- **Font metrics ship without font binaries.** `FontRegistry`/`FontFaceMetrics` are pure generated advance tables; a host supplies real bytes via the `Shaper`'s `prepareFace`/`HarfBuzzDeps.faceBytes`. Courier family always lays out at 10 cpi regardless of the face's own advance (ruling V-02-7). A shaper-less engine flags `approximateShaping` — never persist/export/lock-anchor that.

## Golden corpus

`test/fixtures/*.doc.json` are committed plain `DocumentJSON` (loaded via `materializeDocument`); layout tests run everywhere with no env var or licensed file. `src/layout/golden.test.ts` pins `act-2`/`ending-updated` page counts (12, 10) against spike S2; `golden-cases.test.ts` + `test/golden/<case>/` pin five rule-case snapshots (regenerate with `bun run golden:update`). There is no real `.fadein`/OSF **document** importer here (that is spec 04 / `writing_formats`) — only an OSF **template** importer. `docs/verification/V-02.md` records what the PDF/Fade-In parity work is blocked on.

## Related projects

`writing_formats` · `writing_ui` · `writing_ui_rn` · `screenwriter_types` · `screenwriter_api` · `screenwriter_lib` · `screenwriter_plans`
