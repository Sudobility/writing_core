import { z } from 'zod/v4';
import { EntityJSON } from './entities.js';
import {
  Bcp47, Emu, EmuSigned, HexColor, JsonValue, StyleIdSchema, Timestamp, idSchema,
} from './primitives.js';
import {
  ElementOverrides, MacroRecord, NumberLabel, TagTextStyle, TemplateJSON,
} from './template.js';
import { TextJSON } from './text.js';
import {
  DOCUMENT_KINDS, ENTER_ON_BLANK, ENTITY_KINDS, REVISION_DISPLAYS, TEXT_DIRECTIONS, TITLE_FIELDS, TRACK_CHANGE_VIEWS,
} from './vocab.js';

export const DOC_TOP_LEVEL_KEYS = [
  'meta', 'template', 'elements', 'titlePage', 'folders', 'entities', 'traitDefs', 'tagCategories', 'tags', 'notes',
  'noteTypes', 'revisions', 'trackChanges', 'writers', 'production', 'beats', 'beatLinks', 'plotColumns', 'storylines',
  'lanes', 'bin', 'shots', 'bookmarks', 'macros', 'smartType', 'spelling', 'tableRead', 'settings', 'importMeta',
  'aiSuggestions',
] as const;
export type DocTopLevelKey = (typeof DOC_TOP_LEVEL_KEYS)[number];

const Pos = z.string().min(1);
/** Portable position form (`o:<offset>`) written by src/model/portable-pos.ts; regex kept local to avoid a schema -> model dependency. */
const PortablePos = z.string().regex(/^o:\d+$/);

export const ElementMeta = z.object({ createdBy: z.string(), createdAt: Timestamp, editedBy: z.string(), editedAt: Timestamp });
export type ElementMeta = z.infer<typeof ElementMeta>;

export const ElementNumbering = z.object({ label: NumberLabel, locked: z.boolean(), manual: z.boolean() });
export type ElementNumbering = z.infer<typeof ElementNumbering>;

export const TrackChangeRecord = z.object({
  kind: z.enum(['insert', 'delete', 'style']),
  changeId: idSchema('chg'),
  by: z.string(),
  at: Timestamp,
  fromStyle: StyleIdSchema.optional(),
  /** `kind: 'delete'` only: this element stands in for a merge, accept folds its text into this survivor instead of removing it outright (spec 01 §5.10.3/§5.10.4). */
  mergeInto: idSchema('el').optional(),
});
export type TrackChangeRecord = z.infer<typeof TrackChangeRecord>;

export const OmitRecord = z.object({ at: Timestamp, by: z.string(), rev: idSchema('rev').nullable() });
export type OmitRecord = z.infer<typeof OmitRecord>;

export const AltJSON = z.object({
  id: idSchema('alt'), pos: Pos, text: TextJSON, style: StyleIdSchema, label: z.string(), createdBy: z.string(), createdAt: Timestamp,
});
export type AltJSON = z.infer<typeof AltJSON>;

export type SceneVersionJSON = { id: string; name: string; createdBy: string; createdAt: number; content: ElementJSON[] };
export type SceneJSON = z.infer<typeof SceneJSONBase> & { versions: SceneVersionJSON[] };
export type ElementJSON = z.infer<typeof ElementJSONBase> & { scene?: SceneJSON };

const SceneJSONBase = z.object({
  synopsis: TextJSON,
  color: HexColor.nullable(),
  title: z.string(),
  locationId: idSchema('ent').nullable(),
  storyDay: z.string(),
  arcBeats: z.record(idSchema('ent'), TextJSON),
  storylineIds: z.array(idSchema('stl')),
  omit: OmitRecord.nullable(),
  estimatedSeconds: z.number().nullable(),
});

const ElementJSONBase = z.object({
  id: idSchema('el'),
  style: StyleIdSchema,
  text: TextJSON,
  ov: ElementOverrides.optional(),
  num: ElementNumbering.optional(),
  dual: z.object({ group: z.string().regex(/^dd_[0-9A-HJKMNP-TV-Z]{26}$/), side: z.enum(['left', 'right']) }).optional(),
  alts: z.array(AltJSON).optional(),
  label: z.string().optional(),
  outlineLevel: z.number().int().min(0).max(7).optional(),
  shotId: idSchema('shot').optional(),
  folderId: idSchema('fld').optional(),
  lineAdjust: z.object({ deltaRight: EmuSigned, auto: z.boolean() }).optional(),
  tc: TrackChangeRecord.optional(),
  omit: OmitRecord.optional(),
  meta: ElementMeta,
  importMeta: z.record(z.string(), JsonValue).optional(),
  field: z.enum(TITLE_FIELDS).optional(),
});

