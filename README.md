# @sudobility/writing_core

Headless writing engine for screenplays, teleplays, stage plays, radio,
AV scripts, graphic novels and manuscripts: a collaborative (Yjs) document
model, data-driven templates, editing commands, SmartType, per-session undo,
and deterministic layout and pagination — paragraph layout, page filling,
dual dialogue and column blocks, continueds, revision/lock display, headers/
footers and scene numbering, source↔layout mapping (caret, hit testing,
selection), and an incremental layout engine with a real paragraph cache —
that produce identical pages on every platform (Bun, Node, and JavaScriptCore
via Bun; Hermes and native JavaScriptCore CI are the host app's own
responsibility, see `docs/verification/V-02.md`).

## Installation

This package is published to **GitHub Packages** under the `@sudobility`
scope, so a consumer must point that scope at the GitHub registry first
(the repo's own `.npmrc` already does this):

    echo '@sudobility:registry=https://npm.pkg.github.com' >> .npmrc
    bun add @sudobility/writing_core

Install needs a GitHub token with `read:packages` in the environment
(e.g. `GH_PACKAGES_READ_TOKEN`) when the registry requires authentication.

## Usage

```ts
import {
  cryptoIdSource, createDocument, createSessionOrigins, executeCommand, getBuiltinTemplate, openDocument, registerBuiltinCommands,
} from '@sudobility/writing_core';

registerBuiltinCommands();
const ids = cryptoIdSource;
const doc = createDocument({ template: getBuiltinTemplate('screenplay-standard')!, uid: 'firebase-uid', ids });
const model = openDocument(doc, { ids, clock: Date.now, locale: 'en' });
const actor = { userId: 'firebase-uid', displayName: 'Writer', color: '#224466', kind: 'human' as const };
const origins = createSessionOrigins(actor);
const [heading] = model.elements();

executeCommand({
  doc, model, ids, actor, origin: origins.make('local-typing'), capabilities: new Set(['write']),
  command: { id: 'text.insert', params: { at: { elementId: heading!.id, offset: 0 }, text: 'INT. DINER - NIGHT' } },
});
console.log(model.scenes()[0]!.heading.location); // "DINER"
```

## Development

    bun install            # Bun is used for installs and scripts
    bun run verify         # typecheck + lint + unit tests + build (run before every commit)

Individual steps:

    bun run build          # emit dist/ via tsc -p tsconfig.esm.json
    bun run test:unit      # vitest run  (bun run test:watch to watch)
    bun run typecheck      # tsc --noEmit over src, then tests + scripts/
    bun run lint           # eslint src scripts
    bun run bench:layout   # layout performance benchmark

TypeScript (strict, ESM-only). The public entry point is `src/index.ts`;
`@sudobility/writing_core/internal` exposes framework-extension internals
that bypass the command-layer guarantees — application code should only
ever need the main entry.

Build-time generators (run by hand, not in CI): `templates:generate`,
`hash:vectors`, `fonts:generate`, `ucd:generate`, `dict:generate`,
`fixtures:build`, `golden:update`.

## License

BUSL-1.1
