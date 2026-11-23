import type { IdSource } from '../ids/id-source.js';
import type { ElementId, EntityId, FolderId, StyleId } from '../ids/ids.js';
import type { EntityJSON } from '../schema/entities.js';
import type {
  AltJSON, ElementMeta, ElementNumbering, NoteJSON, NoteSeverity, NoteSource, NoteStatus, OmitRecord, TagCategoryJSON, TagJSON, TrackChangeRecord,
} from '../schema/document.js';
import type { JsonValue } from '../schema/primitives.js';
import type { ElementOverrides } from '../schema/template.js';
import type { TextJSON } from '../schema/text.js';
import type { StyleRole, TitleField } from '../schema/vocab.js';
import type { ParsedSceneHeading } from './scene-heading.js';

export type TextSnapshot = TextJSON;

export interface ElementView {
  readonly id: ElementId;
  readonly pos: string;
  readonly style: StyleId;
  readonly role: StyleRole | null;
  readonly text: TextSnapshot;
  readonly ov: ElementOverrides;
  readonly num: ElementNumbering | null;
  readonly hasScene: boolean;
  readonly dual: { group: string; side: 'left' | 'right' } | null;
  readonly altCount: number;
  /** The inactive alternates' own text (spec 01 §5.5), not just their count — read by
   *  `alternatesMode: 'all'` (spec 02 §8.2) to render `text // alt1 // alt2`. */
  readonly alts: readonly AltJSON[];
  readonly label: string | null;
  readonly outlineLevel: number | null;
  readonly shotId: string | null;
  readonly folderId: string | null;
  readonly lineAdjust: { deltaRight: number; auto: boolean } | null;
  readonly tc: TrackChangeRecord | null;
  readonly omit: OmitRecord | null;
  /** The `omit` record of the *governing* scene (the nearest preceding scene start, walked
   *  locally — never a full `getStructure()` pass), or `null` if this element has no governing
   *  scene or that scene is not omitted. Lets a layout consumer skip an omitted scene's body
   *  without asking the structure pass to compute it (Task 17). */
  readonly sceneOmit: OmitRecord | null;
  readonly meta: ElementMeta;
  readonly field: TitleField | null;
}

/** spec 01 §5.11 `production`: which top-level record a change touched, so §31.1 can
 *  re-decorate (lock badges, page-lock anchors, scene-lock banner) without a refill. */
export type ProductionChangeKind = 'lockedStyles' | 'pageLocks' | 'scenesLocked' | 'other';
/** spec 01 §5.10 `revisions`: `sets` holds revision-set *content* (colors, names, dates), which
 *  changes revised-text styling and needs a refill (§25.6); every other key is a *display*
 *  setting (active/selected sets, page color, mode) that only changes decoration (§31.1). */
export type RevisionsChangeKind = 'display' | 'sets' | 'other';
/** spec 01 §5.18 `settings`: `watermark` is the one field spec 02 §20.1 draws as a header/footer
 *  decoration (`{watermark.recipient}`), so it alone can be handled as decoration-only. */
export type SettingsChangeKind = 'watermark' | 'other';

export type ModelChange =
  | { kind: 'elements'; inserted: string[]; removed: string[]; changed: string[]; reordered: boolean }
  | { kind: 'template'; styleIds: string[] | 'all' }
  | { kind: 'titlePage' }
  | { kind: 'entities'; ids: string[] }
  | { kind: 'tags'; ids: string[] }
  | { kind: 'notes'; ids: string[] }
  | { kind: 'revisions'; what: RevisionsChangeKind } | { kind: 'trackChanges' } | { kind: 'production'; what: ProductionChangeKind }
  | { kind: 'folders' } | { kind: 'beats'; ids: string[] } | { kind: 'shots'; ids: string[] }
  | { kind: 'smartType' } | { kind: 'settings'; what: SettingsChangeKind } | { kind: 'bin' } | { kind: 'bookmarks' } | { kind: 'macros' }
  | { kind: 'writers'; ids: string[] };

export interface ModelChangeBatch {
  changes: ModelChange[];
  origin: unknown;
  local: boolean;
}

export interface ModelDeps {
  ids: IdSource;
  clock: () => number;
  locale: string;
}

export type Unsubscribe = () => void;

export interface SceneView {
  readonly id: ElementId;
  readonly index: number;
  readonly headingText: string;
  readonly heading: ParsedSceneHeading;
  readonly number: string | null;
  readonly elementIds: readonly ElementId[];
  readonly folderPath: readonly FolderId[];
  readonly actId: string | null;
  readonly synopsis: TextSnapshot;
  readonly color: string | null;
  readonly title: string;
  readonly locationId: EntityId | null;
  readonly characterIds: readonly EntityId[];
  readonly omitted: boolean;
  readonly storyDay: string;
  readonly versions: readonly { id: string; name: string; createdAt: number }[];
  /** Round-trips `scene.estimatedSeconds` (spec 01 §5.6); `null` when unset, in which case
   *  spec 02 §27.2's `runningTime` derives it from pages or words instead. */
  readonly estimatedSeconds: number | null;
}

export interface DialogueBlockView {
  readonly speakerId: ElementId;
  readonly elementIds: readonly ElementId[];
  readonly name: string;
  readonly extension: string | null;
  readonly entityId: EntityId | null;
  readonly dualGroup: string | null;
  readonly sceneId: ElementId | null;
}

export interface OutlineNode {
  kind: 'root' | 'act' | 'sequence' | 'folder' | 'outline' | 'scene';
  id: string;
  title: string;
  level: number;
  elementId: ElementId | null;
  children: OutlineNode[];
}

export interface TitlePageView {
  readonly elements: readonly ElementView[];
  readonly fields: Partial<Record<TitleField, { elementId: ElementId; text: string }>>;
  /** The stored `titlePage.computed` record (spec 01 §5.12), with `wordCount` replaced by its
   *  live value: the body word count rounded per `computed.wordCount.roundTo` (spec 02 §19),
   *  where `roundTo` defaults to 1 (exact count) when unset or not a positive number. */
  readonly computed: { readonly wordCount: number } & Readonly<Record<string, JsonValue>>;
}

export type EntityView = Readonly<EntityJSON> & { readonly hidden: boolean };
export interface OccurrenceView {
  readonly sceneId: ElementId | null;
  readonly elementId: ElementId;
  readonly source: 'speaker' | 'heading' | 'tag';
  readonly range: { index: number; length: number } | null;
}
export type TagView = Readonly<TagJSON>;
export type TagCategoryView = Readonly<TagCategoryJSON>;
/**
 * A note as consumers see it: the stored `NoteJSON` with the structured-comment fields normalized to
 * non-optional values (legacy notes get derived defaults in `notes()`), so UI never branches on
 * "field present?". `status` is derived from `resolved` when a legacy note has none.
 */
export type NoteView = Readonly<Omit<NoteJSON, 'category' | 'suggestion' | 'status' | 'source' | 'severity'>> & {
  readonly category: string;
  readonly suggestion: TextJSON | null;
  readonly status: NoteStatus;
  readonly source: NoteSource;
  readonly severity: NoteSeverity | null;
};
export interface Suggestion {
  text: string;
  key: string;
  source: 'entity' | 'list';
  entityId: EntityId | null;
  count: number;
}
export interface SuggestionContext {
  elementId?: ElementId;
}
