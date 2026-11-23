import * as Y from 'yjs';
import type { IdSource } from '../ids/id-source.js';
import { type DocId, newId } from '../ids/ids.js';
import type {
  AltJSON, BeatJSON, DocumentJSON, ElementJSON, FolderJSON, NoteJSON, SceneJSON, ShotJSON, SmartTypeEntryJSON,
  SuggestionSetJSON,
} from '../schema/document.js';
import type { EntityJSON } from '../schema/entities.js';
import type { TextJSON } from '../schema/text.js';
import { STORED_SMARTTYPE_LISTS, type EntityKind } from '../schema/vocab.js';
import { embedTemplate, readEmbeddedTemplate } from './embed-template.js';
import { systemOrigin } from './origins.js';
import { comparePositions, generatePositions } from './positions.js';
import { fromPortablePos, toPortablePos } from './portable-pos.js';
import { remapDocumentIds } from './remap-ids.js';
import { childMap, orderElements, setJSONMap, sortedRecords } from './ymap.js';
import { readTextJSON, writeTextJSON } from './ytext.js';

type YMap = Y.Map<unknown>;

const ENTITY_TEXT_FIELDS: Partial<Record<EntityKind, readonly string[]>> = {
  character: ['bio', 'physicalDescription', 'personality', 'arc'],
  location: ['setDescription'],
};

// ---------- small readers/writers ----------

const text = (map: YMap, key: string): TextJSON => readTextJSON(map.get(key) as Y.Text);
function newText(parent: YMap, key: string, value: TextJSON): void {
  writeTextJSON(parent.set(key, new Y.Text()), value);
}
const keysOf = (map: YMap | undefined): string[] => (map ? [...map.keys()].sort() : []);
function setKeyMap(parent: YMap, key: string, keys: readonly string[]): void {
  const m = parent.set(key, new Y.Map<unknown>());
  for (const k of keys) m.set(k, true);
}
function flatRecords<T extends { id: string }>(map: YMap): T[] {
  return sortedRecords([...map.values()].map((v) => (v as YMap).toJSON() as T));
}
function writeFlatRecords(map: YMap, records: readonly { id: string }[]): void {
  for (const r of records) setJSONMap(map, r.id, r as Record<string, unknown>);
}

// ---------- elements ----------

function readScene(scene: YMap): SceneJSON {
  const versions = (scene.get('versions') as Y.Array<YMap> | undefined)?.toArray().map((v) => v.toJSON()) ?? [];
  const arcBeats: Record<string, TextJSON> = {};
  const arc = scene.get('arcBeats') as YMap | undefined;
  for (const k of keysOf(arc)) arcBeats[k] = readTextJSON(arc!.get(k) as Y.Text);
  return {
    synopsis: text(scene, 'synopsis'), color: (scene.get('color') as string | null) ?? null, title: (scene.get('title') as string) ?? '',
    locationId: (scene.get('locationId') as never) ?? null, storyDay: (scene.get('storyDay') as string) ?? '', arcBeats: arcBeats as never,
    storylineIds: keysOf(scene.get('storylineIds') as YMap) as never, omit: (scene.get('omit') as never) ?? null,
    versions: versions as never, estimatedSeconds: (scene.get('estimatedSeconds') as number | null) ?? null,
  };
}

function writeScene(record: YMap, scene: SceneJSON): void {
  const m = record.set('scene', new Y.Map<unknown>());
  newText(m, 'synopsis', scene.synopsis);
  m.set('color', scene.color);
  m.set('title', scene.title);
  m.set('locationId', scene.locationId);
  m.set('storyDay', scene.storyDay);
  const arc = m.set('arcBeats', new Y.Map<unknown>());
  for (const [k, v] of Object.entries(scene.arcBeats)) newText(arc, k, v);
  setKeyMap(m, 'storylineIds', scene.storylineIds);
  m.set('omit', scene.omit);
  const versions = m.set('versions', new Y.Array<YMap>());
  versions.push(scene.versions.map((v) => {
    const vm = new Y.Map<unknown>();
    for (const [k, val] of Object.entries(v)) vm.set(k, val);
    return vm;
  }));
  m.set('estimatedSeconds', scene.estimatedSeconds);
}

