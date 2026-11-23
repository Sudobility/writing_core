import * as Y from 'yjs';
import type { DocId, ElementId, EntityId, StyleId } from '../ids/ids.js';
import { type ContentHash, elementContentHash, entityContentHash, sceneContentHash } from '../hash/content.js';
import { isNewerThanCode } from '../migrations/index.js';
import { readEmbeddedTemplate } from '../model/embed-template.js';
import { documentToJSON, readEntity, readNote, readTextKeyed } from '../model/json.js';
import { comparePositions } from '../model/positions.js';
import { validateDocument } from '../model/validate/index.js';
import { orderElements, sortedRecords } from '../model/ymap.js';
import { readTextJSON, scanText } from '../model/ytext.js';
import type {
  AltJSON, BeatJSON, BinItemJSON, BookmarkJSON, DocumentJSON, DocumentMeta, EmbeddedTemplateJSON, NoteJSON, NoteSource, NoteStatus,
  ProductionJSON, RevisionsJSON, SettingsJSON, ShotJSON, TrackChangesJSON, WriterJSON,
} from '../schema/document.js';
import type { EntityJSON } from '../schema/entities.js';
import type { MacroRecord, StyleDef } from '../schema/template.js';
import { SCENE_BOUNDARY_ROLES, SCENE_ROLES, type EntityKind, type SmartTypeList, type StyleRole } from '../schema/vocab.js';
import { entityNameKey } from '../smarttype/normalize.js';
import { type ResolvedStyle, resolveStyle } from '../template/resolve.js';
import { generalCategory } from '../text/ucd.generated.js';
import { wordBoundaries } from '../text/words.js';
import { readCollection } from './collections.js';
import { OrderIndex } from './order-index.js';
import { computeDialogueBlocks, computeOutlineTree, computeScenes, type StructureInput } from './structure.js';
import { matchesPrefix, rankSuggestions } from './suggestions.js';
import type {
  DialogueBlockView, ElementView, EntityView, ModelChange, ModelChangeBatch, ModelDeps, NoteView, OccurrenceView, OutlineNode,
  ProductionChangeKind, RevisionsChangeKind, SceneView, SettingsChangeKind, Suggestion, SuggestionContext, TagCategoryView, TagView, TitlePageView,
  Unsubscribe,
} from './views.js';

type YMap = Y.Map<unknown>;

/**
 * Fill the structured-comment fields that legacy notes (written before the comment lifecycle) lack,
 * so `NoteView` consumers never branch on "field present?". A legacy note's `status` is derived from
 * its `resolved` stamp (resolved → `completed`, else `pending`); `source` defaults to `writer`.
 */
function normalizeNote(n: NoteJSON): NoteView {
  return {
    ...n,
    category: n.category ?? 'other',
    suggestion: n.suggestion ?? null,
    status: n.status ?? (n.resolved ? 'completed' : 'pending'),
    source: n.source ?? 'writer',
    severity: n.severity ?? null,
  };
}

export interface OpenDocumentOptions {
  /** Run `validateDocument(doc).repair()` for `autoRepair` issues before the model's initial
   *  state is built (spec 01 §9). Default `true`. `false` opts out — used by internal throwaway
   *  replicas (command rehearsal) where repair would cost O(document size) on every invocation
   *  for no benefit, since the replica is discarded immediately after. A document newer than this
   *  build (I20) is never repaired whatever this says: it must open read-only, and a build that
   *  does not understand the newer schema must not "fix" what it cannot read. */
  repair?: boolean;
}

/**
 * Element keys whose change bumps `attrsVersion` (spec 01 §10.2 / spec 02 §31.2). `scene` is here
 * for the key itself being set or removed; a change *inside* the scene map only counts when it
 * touches `omit` (see the nested-path branch in `onElements`), because everything else in there —
 * locationId, storylineIds, the scene number's own state — is not a paragraph-layout input.
 */
const ATTRS_KEYS: ReadonlySet<string> = new Set(['style', 'ov', 'num', 'scene', 'dual', 'alts', 'tc', 'lineAdjust', 'omit']);

export interface DocumentModel {
  readonly doc: Y.Doc;
  readonly docId: DocId;
  readonly deps: ModelDeps;
  template(): EmbeddedTemplateJSON;
  style(id: StyleId): StyleDef | undefined;
  resolveStyle(elementId: ElementId): ResolvedStyle;
  stylesByRole(role: StyleRole): readonly StyleDef[];
  elementCount(): number;
  elements(range?: { from?: number; to?: number }): readonly ElementView[];
  element(id: ElementId): ElementView | undefined;
  indexOf(id: ElementId): number;
  elementAt(index: number): ElementView;
  next(id: ElementId, filter?: (e: ElementView) => boolean): ElementView | undefined;
  previous(id: ElementId, filter?: (e: ElementView) => boolean): ElementView | undefined;
  textVersion(elementId: ElementId): number;
  attrsVersion(elementId: ElementId): number;
  meta(): DocumentMeta;
  writers(): readonly WriterJSON[];
  settings(): SettingsJSON;
  toJSON(): DocumentJSON;
  scenes(): readonly SceneView[];
  scene(id: ElementId): SceneView | undefined;
  sceneOf(elementId: ElementId): SceneView | undefined;
  dialogueBlocks(sceneId?: ElementId): readonly DialogueBlockView[];
  outlineTree(): OutlineNode;
  titlePage(): TitlePageView;
  entities(filter?: { kind?: EntityKind; includeHidden?: boolean }): readonly EntityView[];
  entity(id: EntityId): EntityView | undefined;
  resolveEntity(kind: EntityKind, name: string): EntityView | undefined;
  elementContentHash(elementId: ElementId): ContentHash;
  sceneContentHash(sceneId: ElementId): ContentHash;
  entityContentHash(entityId: EntityId): ContentHash;
  occurrences(entityId: EntityId): readonly OccurrenceView[];
  tags(filter?: { elementId?: ElementId; categoryId?: string; entityId?: EntityId }): readonly TagView[];
  tagCategories(): readonly TagCategoryView[];
  notes(filter?: { elementId?: ElementId; resolved?: boolean; status?: NoteStatus | readonly NoteStatus[]; source?: NoteSource; visible?: boolean }): readonly NoteView[];
  revisionState(): RevisionsJSON;
  trackChangesState(): TrackChangesJSON;
  productionState(): ProductionJSON;
  shots(sceneId?: ElementId): readonly ShotJSON[];
  beats(filter?: { board?: boolean; plotColumnId?: string; laneId?: string }): readonly BeatJSON[];
  bin(): readonly BinItemJSON[];
  bookmarks(): readonly BookmarkJSON[];
  macros(): readonly MacroRecord[];
  smartTypeSuggestions(list: SmartTypeList, prefix: string, context?: SuggestionContext): readonly Suggestion[];
  guessNextCharacter(elementId: ElementId): string | null;
  subscribe(listener: (batch: ModelChangeBatch) => void): Unsubscribe;
  dispose(): void;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/**
 * The number of words in `text` (spec 02 §6.5: word counts use UAX #29 word boundaries, the same
 * segmentation as double-click selection). A segment counts when it holds at least one letter or
 * number (general category L* or N*), so punctuation, spaces and lone dashes are not words. Uses
 * the repo's own pinned UCD tables and `wordBoundaries`, so it is deterministic (spec 02 §1.1: no
 * `Intl`, no host locale). Han text counts one word per ideograph, as UAX #29 segments it;
 * Thai/Lao/Khmer/Myanmar run without a dictionary here, so they are counted per grapheme cluster.
 */
function countWords(text: string, language: string): number {
  if (text.length === 0) return 0;
  const starts = wordBoundaries(text, language);
  let words = 0;
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]! : text.length;
    for (let j = starts[i]!; j < end;) {
      const cp = text.codePointAt(j)!;
      const category = generalCategory(cp)[0];
      if (category === 'L' || category === 'N') {
        words++;
        break;
      }
      j += cp > 0xffff ? 2 : 1;
    }
  }
  return words;
}