export const SceneVersionJSON: z.ZodType<SceneVersionJSON> = z.lazy(() =>
  z.object({ id: idSchema('sv'), name: z.string(), createdBy: z.string(), createdAt: Timestamp, content: z.array(ElementJSON) }),
);
export const SceneJSON: z.ZodType<SceneJSON> = z.lazy(() => SceneJSONBase.extend({ versions: z.array(SceneVersionJSON) })) as never;
export const ElementJSON: z.ZodType<ElementJSON> = z.lazy(() => ElementJSONBase.extend({ scene: SceneJSON.optional() })) as never;

export const DocumentMeta = z.object({
  schemaVersion: z.number().int().min(1),
  docId: idSchema('doc'),
  createdAt: Timestamp,
  createdBy: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  language: Bcp47,
  direction: z.enum(TEXT_DIRECTIONS),
  templateOrigin: z.object({ templateId: idSchema('tpl'), key: z.string().nullable(), version: z.number().int(), hash: z.string() }),
  forkedFrom: z.object({ docId: idSchema('doc'), snapshotId: idSchema('snap').nullable(), at: Timestamp }).nullable(),
  migrations: z.record(z.string(), z.object({ at: Timestamp, by: z.string(), codeVersion: z.string() })),
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

export const TEMPLATE_SEED_KEYS = ['smartType', 'revisionColors', 'tagCategories', 'noteTypes', 'traitDefs', 'macros', 'titlePage', 'body'] as const;
export const EmbeddedTemplateJSON = TemplateJSON.omit({
  smartType: true, revisionColors: true, tagCategories: true, noteTypes: true, traitDefs: true, macros: true, titlePage: true, body: true,
}).extend({ revision: z.number().int().min(0) });
export type EmbeddedTemplateJSON = z.infer<typeof EmbeddedTemplateJSON>;

export const TitlePageJSON = z.object({
  elements: z.array(ElementJSON),
  fields: z.partialRecord(z.enum(TITLE_FIELDS), idSchema('el')),
  computed: z.record(z.string(), JsonValue),
});
export type TitlePageJSON = z.infer<typeof TitlePageJSON>;

export const FolderJSON = z.object({
  id: idSchema('fld'), kind: z.enum(['act', 'sequence', 'folder']), title: z.string(), color: HexColor.nullable(),
  synopsis: TextJSON, parentId: idSchema('fld').nullable(), pos: Pos, collapsed: z.boolean(), pageBudget: z.number().nullable(),
});
export type FolderJSON = z.infer<typeof FolderJSON>;

export const TraitDefJSON = z.object({
  id: idSchema('trt'), key: z.string().nullable(), name: z.string(), type: z.enum(['text', 'choice', 'number']), options: z.array(z.string()), pos: Pos,
});
export type TraitDefJSON = z.infer<typeof TraitDefJSON>;

export const TagCategoryJSON = z.object({
  id: idSchema('cat'), key: z.string().nullable(), name: z.string(), color: HexColor, entityKind: z.enum(ENTITY_KINDS),
  textStyle: TagTextStyle, visible: z.boolean(), pos: Pos, fdxGuid: z.string().nullable(), osfUuid: z.string().nullable(),
});
export type TagCategoryJSON = z.infer<typeof TagCategoryJSON>;

export const TagJSON = z.object({
  id: idSchema('tag'), categoryId: idSchema('cat'), entityId: idSchema('ent'), elementId: idSchema('el'), createdBy: z.string(), createdAt: Timestamp,
});
export type TagJSON = z.infer<typeof TagJSON>;

export const NoteReplyJSON = z.object({
  id: idSchema('rep'), authorUid: z.string(), body: TextJSON, createdAt: Timestamp, editedAt: Timestamp.nullable(), mentions: z.array(z.string()),
});
export type NoteReplyJSON = z.infer<typeof NoteReplyJSON>;

export const NoteAnchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('range') }),
  z.object({ kind: z.literal('element'), elementId: idSchema('el') }),
  z.object({ kind: z.literal('scene'), elementId: idSchema('el') }),
  z.object({ kind: z.literal('beat'), beatId: idSchema('beat') }),
  z.object({ kind: z.literal('document') }),
]);
export type NoteAnchor = z.infer<typeof NoteAnchor>;