const OPTIONAL_JSON_KEYS = ['dual', 'label', 'outlineLevel', 'shotId', 'folderId', 'lineAdjust', 'tc', 'omit', 'importMeta', 'field'] as const;

export function readElementRecord(map: YMap): ElementJSON {
  const el: Record<string, unknown> = { id: map.get('id'), style: map.get('style'), text: text(map, 'text') };
  const ov = map.get('ov') as YMap | undefined;
  if (ov && ov.size > 0) el.ov = ov.toJSON();
  const num = map.get('num') as YMap | undefined;
  if (num) el.num = num.toJSON();
  const scene = map.get('scene') as YMap | undefined;
  if (scene) el.scene = readScene(scene);
  const alts = map.get('alts') as YMap | undefined;
  if (alts && alts.size > 0) {
    el.alts = sortedRecords([...alts.values()].map((a) => {
      const am = a as YMap;
      return { id: am.get('id'), pos: am.get('pos'), text: text(am, 'text'), style: am.get('style'), label: am.get('label'), createdBy: am.get('createdBy'), createdAt: am.get('createdAt') } as AltJSON;
    }));
  }
  for (const k of OPTIONAL_JSON_KEYS) if (map.has(k)) el[k] = map.get(k);
  el.meta = map.get('meta');
  return el as ElementJSON;
}

export function writeElementRecord(parent: YMap, el: ElementJSON, pos: string): YMap {
  const m = parent.set(el.id, new Y.Map<unknown>());
  m.set('id', el.id);
  m.set('pos', pos);
  m.set('style', el.style);
  newText(m, 'text', el.text);
  if (el.ov) setJSONMap(m, 'ov', el.ov);
  if (el.num) setJSONMap(m, 'num', el.num);
  if (el.scene) writeScene(m, el.scene);
  if (el.alts) {
    const alts = m.set('alts', new Y.Map<unknown>());
    for (const a of el.alts) {
      const am = alts.set(a.id, new Y.Map<unknown>());
      am.set('id', a.id); am.set('pos', a.pos); newText(am, 'text', a.text); am.set('style', a.style);
      am.set('label', a.label); am.set('createdBy', a.createdBy); am.set('createdAt', a.createdAt);
    }
  }
  for (const k of OPTIONAL_JSON_KEYS) if (el[k] !== undefined) m.set(k, el[k]);
  m.set('meta', el.meta);
  return m;
}

function readElementList(map: YMap): ElementJSON[] {
  return orderElements(map).map(readElementRecord);
}

function writeElementList(map: YMap, elements: readonly ElementJSON[]): void {
  const positions = generatePositions(elements.length, null, null, null);
  elements.forEach((el, i) => writeElementRecord(map, el, positions[i]!));
}

// ---------- rich records ----------

export function readEntity(m: YMap): EntityJSON {
  const kind = m.get('kind') as EntityKind;
  const fieldsMap = m.get('fields') as YMap;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of fieldsMap.entries()) {
    fields[k] = v instanceof Y.Text ? readTextJSON(v) : v instanceof Y.Map ? v.toJSON() : v;
  }
  return {
    id: m.get('id'), kind, name: m.get('name'), nameKey: m.get('nameKey'), aliases: (m.get('aliases') as Y.Array<string>).toArray(),
    color: m.get('color'), description: text(m, 'description'), fields, attributes: (m.get('attributes') as YMap).toJSON(),
    categoryId: m.get('categoryId'), retain: m.get('retain'), mergedInto: m.get('mergedInto'), createdBy: m.get('createdBy'),
    createdAt: m.get('createdAt'), origin: m.get('origin'),
  } as EntityJSON;
}