/** Rounds `n` to the nearest multiple of `roundTo`; `roundTo <= 1` (or not a finite number) means "exact". */
function roundToNearest(n: number, roundTo: unknown): number {
  const step = typeof roundTo === 'number' && Number.isFinite(roundTo) && roundTo > 1 ? roundTo : 1;
  return step === 1 ? n : Math.round(n / step) * step;
}

export function openDocument(doc: Y.Doc, deps: ModelDeps, options: OpenDocumentOptions = {}): DocumentModel {
  // I17's own carried finding (M1): a concurrent entity-merge cycle (two replicas each merging
  // the other into itself) makes every entity in the cycle vanish from `entities()` until this
  // runs — both have a non-null `mergedInto`, so the `mergedInto === null` filter drops them
  // all. Repairing before any read-model state is built means the initial scan, index and
  // caches below never see the broken state at all, so nothing downstream has to re-check.
  if ((options.repair ?? true) && !isNewerThanCode(doc)) validateDocument(doc).repair();

  const elementsMap = doc.getMap<unknown>('elements');
  const templateMap = doc.getMap<unknown>('template');
  const index = new OrderIndex();
  const views = new Map<string, ElementView>();
  const textVersions = new Map<string, number>();
  const attrsVersions = new Map<string, number>();
  const listeners = new Set<(batch: ModelChangeBatch) => void>();
  let templateCache: EmbeddedTemplateJSON | null = null;
  let settingsCache: SettingsJSON | null = null;
  const pending = new Map<Y.Transaction, ModelChange[]>();

  let structure: { scenes: SceneView[]; blocks: DialogueBlockView[]; tree: OutlineNode; sceneOf: Map<string, SceneView> } | null = null;
  let titlePageCache: TitlePageView | null = null;

  // Body word count for `titlePage().computed.wordCount` (spec 02 §19): the words that PRINT —
  // printable elements (`resolveStyle(...).printable`, the scene content hash's own predicate) with
  // no element-level `omit`, in a scene with no `omit`. Maintained incrementally: one scan the
  // first time it is asked for (`wordTotal === null` until then), after which `onElements` adjusts
  // it by only the elements a transaction touched — never a rescan — and a template change (rare)
  // drops it back to null for one fresh scan. `wordCounts` holds each counting element's words;
  // an element that does not print has no entry, so a text-only edit to one costs a Map lookup.
  const wordCounts = new Map<string, number>();
  let wordTotal: number | null = null;
  const wordLanguage = () => String(doc.getMap('meta').get('language') ?? deps.locale);
  /** Words in `id`'s text if it prints, else null. `sceneOmit` is read lazily: it walks back to the scene heading. */
  const printedWords = (id: string, sceneOmit: () => unknown): number | null => {
    const m = elementsMap.get(id);
    if (!(m instanceof Y.Map) || m.get('omit') != null) return null;
    const style = m.get('style') as StyleId;
    if (!template().styles.some((s) => s.id === style)) return null;
    const ov = m.get('ov') instanceof Y.Map ? ((m.get('ov') as YMap).toJSON() as ElementView['ov']) : undefined;
    if (!resolveStyle(template(), style, ov).printable || sceneOmit() != null) return null;
    const text = m.get('text');
    return text instanceof Y.Text ? countWords(readTextJSON(text).plain, wordLanguage()) : 0;
  };
  const bodyWordTotal = (): number => {
    if (wordTotal === null) {
      wordCounts.clear();
      let total = 0;
      let governing: unknown = null; // the `omit` of the scene the walk is currently inside
      for (let i = 0; i < index.size; i++) {
        const id = index.idAt(i)!;
        const role = elementRole(id);
        if (role === 'actStart') governing = null;
        else if (isSceneRole(role)) {
          const scene = (elementsMap.get(id) as YMap).get('scene');
          governing = scene instanceof Y.Map ? (scene.get('omit') ?? null) : null;
        }
        const words = printedWords(id, () => governing);
        if (words !== null) {
          wordCounts.set(id, words);
          total += words;
        }
      }
      wordTotal = total;
    }
    return wordTotal;
  };
  const invalidateStructure = () => {
    structure = null;
  };

  const entityLookup = (kind: EntityKind, name: string): EntityId | null => {
    // One rule for every producer and consumer of `nameKey` (spec 01 §7.1) — in particular the
    // document's own `meta.language`, not `deps.locale`, and full speaker normalization (extension
    // AND CONT'D) for characters.
    const key = entityNameKey(kind, name, doc);
    let found: Y.Map<unknown> | undefined;
    for (const v of doc.getMap('entities').values()) {
      const e = v as Y.Map<unknown>;
      if (e.get('kind') !== kind) continue;
      const aliases = (e.get('aliases') as Y.Array<string> | undefined)?.toArray() ?? [];
      if (e.get('nameKey') === key || aliases.some((a) => entityNameKey(kind, a, doc) === key)) {
        found = e;
        break;
      }
    }
    let guard = 0;
    while (found && typeof found.get('mergedInto') === 'string' && guard++ < 64) {
      found = doc.getMap('entities').get(found.get('mergedInto') as string) as Y.Map<unknown> | undefined;
    }
    return (found?.get('id') as EntityId | undefined) ?? null;
  };

  function structureInput(): StructureInput {
    const castCategories = new Set(
      [...doc.getMap('tagCategories').values()].filter((c) => (c as Y.Map<unknown>).get('entityKind') === 'character').map((c) => (c as Y.Map<unknown>).get('id')),
    );
    const castTagsByElement = new Map<string, EntityId[]>();
    for (const v of doc.getMap('tags').values()) {
      const t = v as Y.Map<unknown>;
      if (!castCategories.has(t.get('categoryId'))) continue;
      const list = castTagsByElement.get(String(t.get('elementId'))) ?? [];
      list.push(t.get('entityId') as EntityId);
      castTagsByElement.set(String(t.get('elementId')), list);
    }
    const st = doc.getMap('smartType');
    const listTexts = (key: string) =>
      [...((st.get(key) as Y.Map<{ text: string; pos: string }> | undefined)?.values() ?? [])].sort((a, b) => comparePositions(a.pos, b.pos)).map((e) => e.text);
    return {
      elements: model.elements(),
      sceneMap: (id) => {
        const s = (elementsMap.get(id) as Y.Map<unknown> | undefined)?.get('scene');
        return s instanceof Y.Map ? (s as Y.Map<unknown>) : undefined;
      },
      folders: [...doc.getMap('folders').values()].map((v) => (v as Y.Map<unknown>).toJSON() as StructureInput['folders'][number]),
      vocab: {
        sceneIntros: listTexts('sceneIntros'), times: listTexts('times'),
        introSeparator: String(st.get('introSeparator') ?? ' '), timeSeparator: String(st.get('timeSeparator') ?? ' - '),
        language: String(doc.getMap('meta').get('language') ?? deps.locale),
      },
      resolveEntity: entityLookup,
      castTagsByElement,
    };
  }

  function getStructure() {
    if (!structure) {
      const input = structureInput();
      const scenes = computeScenes(input);
      const sceneOf = new Map<string, SceneView>();
      for (const s of scenes) for (const id of s.elementIds) sceneOf.set(id, s);
      structure = { scenes, blocks: computeDialogueBlocks(input, scenes), tree: computeOutlineTree(input, scenes), sceneOf };
    }
    return structure;
  }

  // spec 01 §5.11: `lockedStyles` and `pageLocks`/`pagesLocked*` are distinct production concerns
  // (§31.1 re-decorates lock badges vs. page-lock anchors differently); `scenesLocked*` is a
  // third. A transaction that touches more than one category, or a key outside this table
  // (there is none today, but a future field must not silently mis-tag itself), reports 'other'.
  const PRODUCTION_WHAT: Record<string, ProductionChangeKind> = {
    lockedStyles: 'lockedStyles', pageLocks: 'pageLocks', pagesLocked: 'pageLocks', pagesLockedAt: 'pageLocks',
    scenesLocked: 'scenesLocked', scenesLockedAt: 'scenesLocked',
  };
  const classifyProduction = (keys: readonly string[]): ProductionChangeKind => {
    const whats = new Set(keys.map((k) => PRODUCTION_WHAT[k] ?? 'other'));
    return whats.size === 1 ? [...whats][0]! : 'other';
  };
  // spec 01 §5.10: `sets` is revision-set *content* (needs a refill, §25.6); every other key is a
  // *display* setting (§31.1: "revision display changes only" needs decoration only).
  const REVISIONS_WHAT: Record<string, RevisionsChangeKind> = {
    sets: 'sets', activeSetId: 'display', headerSetId: 'display', mode: 'display', display: 'display',
    selectedSetIds: 'display', showPageColor: 'display', colorRevisedText: 'display', markColumn: 'display',
  };
  const classifyRevisions = (keys: readonly string[]): RevisionsChangeKind => {
    const whats = new Set(keys.map((k) => REVISIONS_WHAT[k] ?? 'other'));
    return whats.size === 1 ? [...whats][0]! : 'other';
  };
  const COLLECTION_KINDS: Record<string, (ids: string[]) => ModelChange> = {
    titlePage: () => ({ kind: 'titlePage' }),
    entities: (ids) => ({ kind: 'entities', ids }),
    tags: (ids) => ({ kind: 'tags', ids }),
    notes: (ids) => ({ kind: 'notes', ids }),
    revisions: (ids) => ({ kind: 'revisions', what: classifyRevisions(ids) }),
    trackChanges: () => ({ kind: 'trackChanges' }),
    production: (ids) => ({ kind: 'production', what: classifyProduction(ids) }),
    folders: () => ({ kind: 'folders' }),
    beats: (ids) => ({ kind: 'beats', ids }),
    shots: (ids) => ({ kind: 'shots', ids }),
    smartType: () => ({ kind: 'smartType' }),
    bin: () => ({ kind: 'bin' }),
    bookmarks: () => ({ kind: 'bookmarks' }),
    macros: () => ({ kind: 'macros' }),
    writers: (ids) => ({ kind: 'writers', ids }),
  };
  const STRUCTURE_SOURCES = new Set(['entities', 'tags', 'folders', 'smartType', 'tagCategories']);
  const collectionObservers: [Y.Map<unknown>, (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void][] = [];
  for (const key of [...Object.keys(COLLECTION_KINDS), 'tagCategories']) {
    const map = doc.getMap<unknown>(key);
    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => {
      caches.delete(key);
      // Occurrences are derived from structure (entities/tags/folders/smartType/tagCategories
      // feed computeScenes/computeDialogueBlocks) plus a direct scan of `tags`, so only changes
      // to those collections can change what occurrences() returns; narrower invalidation avoids
      // recomputing on every unrelated collection edit (notes, revisions, production, bin, …).
      if (STRUCTURE_SOURCES.has(key)) {
        invalidateStructure();
        caches.delete('occurrences');
      }
      if (key === 'titlePage') {
        titlePageCache = null;
        // Title-page elements live outside `elements`, so `onElements` never sees them: bump
        // their textVersion/attrsVersion here, from this same deep observer on the stable
        // top-level `titlePage` map (its `elements` submap can be replaced wholesale by
        // `fromJSON`, so tracking that submap's own identity would go stale; this one never is).
        for (const event of events) {
          if (event.path[0] !== 'elements') continue;
          const id = String(event.path[1] ?? '');
          if (!id) continue;
          let bumpText = false;
          let bumpAttrs = false;
          if (event.target instanceof Y.Text && event.path.length === 3 && event.path[2] === 'text') {
            bumpText = true;
          } else if (event.path.length === 2) {
            const keys = (event as Y.YMapEvent<unknown>).keysChanged;
            bumpText = keys.has('text');
            bumpAttrs = [...keys].some((k) => ATTRS_KEYS.has(k));
          } else if (event.path.length >= 3) {
            // An edit inside a nested attrs record (`ov`, `num`, `alts`, ...) arrives with the
            // record's own key at path[2]; the body path (`onElements`) handles the same shape.
            bumpAttrs = ATTRS_KEYS.has(String(event.path[2]));
          }
          if (bumpText) textVersions.set(id, (textVersions.get(id) ?? 0) + 1);
          if (bumpAttrs) attrsVersions.set(id, (attrsVersions.get(id) ?? 0) + 1);
        }
      }
      const make = COLLECTION_KINDS[key];
      if (!make) return;
      const ids = new Set<string>();
      for (const e of events) {
        if (e.target === map) for (const k of (e as Y.YMapEvent<unknown>).keysChanged) ids.add(k);
        else if (e.path.length > 0) ids.add(String(e.path[0]));
      }
      queue(tx, make([...ids].sort()));
    };
    map.observeDeep(handler);
    collectionObservers.push([map, handler]);
  }

  for (const [id, v] of elementsMap.entries()) if (v instanceof Y.Map) index.upsert(id, String(v.get('pos')));

  const template = () => (templateCache ??= deepFreeze(readEmbeddedTemplate(doc)));

  /** The inactive alternates' own records (spec 01 §5.5), text included — not just a count. */
  function readAlts(m: YMap): readonly AltJSON[] {
    const alts = m.get('alts');
    if (!(alts instanceof Y.Map) || alts.size === 0) return [];
    return sortedRecords([...alts.values()].map((a) => {
      const am = a as YMap;
      return {
        id: am.get('id') as AltJSON['id'], pos: am.get('pos') as string, text: readTextJSON(am.get('text') as Y.Text),
        style: am.get('style') as AltJSON['style'], label: am.get('label') as string,
        createdBy: am.get('createdBy') as string, createdAt: am.get('createdAt') as number,
      } satisfies AltJSON;
    }));
  }

  /**
   * The role of an element read directly off `elementsMap`, bypassing the `view()` cache.
   * `sceneOmitFor` (below) walks backward over *other* elements while `buildView` is still
   * constructing the view for `id`; going through `view()` there would recurse into
   * `buildView` for those other ids too, which is fine, except `buildView` itself calls
   * `sceneOmitFor`, not `view`, so there is no cycle — but resolving role via `view()` would
   * still pull `sceneOmit` for elements nobody asked to look at yet, doing more work than the
   * lookup needs. Reading the role directly keeps the walk to "style + resolveStyle" only.
   */
  function elementRole(id: string): StyleRole | null {
    const m = elementsMap.get(id);
    if (!(m instanceof Y.Map)) return null;
    const style = m.get('style') as StyleId;
    return template().styles.some((s) => s.id === style) ? resolveStyle(template(), style).role : null;
  }

  /**
   * The `omit` record of the nearest preceding scene start (spec 01 §5.6's `scene.omit`),
   * walking the order index backward from `id` — never `getStructure()`, which would parse
   * folders, characters and locations for the whole document just to answer one element's
   * question. `actStart` ends the previous scene without itself starting one (spec 01 §3.4.1),
   * so hitting it first means `id` has no governing scene at all.
   */
  function sceneOmitFor(id: string): ElementView['sceneOmit'] {
    const idx = index.indexOf(id);
    if (idx < 0) return null;
    for (let i = idx; i >= 0; i--) {
      const eid = index.idAt(i)!;
      const role = elementRole(eid);
      if (role !== null && (SCENE_ROLES as readonly string[]).includes(role)) {
        const m = elementsMap.get(eid) as YMap | undefined;
        const scene = m?.get('scene');
        return scene instanceof Y.Map ? ((scene.get('omit') as ElementView['sceneOmit'] | undefined) ?? null) : null;
      }
      if (role === 'actStart') return null;
    }
    return null;
  }

  const isBoundaryRole = (role: StyleRole | null): boolean => role !== null && (SCENE_BOUNDARY_ROLES as readonly string[]).includes(role);
  const isSceneRole = (role: StyleRole | null): boolean => role !== null && (SCENE_ROLES as readonly string[]).includes(role);
  /** The role a style id resolves to in the current template, or null for a dangling id. */
  const roleOfStyle = (style: unknown): StyleRole | null =>
    typeof style === 'string' && template().styles.some((s) => s.id === style) ? resolveStyle(template(), style as StyleId).role : null;

  /**
   * The `style` a just-deleted element record last held. Yjs marks a deleted map's items deleted
   * but keeps their content until garbage collection runs, after observers, so it is still
   * readable here through the item chain (the public `get` hides deleted entries). Anything
   * unexpected yields `undefined`, which callers treat as "role unknown".
   */
  function deletedStyle(record: unknown): unknown {
    const item = (record as { _map?: Map<string, { content: { getContent(): unknown[] }; length: number }> } | undefined)?._map?.get('style');
    const value = item?.content.getContent()[item.length - 1];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Adds to `into` the elements a scene boundary at index `from` governs: from `from` up to (but
   * excluding) the next scene-boundary element, a local walk bounded by scene length, never
   * `getStructure()`. `includeFirst` says the element at `from` is itself the boundary being
   * described (a heading whose own `scene` record changed); without it, a boundary found AT
   * `from` ends the span immediately, because it starts a region of its own that this change
   * did not touch.
   */
  function collectSpan(from: number, into: Set<string>, includeFirst: boolean): void {
    for (let i = from; i < index.size; i++) {
      const eid = index.idAt(i)!;
      if (!(includeFirst && i === from) && isBoundaryRole(elementRole(eid))) break;
      into.add(eid);
    }
  }

  function buildView(id: string): ElementView | undefined {
    const m = elementsMap.get(id);
    if (!(m instanceof Y.Map)) return undefined;
    const style = m.get('style') as StyleId;
    // Only an unknown style (dangling reference, e.g. after a style deletion) resolves to a
    // null role; any other resolveStyle failure (e.g. an incomplete root chain) is a genuine
    // template bug and must propagate rather than be silently swallowed as "no role".
    const styleExists = template().styles.some((s) => s.id === style);
    const role: StyleRole | null = styleExists ? resolveStyle(template(), style).role : null;
    const alts = readAlts(m);
    const view: ElementView = {
      id: id as ElementId,
      pos: String(m.get('pos')),
      style,
      role,
      text: readTextJSON(m.get('text') as Y.Text),
      ov: m.get('ov') instanceof Y.Map ? ((m.get('ov') as YMap).toJSON() as ElementView['ov']) : {},
      num: m.get('num') instanceof Y.Map ? ((m.get('num') as YMap).toJSON() as ElementView['num']) : null,
      hasScene: m.get('scene') instanceof Y.Map,
      dual: (m.get('dual') as ElementView['dual']) ?? null,
      altCount: alts.length,
      alts,
      label: (m.get('label') as string | undefined) ?? null,
      outlineLevel: (m.get('outlineLevel') as number | undefined) ?? null,
      shotId: (m.get('shotId') as string | undefined) ?? null,
      folderId: (m.get('folderId') as string | undefined) ?? null,
      lineAdjust: (m.get('lineAdjust') as ElementView['lineAdjust']) ?? null,
      tc: (m.get('tc') as ElementView['tc']) ?? null,
      omit: (m.get('omit') as ElementView['omit']) ?? null,
      sceneOmit: sceneOmitFor(id),
      meta: m.get('meta') as ElementView['meta'],
      field: (m.get('field') as ElementView['field']) ?? null,
    };
    return deepFreeze(view);
  }

  function view(id: string): ElementView | undefined {
    let v = views.get(id);
    if (!v) {
      v = buildView(id);
      if (v) views.set(id, v);
    }
    return v;
  }

  const queue = (tx: Y.Transaction, change: ModelChange) => {
    const list = pending.get(tx) ?? [];
    list.push(change);
    pending.set(tx, list);
  };

  const onElements = (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => {
    invalidateStructure();
    caches.delete('occurrences');
    const inserted = new Set<string>();
    const removed = new Set<string>();
    const changed = new Set<string>();
    // Elements whose text may have changed, for the incremental body word count below.
    const recount = new Set<string>();
    // Governance bookkeeping (see the block after the loop): which elements may have moved between
    // scenes, or whose scene's `omit` may have changed.
    const attrsBumped = new Set<string>();
    const posMoved = new Set<string>();
    const oldStyle = new Map<string, unknown>();
    const scenesTouched = new Set<string>(); // a heading's own `scene` record was created, removed or edited
    const replaced = new Set<string>(); // whole record swapped: nothing is known about the old one
    const removedRecords = new Map<string, unknown>();
    const bump = (id: string) => {
      if (attrsBumped.has(id)) return;
      attrsBumped.add(id);
      attrsVersions.set(id, (attrsVersions.get(id) ?? 0) + 1);
    };
    let reordered = false;
    for (const event of events) {
      if (event.target === elementsMap) {
        for (const [key, change] of (event as Y.YMapEvent<unknown>).changes.keys) {
          if (change.action === 'add') inserted.add(key);
          else if (change.action === 'delete') {
            removed.add(key);
            removedRecords.set(key, change.oldValue);
          } else {
            changed.add(key);
            replaced.add(key);
            recount.add(key); // the whole record was replaced, so its text may be a different Y.Text
          }
        }
        continue;
      }
      const id = String(event.path[0]);
      if (inserted.has(id)) continue;
      changed.add(id);
      let bumpText = false;
      let bumpAttr = false;
      if (event.target instanceof Y.Text && event.path.length === 2 && event.path[1] === 'text') {
        bumpText = true;
      } else if (event.path.length === 1) {
        const ymapEvent = event as Y.YMapEvent<unknown>;
        const keys = ymapEvent.keysChanged;
        // Replacing the whole `text` key (a fresh Y.Text swapped in, e.g. by a repair or an
        // importer) is a text change too; only edits *inside* an existing Y.Text arrive on the
        // branch above, so without this the counter — and every cache keyed on it — missed it.
        bumpText = keys.has('text');
        bumpAttr = [...keys].some((k) => ATTRS_KEYS.has(k));
        if (keys.has('style') && !oldStyle.has(id)) oldStyle.set(id, ymapEvent.changes.keys.get('style')?.oldValue);
        if (keys.has('scene')) scenesTouched.add(id);
        if (keys.has('pos')) posMoved.add(id);
      } else if (event.path[1] === 'scene') {
        // Spec 02 §31.2: of the scene map, only `omit` is a paragraph-layout input.
        bumpAttr = event.path.length === 2 && (event as Y.YMapEvent<unknown>).keysChanged.has('omit');
        if (bumpAttr) scenesTouched.add(id);
      } else {
        bumpAttr = ATTRS_KEYS.has(String(event.path[1]));
      }
      if (bumpText) {
        textVersions.set(id, (textVersions.get(id) ?? 0) + 1);
        recount.add(id);
      }
      if (bumpAttr) bump(id);
    }
    // Scene governance (`ElementView.sceneOmit`, spec 01 §10.2). An element's governing scene is
    // the nearest preceding scene heading, so anything that adds, removes, moves or re-roles a
    // heading (or an act start, which ends a scene) changes the governance of every element up to
    // the NEXT boundary, none of which has an event of its own. Collect exactly that span:
    //   anchors  - "the old span": the elements that followed a removed / moved boundary, found from
    //              the still-present element before it (taken BEFORE the index is mutated);
    //   starts   - "the new span": boundaries that now exist (inserted, moved, restyled into a scene
    //              role, or whose own scene record changed).
    // Only boundaries qualify: inserting, deleting or restyling an ordinary paragraph touches no
    // one else, which keeps a routine edit from flushing the layout cache for its whole scene.
    const anchors: (string | null)[] = [];
    const starts: { id: string; includeFirst: boolean }[] = [];
    const skip = new Set<string>([...removed, ...posMoved, ...replaced]);
    const anchorBefore = (id: string): string | null => {
      for (let i = index.indexOf(id) - 1; i >= 0; i--) {
        const eid = index.idAt(i)!;
        if (!skip.has(eid)) return eid;
      }
      return null;
    };
    for (const id of removed) {
      // A cached view knows the role the element HAD (its record is already gone); failing that,
      // the deleted record's own last `style`; with neither the role is unknowable, so assume it
      // was a boundary.
      const known = views.get(id);
      const role = known ? known.role : roleOfStyle(deletedStyle(removedRecords.get(id)));
      if ((!known && role === null) || isBoundaryRole(role)) anchors.push(anchorBefore(id));
    }
    for (const id of new Set([...posMoved, ...replaced])) {
      if (removed.has(id) || index.indexOf(id) < 0) continue;
      const wasBoundary = replaced.has(id) || isBoundaryRole(roleOfStyle(oldStyle.has(id) ? oldStyle.get(id) : (elementsMap.get(id) as YMap | undefined)?.get('style')));
      if (wasBoundary || isBoundaryRole(elementRole(id))) anchors.push(anchorBefore(id));
    }
    // A moved element's own governing scene may change with no attrs event at all (`pos` is not an
    // attrs key), so compare what it used to report; an unread view has nothing to compare with.
    const oldOwnOmit = new Map<string, ElementView['sceneOmit'] | undefined>();
    for (const id of posMoved) oldOwnOmit.set(id, views.get(id)?.sceneOmit);

    for (const id of inserted) {
      const m = elementsMap.get(id);
      if (m instanceof Y.Map) index.upsert(id, String(m.get('pos')));
      reordered = true;
    }
    for (const id of removed) {
      index.remove(id);
      views.delete(id);
      // The counters are a per-id HIGH-WATER MARK, never reset: element ids are reused (undo,
      // a rejected tracked delete, an import that re-materializes the same record), and resetting
      // to 0 would hand a paragraph cache — or the hash memo below — the same key for different
      // content. Bumping on removal also guarantees the recreated element gets a fresh key. The
      // maps therefore grow with the number of distinct ids seen this session, which is bounded by
      // the document's edit history and is in-memory only.
      textVersions.set(id, (textVersions.get(id) ?? 0) + 1);
      attrsVersions.set(id, (attrsVersions.get(id) ?? 0) + 1);
      hashMemo.delete(id);
      reordered = true;
    }
    for (const id of changed) {
      const m = elementsMap.get(id);
      if (m instanceof Y.Map) index.upsert(id, String(m.get('pos')));
      views.delete(id);
    }

    for (const id of inserted) {
      if (isBoundaryRole(elementRole(id))) starts.push({ id, includeFirst: false });
    }
    for (const id of new Set([...posMoved, ...replaced, ...oldStyle.keys()])) {
      if (removed.has(id) || index.indexOf(id) < 0) continue;
      const role = elementRole(id);
      if (replaced.has(id) || isBoundaryRole(role) || isBoundaryRole(roleOfStyle(oldStyle.get(id)))) starts.push({ id, includeFirst: false });
    }
    // A heading's own `scene` record: created (with or without `omit` inside it), removed, or its
    // `omit` edited. `includeFirst`: the heading itself is governed by that record too.
    for (const id of scenesTouched) {
      if (removed.has(id) || index.indexOf(id) < 0) continue;
      if (isSceneRole(elementRole(id))) starts.push({ id, includeFirst: true });
    }
    const affected = new Set<string>();
    for (const anchor of anchors) collectSpan(anchor === null ? 0 : Math.max(0, index.indexOf(anchor) + 1), affected, false);
    for (const { id, includeFirst } of starts) collectSpan(index.indexOf(id) + (includeFirst ? 0 : 1), affected, includeFirst);
    for (const [id, was] of oldOwnOmit) {
      if (removed.has(id) || index.indexOf(id) < 0) continue;
      if (was === undefined || JSON.stringify(was) !== JSON.stringify(sceneOmitFor(id))) affected.add(id);
    }
    for (const id of affected) {
      if (removed.has(id) || index.indexOf(id) < 0) continue;
      views.delete(id);
      if (inserted.has(id)) continue;
      bump(id);
      changed.add(id);
    }
    // Body word count (spec 02 §19): once asked for, adjust the running total by exactly the
    // elements this transaction touched. What decides whether an element prints (style, `ov`,
    // element `omit`, its scene's `omit`, scene membership) all surface here as an inserted,
    // moved, replaced or attrs-bumped id (the governance pass above bumps every element whose
    // scene changed), so those recompute whether they print; a text-only edit recounts words only
    // when the element already prints.
    if (wordTotal !== null) {
      const before = wordTotal;
      const settle = (id: string, words: number | null) => {
        wordTotal! += (words ?? 0) - (wordCounts.get(id) ?? 0);
        if (words === null) wordCounts.delete(id);
        else wordCounts.set(id, words);
      };
      for (const id of removed) settle(id, null);
      const flagsMayHaveChanged = new Set<string>([...inserted, ...attrsBumped, ...posMoved, ...replaced]);
      for (const id of flagsMayHaveChanged) if (index.indexOf(id) >= 0) settle(id, printedWords(id, () => sceneOmitFor(id)));
      for (const id of recount) if (!flagsMayHaveChanged.has(id) && wordCounts.has(id)) settle(id, printedWords(id, () => null));
      if (wordTotal !== before) titlePageCache = null;
    }
    queue(tx, { kind: 'elements', inserted: [...inserted].sort(), removed: [...removed].sort(), changed: [...changed].filter((id) => !removed.has(id)).sort(), reordered });
  };

  const onTemplate = (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => {
    invalidateStructure();
    caches.delete('occurrences');
    templateCache = null;
    // Clear every cached view rather than diffing which elements are affected: template edits
    // are rare, but a single style edit (e.g. changing its `role`) can change the resolved role
    // of any element that references it, directly or via `basedOn`/`paginateAs`, so a targeted
    // invalidation would have to replicate the whole resolution chain just to be an optimization.
    views.clear();
    // Any template edit can change which styles print; rescan lazily on the next ask (spec 02 §19).
    wordTotal = null;
    wordCounts.clear();
    titlePageCache = null;
    const styleIds = new Set<string>();
    let all = false;
    for (const event of events) {
      if ((event.path[0] === 'styles' || event.path[0] === 'titlePageStyles') && event.path.length >= 2) styleIds.add(String(event.path[1]));
      else all = true;
    }
    queue(tx, { kind: 'template', styleIds: all ? 'all' : [...styleIds].sort() });
  };

  const onSettings = (e: Y.YMapEvent<unknown>, tx: Y.Transaction) => {
    settingsCache = null;
    // spec 01 §5.18: `watermark` is the only settings field spec 02 draws as a header/footer
    // decoration (§20.1 `{watermark.recipient}`); every other field either doesn't reach layout
    // at all or needs more than re-decoration, so it is conservatively 'other'.
    const keys = [...e.keysChanged];
    const what: SettingsChangeKind = keys.length === 1 && keys[0] === 'watermark' ? 'watermark' : 'other';
    queue(tx, { kind: 'settings', what });
  };

  const afterTransaction = (tx: Y.Transaction) => {
    const changes = pending.get(tx);
    if (!changes) return;
    pending.delete(tx);
    const batch: ModelChangeBatch = { changes, origin: tx.origin, local: tx.local };
    for (const l of listeners) l(batch);
  };

  elementsMap.observeDeep(onElements);
  templateMap.observeDeep(onTemplate);
  doc.getMap('settings').observe(onSettings);
  doc.on('afterTransaction', afterTransaction);

  const docId = doc.getMap('meta').get('docId') as DocId;

  const caches = new Map<string, unknown>();
  const cached = <T>(key: string, compute: () => T): T => {
    if (!caches.has(key)) caches.set(key, deepFreeze(compute()));
    return caches.get(key) as T;
  };
  const entityRecords = () => cached('entities', () => readCollection(doc, 'entities', readEntity));

  /** Follows `mergedInto` to the id of the entity a raw (possibly stale) id ultimately resolves to. */
  const followId = (id: string): string => {
    let cur = entityRecords().find((e) => e.id === id);
    let guard = 0;
    while (cur?.mergedInto && guard++ < 64) cur = entityRecords().find((e) => e.id === cur!.mergedInto);
    return cur?.id ?? id;
  };

  /** `hidden` is always derived the same way, everywhere an EntityView is produced. */
  const computeHidden = (e: EntityJSON): boolean => e.origin === 'harvested' && !e.retain && !(occurrenceMap().get(e.id)?.length);
  const toView = (e: EntityJSON): EntityView => ({ ...e, hidden: computeHidden(e) } as EntityView);

  function occurrenceMap(): Map<string, OccurrenceView[]> {
    return cached('occurrences', () => {
      const raw = new Map<string, OccurrenceView[]>();
      const add = (entityId: string | null, o: OccurrenceView) => {
        if (!entityId) return;
        raw.set(entityId, [...(raw.get(entityId) ?? []), o]);
      };
      const s = getStructure();
      for (const b of s.blocks) add(b.entityId, { sceneId: b.sceneId, elementId: b.speakerId, source: 'speaker', range: null });
      for (const scene of s.scenes) add(scene.locationId, { sceneId: scene.id, elementId: scene.id, source: 'heading', range: null });
      for (const tag of model.tags()) {
        const el = elementsMap.get(tag.elementId) as YMap | undefined;
        const text = el?.get('text');
        const mark = text instanceof Y.Text ? scanText(text).marks.find((m) => m.key === `t:${tag.id}`) : undefined;
        // Follow merges: a tag written against an entity that was later merged into another one
        // must still surface as an occurrence of the surviving (canonical) entity.
        add(followId(tag.entityId), { sceneId: s.sceneOf.get(tag.elementId)?.id ?? null, elementId: tag.elementId, source: 'tag', range: mark ? { index: mark.index, length: mark.length } : null });
      }
      // The three passes above append per-source, so an entity with occurrences from more than
      // one source would otherwise come back grouped by source; resort into true document order
      // by the position of the owning element, tie-broken by in-element range and finally by
      // source so the result never depends on iteration order.
      const SOURCE_ORDER: Record<OccurrenceView['source'], number> = { speaker: 0, heading: 1, tag: 2 };
      const map = new Map<string, OccurrenceView[]>();
      for (const [entityId, occs] of raw) {
        map.set(entityId, [...occs].sort((a, b) =>
          index.indexOf(a.elementId) - index.indexOf(b.elementId)
          || (a.range?.index ?? -1) - (b.range?.index ?? -1)
          || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]));
      }
      return map;
    });
  }

  const follow = (e: EntityView | undefined): EntityView | undefined => {
    if (!e) return undefined;
    const id = followId(e.id);
    if (id === e.id) return e;
    const target = entityRecords().find((x) => x.id === id);
    return target ? toView(target) : undefined;
  };

  const hashMemo = new Map<string, { key: string; hash: ContentHash }>();
  function memoHash(id: string, key: string, compute: () => ContentHash): ContentHash {
    const hit = hashMemo.get(id);
    if (hit && hit.key === key) return hit.hash;
    const hash = compute();
    hashMemo.set(id, { key, hash });
    return hash;
  }
  function elementHash(id: ElementId, withDual: boolean): ContentHash {
    const view = model.element(id);
    if (!view) throw new Error(`unknown element ${id}`);
    let dual: { side: 'left' | 'right'; partnerHash: string } | null = null;
    const own = view.dual;
    // A malformed `dual` (I7's own subject: the group missing, or the record not an object at all)
    // must not crash the hash. Comparing `e.dual?.group === own.group` made every element WITHOUT a
    // dual a "member" as soon as `own.group` was undefined, and the very next line dereferenced
    // `e.dual.side` on null.
    if (withDual && own && typeof own.group === 'string' && (own.side === 'left' || own.side === 'right')) {
      const partnerFirst = model.elements().find((e) => e.dual !== null && e.dual.group === own.group && e.dual.side !== own.side);
      if (partnerFirst) dual = { side: own.side, partnerHash: elementHash(partnerFirst.id, false) };
    }
    return elementContentHash({ role: view.role ?? 'normal', style: view.style, text: view.text, dual });
  }

  const model: DocumentModel = {
    doc,
    docId,
    deps,
    template,
    style: (id) => template().styles.find((s) => s.id === id),
    resolveStyle(elementId) {
      const m = elementsMap.get(elementId) as YMap | undefined;
      if (m) {
        const ov = m.get('ov') instanceof Y.Map ? ((m.get('ov') as YMap).toJSON() as ElementView['ov']) : undefined;
        return resolveStyle(template(), m.get('style') as StyleId, ov);
      }
      // Title-page elements are not in the body order index (spec 02 §19 is a separate flow),
      // so a miss above falls back to `titlePage.elements`, resolving against `titlePageStyles`
      // the same way `titlePage()` already does for its own views.
      const tpElements = doc.getMap<unknown>('titlePage').get('elements');
      const tm = tpElements instanceof Y.Map ? (tpElements.get(elementId) as YMap | undefined) : undefined;
      if (!tm) throw new Error(`unknown element ${elementId}`);
      const ov = tm.get('ov') instanceof Y.Map ? ((tm.get('ov') as YMap).toJSON() as ElementView['ov']) : undefined;
      const tpTemplate = { ...template(), styles: template().titlePageStyles };
      return resolveStyle(tpTemplate, tm.get('style') as StyleId, ov);
    },
    stylesByRole: (role) => template().styles.filter((s) => s.role === role),
    elementCount: () => index.size,
    elements: (range = {}) => index.ids(range.from ?? 0, range.to ?? index.size).map((id) => view(id)!),
    element: (id) => view(id),
    indexOf: (id) => index.indexOf(id),
    elementAt(i) {
      const id = index.idAt(i);
      if (id === undefined) throw new RangeError(`no element at ${i}`);
      return view(id)!;
    },
    next(id, filter) {
      for (let i = index.indexOf(id) + 1; i > 0 && i < index.size; i++) {
        const v = view(index.idAt(i)!)!;
        if (!filter || filter(v)) return v;
      }
      return undefined;
    },
    previous(id, filter) {
      for (let i = index.indexOf(id) - 1; i >= 0; i--) {
        const v = view(index.idAt(i)!)!;
        if (!filter || filter(v)) return v;
      }
      return undefined;
    },
    textVersion: (id) => textVersions.get(id) ?? 0,
    attrsVersion: (id) => attrsVersions.get(id) ?? 0,
    // `meta` (spec 01 §5.2) is a fixed handful of scalar keys, not a growing collection — it
    // costs nothing relative to document size to read fresh every call, so unlike `settings`
    // (cached below) it needs no cache or dedicated observer to stay "incremental".
    meta: () => doc.getMap('meta').toJSON() as DocumentMeta,
    writers: () => cached('writers', () => [...doc.getMap<unknown>('writers').values()]
      .filter((v): v is YMap => v instanceof Y.Map)
      .map((m) => m.toJSON() as WriterJSON)
      .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))),
    settings: () => (settingsCache ??= deepFreeze(doc.getMap('settings').toJSON() as SettingsJSON)),
    toJSON: () => documentToJSON(doc),
    scenes: () => getStructure().scenes,
    scene: (id) => getStructure().scenes.find((s) => s.id === id),
    sceneOf: (elementId) => getStructure().sceneOf.get(elementId),
    dialogueBlocks: (sceneId) => (sceneId ? getStructure().blocks.filter((b) => b.sceneId === sceneId) : getStructure().blocks),
    outlineTree: () => getStructure().tree,
    titlePage() {
      if (!titlePageCache) {
        const tp = doc.getMap<unknown>('titlePage');
        const elements = tp.get('elements') instanceof Y.Map ? (tp.get('elements') as Y.Map<unknown>) : new Y.Map<unknown>();
        const tpTemplate = { ...template(), styles: template().titlePageStyles };
        // `orderElements` is THE document order — `pos`, then id. Sorting on `pos` alone left two
        // title-page elements that share a position (a concurrent insert on two replicas) in
        // whatever order the Y.Map happened to iterate, which differs per replica.
        const views = orderElements(elements)
          .map((m) => {
            const text = readTextJSON(m.get('text') as Y.Text);
            const style = m.get('style') as StyleId;
            // Only an unknown style (dangling reference, e.g. after a style deletion) resolves to a
            // null role; any other resolveStyle failure (e.g. an incomplete root chain) is a genuine
            // template bug and must propagate rather than be silently swallowed as "no role" —
            // matching buildView's handling of body elements.
            const styleExists = tpTemplate.styles.some((s) => s.id === style);
            const role: StyleRole | null = styleExists ? resolveStyle(tpTemplate, style).role : null;
            return deepFreeze({
              id: m.get('id') as ElementId, pos: String(m.get('pos')), style, role, text,
              ov: m.get('ov') instanceof Y.Map ? (m.get('ov') as Y.Map<unknown>).toJSON() : {}, num: null, hasScene: false, dual: null,
              altCount: 0, alts: [], label: null, outlineLevel: null, shotId: null, folderId: null, lineAdjust: null, tc: null, omit: null,
              sceneOmit: null, meta: m.get('meta') as ElementView['meta'], field: (m.get('field') as ElementView['field']) ?? null,
            } satisfies ElementView);
          });
        const fields: TitlePageView['fields'] = {};
        const fieldMap = tp.get('fields');
        if (fieldMap instanceof Y.Map) {
          for (const [field, id] of fieldMap.entries()) {
            const v = views.find((e) => e.id === id);
            if (v) fields[field as keyof TitlePageView['fields']] = { elementId: v.id, text: v.text.plain };
          }
        }
        // spec 02 §19: "the computed `wordCount` field is replaced at layout time by the body
        // word count rounded per `titlePage.computed.wordCount.roundTo`" — read that config from
        // the stored record (an author- or template-set value, `{ roundTo: number }`), default
        // `roundTo` to 1 (exact) when absent, and replace it with the live rounded count.
        const computedMap = tp.get('computed');
        const storedComputed = computedMap instanceof Y.Map ? (computedMap.toJSON() as Record<string, unknown>) : {};
        const wordCountConfig = storedComputed.wordCount;
        const roundTo = wordCountConfig && typeof wordCountConfig === 'object' ? (wordCountConfig as { roundTo?: unknown }).roundTo : undefined;
        const computed = { ...storedComputed, wordCount: roundToNearest(bodyWordTotal(), roundTo) } as TitlePageView['computed'];
        titlePageCache = deepFreeze({ elements: views, fields, computed });
      }
      return titlePageCache;
    },
    entities(filter = {}) {
      const all = entityRecords().filter((e) => e.mergedInto === null && (!filter.kind || e.kind === filter.kind));
      const withHidden = all.map(toView);
      const visible = filter.includeHidden ? withHidden : withHidden.filter((e) => !e.hidden);
      // `new Intl.Collator` is banned by the platform-free guard; `localeCompare` with an
      // explicit locale gives the same base-sensitivity comparison.
      return visible.sort((a, b) => a.name.localeCompare(b.name, deps.locale, { sensitivity: 'base' }));
    },
    entity(id) {
      const e = entityRecords().find((x) => x.id === id);
      return e ? follow(toView(e)) : undefined;
    },
    resolveEntity(kind, name) {
      const found = entityLookup(kind, name);
      return found ? model.entity(found) : undefined;
    },
    elementContentHash: (id) => memoHash(id, `${model.textVersion(id)}:${model.attrsVersion(id)}:${model.template().revision}:${model.element(id)?.dual ? model.elements().map((e) => `${e.id}.${model.textVersion(e.id)}.${model.attrsVersion(e.id)}`).join(',') : ''}`, () => elementHash(id, true)),
    sceneContentHash(sceneId) {
      const scene = model.scene(sceneId);
      if (!scene) throw new Error(`unknown scene ${sceneId}`);
      const key = `${scene.omitted}:${scene.elementIds.map((id) => `${id}.${model.textVersion(id)}.${model.attrsVersion(id)}`).join(',')}:${model.template().revision}`;
      return memoHash(`scene:${sceneId}`, key, () => sceneContentHash({
        omitted: scene.omitted,
        elements: scene.elementIds.map((id) => ({ hash: model.elementContentHash(id), printable: model.resolveStyle(id).printable })),
      }));
    },
    entityContentHash(entityId) {
      const target = model.entity(entityId);
      if (!target) throw new Error(`unknown entity ${entityId}`);
      return entityContentHash(target);
    },
    occurrences: (entityId) => occurrenceMap().get(entityId) ?? [],
    tags(filter = {}) {
      const all = cached('tags', () => readCollection(doc, 'tags', (m) => m.toJSON() as TagView));
      // `t.entityId` may reference an entity that has since been merged into another one; follow
      // the merge chain so filtering by the surviving (canonical) entity still matches it.
      return all.filter((t) => (!filter.elementId || t.elementId === filter.elementId) && (!filter.categoryId || t.categoryId === filter.categoryId) && (!filter.entityId || followId(t.entityId) === filter.entityId));
    },
    tagCategories: () => cached('tagCategories', () => readCollection(doc, 'tagCategories', (m) => m.toJSON() as TagCategoryView)),
    notes(filter = {}) {
      const all = cached('notes', () => readCollection(doc, 'notes', readNote).map(normalizeNote));
      return all.filter((n) => {
        if (filter.resolved !== undefined && (n.resolved !== null) !== filter.resolved) return false;
        if (filter.visible !== undefined && ((n.status === 'pending' || n.status === 'todo') !== filter.visible)) return false;
        if (filter.status !== undefined) {
          const want = Array.isArray(filter.status) ? filter.status : [filter.status];
          if (!want.includes(n.status)) return false;
        }
        if (filter.source !== undefined && n.source !== filter.source) return false;
        if (!filter.elementId) return true;
        const a = n.anchor;
        return (a.kind === 'element' || a.kind === 'scene') && a.elementId === filter.elementId;
      });
    },
    revisionState: () => cached('revisions', () => {
      const rev = doc.getMap<unknown>('revisions');
      const sets = rev.get('sets');
      const list = sets instanceof Y.Map
        ? [...(sets as YMap).values()].map((s) => (s as YMap).toJSON() as RevisionsJSON['sets'][number]).sort((a, b) => comparePositions(a.pos, b.pos))
        : [];
      return { ...(rev.toJSON() as RevisionsJSON), sets: list };
    }),
    trackChangesState: () => cached('trackChanges', () => doc.getMap('trackChanges').toJSON() as TrackChangesJSON),
    productionState: () => cached('production', () => {
      const prod = doc.getMap<unknown>('production');
      const json = prod.toJSON() as Record<string, unknown>;
      return {
        ...(json as unknown as ProductionJSON),
        lockedStyles: Object.keys((json.lockedStyles as Record<string, true>) ?? {}).sort() as ProductionJSON['lockedStyles'],
        pageLocks: Object.values((json.pageLocks as Record<string, ProductionJSON['pageLocks'][number]>) ?? {}),
      };
    }),
    shots: (sceneId) => cached('shots', () => readCollection(doc, 'shots', (m) => readTextKeyed<ShotJSON>(m, ['description'], []))).filter((s) => !sceneId || s.sceneId === sceneId),
    beats(filter = {}) {
      const all = cached('beats', () => readCollection(doc, 'beats', (m) => readTextKeyed<BeatJSON>(m, ['title', 'body'], ['storylineIds'])));
      return all.filter((b) => (filter.board === undefined || (b.board !== null) === filter.board) && (!filter.plotColumnId || b.plot?.columnId === filter.plotColumnId) && (!filter.laneId || b.lane?.laneId === filter.laneId));
    },
    bin: () => cached('bin', () => readCollection(doc, 'bin', (m) => m.toJSON() as BinItemJSON)),
    bookmarks: () => cached('bookmarks', () => readCollection(doc, 'bookmarks', (m) => m.toJSON() as BookmarkJSON)),
    macros: () => cached('macros', () => readCollection(doc, 'macros', (m) => m.toJSON() as MacroRecord)),
    smartTypeSuggestions(list, prefix) {
      const language = String(doc.getMap('meta').get('language') ?? deps.locale);
      const st = doc.getMap<unknown>('smartType');
      const sortMode = (st.get('sortMode') as 'alphabetical' | 'custom' | 'frequency') ?? 'alphabetical';
      const dismissed = st.get('dismissed') instanceof Y.Map ? (st.get('dismissed') as YMap) : null;
      if (list === 'characters' || list === 'locations') {
        const kind = list === 'characters' ? 'character' : 'location';
        const occ = occurrenceMap();
        const items: Suggestion[] = model.entities({ kind }).flatMap((e) => {
          const names = [e.name, ...e.aliases];
          const reading = typeof e.attributes['smartType.reading'] === 'string' ? (e.attributes['smartType.reading'] as string) : null;
          const hit = names.some((n) => matchesPrefix(n, prefix, language)) || (reading !== null && matchesPrefix(reading, prefix, language));
          return hit ? [{ text: e.name, key: e.nameKey, source: 'entity' as const, entityId: e.id, count: occ.get(e.id)?.length ?? 0 }] : [];
        });
        return rankSuggestions(items, sortMode === 'custom' ? 'alphabetical' : sortMode, language);
      }
      const entries = st.get(list);
      if (!(entries instanceof Y.Map)) return [];
      const order = new Map<string, string>();
      const items: Suggestion[] = [];
      for (const [key, v] of (entries as YMap).entries()) {
        const entry = v as { text: string; pos: string; count: number };
        if (dismissed?.has(`${list}:${key}`)) continue;
        if (!matchesPrefix(entry.text, prefix, language)) continue;
        order.set(key, entry.pos);
        items.push({ text: entry.text, key, source: 'list', entityId: null, count: entry.count });
      }
      return rankSuggestions(items, sortMode, language, order);
    },
    guessNextCharacter(elementId) {
      const scene = model.sceneOf(elementId);
      const index = model.indexOf(elementId);
      const blocks = model.dialogueBlocks(scene?.id).filter((b) => b.speakerId !== elementId && model.indexOf(b.speakerId) < index);
      if (blocks.length >= 2) return blocks[blocks.length - 2]!.name;
      const counts = new Map<string, number>();
      for (const b of blocks) counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      elementsMap.unobserveDeep(onElements);
      templateMap.unobserveDeep(onTemplate);
      doc.getMap('settings').unobserve(onSettings);
      doc.off('afterTransaction', afterTransaction);
      for (const [map, handler] of collectionObservers) map.unobserveDeep(handler);
      listeners.clear();
    },
  };
  return model;
}