/**
 * Structured-comment lifecycle. A comment is born `pending` (an untriaged finding — the writer's own,
 * an org member's, or an AI review's). The writer triages it to `todo` (actionable), `completed`
 * (addressed) or `rejected` (dismissed). Only `pending`/`todo` are shown; `rejected`/`completed` are
 * kept (hidden, reopenable) for history. `resolved` ({by,at}) remains the audit stamp for who/when a
 * note left the active set. Legacy notes carry no `status`; the read model derives one from `resolved`.
 */
export const NOTE_STATUSES = ['pending', 'todo', 'rejected', 'completed'] as const;
export const NoteStatus = z.enum(NOTE_STATUSES);
export type NoteStatus = z.infer<typeof NoteStatus>;
/** Who authored the comment. Legacy notes default to `writer` in the read model. */
export const NOTE_SOURCES = ['writer', 'member', 'ai'] as const;
export const NoteSource = z.enum(NOTE_SOURCES);
export type NoteSource = z.infer<typeof NoteSource>;
/** Optional AI-assigned weight; `category` (the comment "type") is a free string validated by the
 * higher layers (screenwriter_types `REVIEW_CATEGORIES`) so writing_core stays domain-agnostic. */
export const NOTE_SEVERITIES = ['praise', 'minor', 'moderate', 'major'] as const;
export const NoteSeverity = z.enum(NOTE_SEVERITIES);
export type NoteSeverity = z.infer<typeof NoteSeverity>;

export const NoteJSON = z.object({
  id: idSchema('note'), anchor: NoteAnchor, typeId: idSchema('ntp'), title: z.string(), body: TextJSON, color: HexColor.nullable(),
  authorUid: z.string(), createdAt: Timestamp, updatedAt: Timestamp, resolved: z.object({ by: z.string(), at: Timestamp }).nullable(),
  includeInPdf: z.boolean(), replies: z.array(NoteReplyJSON), mentions: z.array(z.string()),
  // Structured-comment fields (optional: legacy notes predate them; the read model fills defaults).
  category: z.string().optional(), suggestion: TextJSON.nullable().optional(), status: NoteStatus.optional(),
  source: NoteSource.optional(), severity: NoteSeverity.nullable().optional(),
  detachedFrom: idSchema('el').optional(), importMeta: z.record(z.string(), JsonValue).optional(),
});
export type NoteJSON = z.infer<typeof NoteJSON>;

export const NoteTypeJSON = z.object({ id: idSchema('ntp'), key: z.string().nullable(), name: z.string(), color: HexColor, marker: z.string().max(2), pos: Pos });
export type NoteTypeJSON = z.infer<typeof NoteTypeJSON>;

export const RevisionSetJSON = z.object({
  id: idSchema('rev'), pos: Pos, name: z.string(), colorKey: z.string(), textColor: HexColor, pageColor: HexColor, mark: z.string().max(2),
  textStyle: z.object({ underline: z.enum(['none', 'single', 'dotted', 'word']), bold: z.boolean(), strike: z.boolean() }),
  fullDraft: z.boolean(), date: Timestamp.nullable(), createdBy: z.string(), createdAt: Timestamp,
});
export type RevisionSetJSON = z.infer<typeof RevisionSetJSON>;

export const RevisionsJSON = z.object({
  sets: z.array(RevisionSetJSON), activeSetId: idSchema('rev').nullable(), headerSetId: idSchema('rev').nullable(), mode: z.boolean(),
  display: z.enum(REVISION_DISPLAYS), selectedSetIds: z.array(idSchema('rev')), showPageColor: z.boolean(), colorRevisedText: z.boolean(), markColumn: Emu,
});
export type RevisionsJSON = z.infer<typeof RevisionsJSON>;

export const TrackChangesJSON = z.object({ enabled: z.boolean(), view: z.enum(TRACK_CHANGE_VIEWS) });
export type TrackChangesJSON = z.infer<typeof TrackChangesJSON>;

export const WriterJSON = z.object({ uid: z.string(), displayName: z.string(), initials: z.string().max(3), color: HexColor });
export type WriterJSON = z.infer<typeof WriterJSON>;

export const PageLockJSON = z.object({
  id: idSchema('plk'), label: NumberLabel, level: z.number().int().min(0), start: PortablePos, startElementId: idSchema('el'),
  startMidElement: z.boolean(), revisionSetId: idSchema('rev').nullable(), lockedAt: Timestamp, lockedBy: z.string(), reanchored: z.boolean().optional(),
});
export type PageLockJSON = z.infer<typeof PageLockJSON>;