export function writeEntity(parent: YMap, e: EntityJSON): YMap {
  const m = parent.set(e.id, new Y.Map<unknown>());
  for (const k of ['id', 'kind', 'name', 'nameKey', 'color', 'categoryId', 'retain', 'mergedInto', 'createdBy', 'createdAt', 'origin'] as const) m.set(k, e[k]);
  m.set('aliases', Y.Array.from(e.aliases));
  newText(m, 'description', e.description);
  const fields = m.set('fields', new Y.Map<unknown>());
  const textKeys = ENTITY_TEXT_FIELDS[e.kind] ?? [];
  for (const [k, v] of Object.entries(e.fields)) {
    if (textKeys.includes(k)) newText(fields, k, v as TextJSON);
    else if (k === 'traits') setJSONMap(fields, k, v as Record<string, unknown>);
    else fields.set(k, v);
  }
  setJSONMap(m, 'attributes', e.attributes);
  return m;
}

export function readNote(m: YMap): NoteJSON {
  const out: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) {
    if (k === 'body') out.body = readTextJSON(v as Y.Text);
    // `suggestion` is a nullable rich-text field (concrete action for the comment).
    else if (k === 'suggestion') out.suggestion = v instanceof Y.Text ? readTextJSON(v) : null;
    else if (k === 'replies') {
      out.replies = (v as Y.Array<YMap>).toArray().map((r) => ({ ...(r.toJSON() as object), body: text(r, 'body') }));
    } else out[k] = v;
  }
  return out as NoteJSON;
}

function writeNote(parent: YMap, n: NoteJSON): void {
  const m = parent.set(n.id, new Y.Map<unknown>());
  for (const [k, v] of Object.entries(n)) {
    if (k === 'body') newText(m, k, v as TextJSON);
    else if (k === 'suggestion') { if (v) newText(m, k, v as TextJSON); else m.set(k, null); }
    else if (k === 'replies') {
      const arr = m.set('replies', new Y.Array<YMap>());
      for (const r of n.replies) {
        const rm = new Y.Map<unknown>();
        arr.push([rm]);
        for (const [rk, rv] of Object.entries(r)) {
          if (rk === 'body') newText(rm, rk, rv as TextJSON);
          else rm.set(rk, rv);
        }
      }
    } else if (v !== undefined) m.set(k, v);
  }
}

export function readTextKeyed<T>(m: YMap, textKeys: readonly string[], keyMaps: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) {
    if (textKeys.includes(k)) out[k] = readTextJSON(v as Y.Text);
    else if (keyMaps.includes(k)) out[k] = keysOf(v as YMap);
    else out[k] = v instanceof Y.Map ? v.toJSON() : v;
  }
  return out as T;
}

function writeTextKeyed(parent: YMap, id: string, record: Record<string, unknown>, textKeys: readonly string[], keyMaps: readonly string[], jsonMaps: readonly string[]): YMap {
  const m = parent.set(id, new Y.Map<unknown>());
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (textKeys.includes(k)) newText(m, k, v as TextJSON);
    else if (keyMaps.includes(k)) setKeyMap(m, k, v as string[]);
    else if (jsonMaps.includes(k)) setJSONMap(m, k, v as Record<string, unknown>);
    else m.set(k, v);
  }
  return m;
}

// ---------- document ----------

function anchorText(elements: YMap, elementId: string): Y.Text | null {
  const el = elements.get(elementId) as YMap | undefined;
  return (el?.get('text') as Y.Text | undefined) ?? null;
}

/**
 * A private, mutable deep copy of plain JSON. The Y.Doc keeps plain-object leaves by reference
 * (`Y.Map.toJSON` and `.get` hand them back as-is), and for the template those leaves are the
 * frozen objects of the built-in catalogue, so anything derived from them must be copied before
 * it leaves the model.
 */
function cloneJSON<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJSON) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJSON(v);
    return out as T;
  }
  return value;
}