export const ProductionJSON = z.object({
  scenesLocked: z.boolean(), scenesLockedAt: Timestamp.nullable(), lockedStyles: z.array(StyleIdSchema),
  pagesLocked: z.boolean(), pagesLockedAt: Timestamp.nullable(), pageLocks: z.array(PageLockJSON),
});
export type ProductionJSON = z.infer<typeof ProductionJSON>;

export const BeatJSON = z.object({
  id: idSchema('beat'), title: TextJSON, body: TextJSON, color: HexColor.nullable(), imageAssetId: idSchema('asset').nullable(),
  board: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), z: z.number() }).nullable(), boneyard: z.boolean(),
  plot: z.object({ columnId: idSchema('col'), pos: Pos }).nullable(), storylineIds: z.array(idSchema('stl')),
  arc: z.record(idSchema('stl'), z.number().int().min(-5).max(5)),
  lane: z.object({ laneId: idSchema('lane'), pos: Pos, pageBudget: z.number().nullable() }).nullable(),
  anchor: z.object({ elementId: idSchema('el') }).nullable(), createdBy: z.string(), createdAt: Timestamp,
});
export type BeatJSON = z.infer<typeof BeatJSON>;

export const BeatLinkJSON = z.object({
  id: idSchema('lnk'), from: idSchema('beat'), to: idSchema('beat'), label: z.string(), style: z.enum(['arrow', 'line', 'dashed']), color: HexColor.nullable(),
});
export type BeatLinkJSON = z.infer<typeof BeatLinkJSON>;

export const PlotColumnJSON = z.object({ id: idSchema('col'), title: z.string(), pos: Pos, folderId: idSchema('fld').nullable() });
export type PlotColumnJSON = z.infer<typeof PlotColumnJSON>;
export const StorylineJSON = z.object({ id: idSchema('stl'), name: z.string(), color: HexColor, pos: Pos });
export type StorylineJSON = z.infer<typeof StorylineJSON>;
export const LaneJSON = z.object({
  id: idSchema('lane'), label: z.string(), pos: Pos, level: z.number().int(), color: HexColor.nullable(), kind: z.enum(['outline', 'script', 'custom']),
});
export type LaneJSON = z.infer<typeof LaneJSON>;

export const BinItemJSON = z.object({
  id: idSchema('bin'), pos: Pos, title: z.string(), createdBy: z.string(), createdAt: Timestamp,
  source: z.object({ elementIds: z.array(idSchema('el')), sceneId: idSchema('el').nullable() }), content: z.array(ElementJSON),
});
export type BinItemJSON = z.infer<typeof BinItemJSON>;

export const ShotJSON = z.object({
  id: idSchema('shot'), sceneId: idSchema('el'), pos: Pos, elementId: idSchema('el').nullable(),
  range: z.object({ startElementId: idSchema('el'), start: PortablePos, endElementId: idSchema('el'), end: PortablePos }).nullable(),
  label: z.string(), description: TextJSON, camera: z.record(z.string(), JsonValue), attributes: z.record(z.string(), JsonValue),
  createdBy: z.string(), createdAt: Timestamp,
});
export type ShotJSON = z.infer<typeof ShotJSON>;

export const BookmarkJSON = z.object({ id: idSchema('bm'), name: z.string(), elementId: idSchema('el'), at: PortablePos.nullable() });
export type BookmarkJSON = z.infer<typeof BookmarkJSON>;

export const SmartTypeEntryJSON = z.object({
  key: z.string(), text: z.string(), pos: Pos, origin: z.enum(['seed', 'harvested', 'manual']), count: z.number().int().min(0),
});
export type SmartTypeEntryJSON = z.infer<typeof SmartTypeEntryJSON>;

export const SmartTypeJSON = z.object({
  sceneIntros: z.array(SmartTypeEntryJSON), times: z.array(SmartTypeEntryJSON), extensions: z.array(SmartTypeEntryJSON),
  transitions: z.array(SmartTypeEntryJSON), soundCues: z.array(SmartTypeEntryJSON),
  introSeparator: z.string(), timeSeparator: z.string(), sortMode: z.enum(['alphabetical', 'custom', 'frequency']), dismissed: z.array(z.string()),
  /** `kind:nameKey` pairs an explicit entity.delete tombstoned, so harvesting never recreates them (spec 01 §5.20/§7.2). */
  entityTombstones: z.array(z.string()),
});
export type SmartTypeJSON = z.infer<typeof SmartTypeJSON>;