export function documentToJSON(doc: Y.Doc): DocumentJSON {
  const g = (k: string) => doc.getMap<unknown>(k);
  const elements = g('elements');
  const portable = (elementId: string, rel: string | null) => {
    if (rel === null) return null;
    const t = anchorText(elements, elementId);
    return t ? toPortablePos(doc, t, rel) : 'o:0';
  };

  const st = g('smartType');
  const smartType = Object.fromEntries(STORED_SMARTTYPE_LISTS.map((list) => {
    const entries = (st.get(list) as YMap | undefined) ?? new Y.Map();
    const items = [...entries.entries()].map(([key, v]) => ({ key, ...(v as object) }) as SmartTypeEntryJSON);
    return [list, items.sort((a, b) => comparePositions(a.pos, b.pos) || (a.key < b.key ? -1 : 1))];
  }));

  const rev = g('revisions');
  const prod = g('production');
  const tp = g('titlePage');
  const tr = g('tableRead');
  const spelling = g('spelling');
  const importMeta = g('importMeta');

  return {
    meta: { ...(g('meta').toJSON() as DocumentJSON['meta']) },
    template: cloneJSON(readEmbeddedTemplate(doc)),
    elements: readElementList(elements),
    titlePage: {
      elements: tp.has('elements') ? readElementList(childMap(tp, 'elements')) : [],
      fields: tp.has('fields') ? (childMap(tp, 'fields').toJSON() as DocumentJSON['titlePage']['fields']) : {},
      computed: tp.has('computed') ? (childMap(tp, 'computed').toJSON() as DocumentJSON['titlePage']['computed']) : {},
    },
    folders: sortedRecords([...g('folders').values()].map((v) => readTextKeyed<FolderJSON>(v as YMap, ['synopsis'], []))),
    entities: sortedRecords([...g('entities').values()].map((v) => readEntity(v as YMap))),
    traitDefs: flatRecords(g('traitDefs')),
    tagCategories: flatRecords(g('tagCategories')),
    tags: flatRecords(g('tags')),
    notes: sortedRecords([...g('notes').values()].map((v) => readNote(v as YMap))),
    noteTypes: flatRecords(g('noteTypes')),
    revisions: {
      sets: rev.has('sets') ? flatRecords(childMap(rev, 'sets')) : [],
      activeSetId: (rev.get('activeSetId') as never) ?? null, headerSetId: (rev.get('headerSetId') as never) ?? null,
      mode: (rev.get('mode') as boolean) ?? false, display: (rev.get('display') as never) ?? 'none',
      selectedSetIds: (rev.get('selectedSetIds') as never) ?? [], showPageColor: (rev.get('showPageColor') as boolean) ?? false,
      colorRevisedText: (rev.get('colorRevisedText') as boolean) ?? false, markColumn: (rev.get('markColumn') as number) ?? 7_086_600,
    },
    trackChanges: { enabled: (g('trackChanges').get('enabled') as boolean) ?? false, view: (g('trackChanges').get('view') as never) ?? 'markup' },
    writers: [...g('writers').values()].map((v) => (v as YMap).toJSON() as DocumentJSON['writers'][number]).sort((a, b) => (a.uid < b.uid ? -1 : 1)),
    production: {
      scenesLocked: (prod.get('scenesLocked') as boolean) ?? false, scenesLockedAt: (prod.get('scenesLockedAt') as number | null) ?? null,
      lockedStyles: keysOf(prod.get('lockedStyles') as YMap) as never,
      pagesLocked: (prod.get('pagesLocked') as boolean) ?? false, pagesLockedAt: (prod.get('pagesLockedAt') as number | null) ?? null,
      pageLocks: prod.has('pageLocks')
        ? flatRecords<DocumentJSON['production']['pageLocks'][number]>(childMap(prod, 'pageLocks')).map((l) => ({ ...l, start: portable(l.startElementId, l.start)! }))
        : [],
    },
    beats: sortedRecords([...g('beats').values()].map((v) => readTextKeyed<BeatJSON>(v as YMap, ['title', 'body'], ['storylineIds']))),
    beatLinks: flatRecords(g('beatLinks')),
    plotColumns: flatRecords(g('plotColumns')),
    storylines: flatRecords(g('storylines')),
    lanes: flatRecords(g('lanes')),
    bin: flatRecords(g('bin')),
    shots: sortedRecords([...g('shots').values()].map((v) => {
      const s = readTextKeyed<ShotJSON>(v as YMap, ['description'], []);
      return s.range ? { ...s, range: { ...s.range, start: portable(s.range.startElementId, s.range.start)!, end: portable(s.range.endElementId, s.range.end)! } } : s;
    })),
    bookmarks: flatRecords<DocumentJSON['bookmarks'][number]>(g('bookmarks')).map((b) => ({ ...b, at: portable(b.elementId, b.at) })),
    macros: flatRecords(g('macros')),
    smartType: {
      ...(smartType as Pick<DocumentJSON['smartType'], (typeof STORED_SMARTTYPE_LISTS)[number]>),
      introSeparator: (st.get('introSeparator') as string) ?? ' ', timeSeparator: (st.get('timeSeparator') as string) ?? ' - ',
      sortMode: (st.get('sortMode') as never) ?? 'alphabetical', dismissed: keysOf(st.get('dismissed') as YMap),
      entityTombstones: keysOf(st.get('entityTombstones') as YMap),
    },
    spelling: { language: (spelling.get('language') as string) ?? 'en', words: keysOf(spelling.get('words') as YMap), ignored: keysOf(spelling.get('ignored') as YMap) },
    tableRead: {
      narrator: tr.get('narrator') as never, narratorStyleIds: keysOf(tr.get('narratorStyleIds') as YMap) as never,
      dialogueOnly: tr.get('dialogueOnly') as boolean, speakCharacterNames: tr.get('speakCharacterNames') as boolean, defaultVoice: tr.get('defaultVoice') as never,
    },
    settings: g('settings').toJSON() as DocumentJSON['settings'],
    importMeta: importMeta.size > 0 ? (importMeta.toJSON() as DocumentJSON['importMeta']) : null,
    aiSuggestions: sortedRecords([...g('aiSuggestions').values()].map((v) => {
      const m = v as YMap;
      const items = [...childMap(m, 'items').values()] as SuggestionSetJSON['items'];
      return { ...(m.toJSON() as SuggestionSetJSON), items: sortedRecords([...items]) };
    })),
  };
}

export function documentFromJSON(json: DocumentJSON, options: { preserveIds: boolean; ids: IdSource; docId?: DocId }): Uint8Array {
  return Y.encodeStateAsUpdate(materializeDocument(json, options));
}

export function materializeDocument(input: DocumentJSON, options: { preserveIds: boolean; ids: IdSource; docId?: DocId }): Y.Doc {
  const json = options.preserveIds
    ? { ...input, meta: { ...input.meta, docId: options.docId ?? input.meta.docId } }
    : remapDocumentIds(input, options.ids, options.docId ?? newId('doc', options.ids));
  const doc = new Y.Doc();
  const g = (k: string) => doc.getMap<unknown>(k);

  doc.transact(() => {
    const meta = g('meta');
    for (const [k, v] of Object.entries(json.meta)) if (k !== 'migrations') meta.set(k, v);
    setJSONMap(meta, 'migrations', json.meta.migrations);

    embedTemplate(doc, json.template);
    writeElementList(g('elements'), json.elements);

    const tp = g('titlePage');
    writeElementList(tp.set('elements', new Y.Map<unknown>()), json.titlePage.elements);
    setJSONMap(tp, 'fields', json.titlePage.fields);
    setJSONMap(tp, 'computed', json.titlePage.computed);

    for (const f of json.folders) writeTextKeyed(g('folders'), f.id, f, ['synopsis'], [], []);
    for (const e of json.entities) writeEntity(g('entities'), e);
    writeFlatRecords(g('traitDefs'), json.traitDefs);
    writeFlatRecords(g('tagCategories'), json.tagCategories);
    writeFlatRecords(g('tags'), json.tags);
    for (const n of json.notes) writeNote(g('notes'), n);
    writeFlatRecords(g('noteTypes'), json.noteTypes);

    const rev = g('revisions');
    writeFlatRecords(rev.set('sets', new Y.Map<unknown>()), json.revisions.sets);
    const { sets: _sets, ...revRest } = json.revisions;
    for (const [k, v] of Object.entries(revRest)) rev.set(k, v);

    g('trackChanges').set('enabled', json.trackChanges.enabled);
    g('trackChanges').set('view', json.trackChanges.view);
    for (const w of json.writers) setJSONMap(g('writers'), w.uid, w);

    const elements = g('elements');
    const relative = (elementId: string, portable: string | null) => {
      if (portable === null) return null;
      const t = anchorText(elements, elementId);
      return t ? fromPortablePos(t, portable) : portable;
    };

    const prod = g('production');
    for (const k of ['scenesLocked', 'scenesLockedAt', 'pagesLocked', 'pagesLockedAt'] as const) prod.set(k, json.production[k]);
    setKeyMap(prod, 'lockedStyles', json.production.lockedStyles);
    writeFlatRecords(prod.set('pageLocks', new Y.Map<unknown>()), json.production.pageLocks.map((l) => ({ ...l, start: relative(l.startElementId, l.start)! })));

    for (const b of json.beats) writeTextKeyed(g('beats'), b.id, b, ['title', 'body'], ['storylineIds'], ['arc']);
    writeFlatRecords(g('beatLinks'), json.beatLinks);
    writeFlatRecords(g('plotColumns'), json.plotColumns);
    writeFlatRecords(g('storylines'), json.storylines);
    writeFlatRecords(g('lanes'), json.lanes);
    writeFlatRecords(g('bin'), json.bin);
    for (const s of json.shots) {
      const range = s.range ? { ...s.range, start: relative(s.range.startElementId, s.range.start)!, end: relative(s.range.endElementId, s.range.end)! } : null;
      writeTextKeyed(g('shots'), s.id, { ...s, range }, ['description'], [], ['camera', 'attributes']);
    }
    writeFlatRecords(g('bookmarks'), json.bookmarks.map((b) => ({ ...b, at: relative(b.elementId, b.at) })));
    writeFlatRecords(g('macros'), json.macros);

    const st = g('smartType');
    for (const list of STORED_SMARTTYPE_LISTS) {
      const m = st.set(list, new Y.Map<unknown>());
      for (const { key, ...entry } of json.smartType[list]) m.set(key, entry);
    }
    st.set('introSeparator', json.smartType.introSeparator);
    st.set('timeSeparator', json.smartType.timeSeparator);
    st.set('sortMode', json.smartType.sortMode);
    setKeyMap(st, 'dismissed', json.smartType.dismissed);
    setKeyMap(st, 'entityTombstones', json.smartType.entityTombstones);

    const spelling = g('spelling');
    spelling.set('language', json.spelling.language);
    setKeyMap(spelling, 'words', json.spelling.words);
    setKeyMap(spelling, 'ignored', json.spelling.ignored);

    const tr = g('tableRead');
    tr.set('narrator', json.tableRead.narrator);
    setKeyMap(tr, 'narratorStyleIds', json.tableRead.narratorStyleIds);
    tr.set('dialogueOnly', json.tableRead.dialogueOnly);
    tr.set('speakCharacterNames', json.tableRead.speakCharacterNames);
    tr.set('defaultVoice', json.tableRead.defaultVoice);

    for (const [k, v] of Object.entries(json.settings)) g('settings').set(k, v);
    if (json.importMeta) for (const [k, v] of Object.entries(json.importMeta)) g('importMeta').set(k, v);
    for (const set of json.aiSuggestions) {
      const m = g('aiSuggestions').set(set.id, new Y.Map<unknown>());
      for (const [k, v] of Object.entries(set)) if (k !== 'items') m.set(k, v);
      const items = m.set('items', new Y.Map<unknown>());
      for (const item of set.items) items.set(item.id, item);
    }
  }, systemOrigin('fromJSON'));
  return doc;
}