export const SpellingJSON = z.object({ language: Bcp47, words: z.array(z.string()), ignored: z.array(z.string()) });
export type SpellingJSON = z.infer<typeof SpellingJSON>;

export const VoiceJSON = z.object({ platformVoiceId: z.string().nullable(), rate: z.number(), pitch: z.number(), volume: z.number() });
export type VoiceJSON = z.infer<typeof VoiceJSON>;

export const TableReadJSON = z.object({
  narrator: VoiceJSON, narratorStyleIds: z.array(StyleIdSchema), dialogueOnly: z.boolean(), speakCharacterNames: z.boolean(), defaultVoice: VoiceJSON,
});
export type TableReadJSON = z.infer<typeof TableReadJSON>;

export const SettingsJSON = z.object({
  enterOnBlank: z.enum(ENTER_ON_BLANK), smartQuotes: z.boolean(), autoCapitalizeSentences: z.boolean(), fixDoubleCapitals: z.boolean(),
  autoParentheses: z.boolean(), smartTypeEnabled: z.boolean(), guessNextCharacter: z.boolean(), macrosEnabled: z.boolean(),
  highlightCharacters: z.boolean(), targetPages: z.number().nullable(), targetEpisodeSeconds: z.number().nullable(), secondsPerPage: z.number().positive(),
  dualDialogueEditStacked: z.boolean(), outlineHidden: z.boolean(), showRevisionsInPrint: z.boolean(),
  watermark: z.record(z.string(), JsonValue).nullable(), readingDirection: z.enum(TEXT_DIRECTIONS),
});
export type SettingsJSON = z.infer<typeof SettingsJSON>;

export const DocumentImportMetaJSON = z.object({
  source: z.enum(['fadein', 'fdx', 'fountain', 'pdf', 'celtx', 'highland', 'adobeStory', 'scrivener', 'docx', 'rtf', 'txt', 'html']),
  fileName: z.string(), importedAt: Timestamp, osfVersion: z.number().optional(), fdxVersion: z.string().optional(),
  fontNames: z.record(z.string(), z.string()).optional(), unknown: JsonValue,
});
export type DocumentImportMetaJSON = z.infer<typeof DocumentImportMetaJSON>;

export const SuggestionItemJSON = z.object({
  id: idSchema('sug'), kind: z.enum(['replace', 'insert', 'delete', 'restyle']), elementIds: z.array(idSchema('el')), expectedHash: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected', 'stale']), proposed: z.array(ElementJSON).nullable(), rationale: z.string(),
});
export type SuggestionItemJSON = z.infer<typeof SuggestionItemJSON>;

export const SuggestionSetJSON = z.object({
  id: idSchema('sset'), jobId: idSchema('job'), task: z.string(), status: z.enum(['pending', 'partial', 'resolved', 'stale', 'expired']),
  createdAt: Timestamp, items: z.array(SuggestionItemJSON),
});
export type SuggestionSetJSON = z.infer<typeof SuggestionSetJSON>;

export const DocumentJSON = z.object({
  meta: DocumentMeta,
  template: EmbeddedTemplateJSON,
  elements: z.array(ElementJSON),
  titlePage: TitlePageJSON,
  folders: z.array(FolderJSON),
  entities: z.array(EntityJSON),
  traitDefs: z.array(TraitDefJSON),
  tagCategories: z.array(TagCategoryJSON),
  tags: z.array(TagJSON),
  notes: z.array(NoteJSON),
  noteTypes: z.array(NoteTypeJSON),
  revisions: RevisionsJSON,
  trackChanges: TrackChangesJSON,
  writers: z.array(WriterJSON),
  production: ProductionJSON,
  beats: z.array(BeatJSON),
  beatLinks: z.array(BeatLinkJSON),
  plotColumns: z.array(PlotColumnJSON),
  storylines: z.array(StorylineJSON),
  lanes: z.array(LaneJSON),
  bin: z.array(BinItemJSON),
  shots: z.array(ShotJSON),
  bookmarks: z.array(BookmarkJSON),
  macros: z.array(MacroRecord),
  smartType: SmartTypeJSON,
  spelling: SpellingJSON,
  tableRead: TableReadJSON,
  settings: SettingsJSON,
  importMeta: DocumentImportMetaJSON.nullable(),
  aiSuggestions: z.array(SuggestionSetJSON),
});
export type DocumentJSON = z.infer<typeof DocumentJSON>;
