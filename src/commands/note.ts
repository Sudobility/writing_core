import * as Y from 'yjs';
import { z } from 'zod/v4';
import { newId } from '../ids/ids.js';
import { positionBetween } from '../model/positions.js';
import { writeTextJSON } from '../model/ytext.js';
import { HexColor, idSchema } from '../schema/primitives.js';
import { textJSONFromPlain } from '../schema/text.js';
import { elementIdsBetween, resolveRange } from './element-ops.js';
import { touchElement, writePolicy } from './marks-policy.js';
import { WireRange } from './positions.js';
import { defineCommand } from './registry.js';
import type { CommandContext, CommandResult, CommandSpec } from './types.js';

type YMap = Y.Map<unknown>;

// Writer/AI comments. writing_core had no note command before this: notes were written straight
// into the `notes` Y.Map server-side (convert / copy-to-live). These commands put note create/edit/
// resolve/reply on the same collaborative command path as every other edit, so the editor can add a
// comment optimistically and it merges conflict-free. They require only `comment` capability, which
// matches the sync write matrix (a commenter may write `notes` and `n:*` marks).

const TITLE_MAX = 200;
const BODY_MAX = 10_000;

const noteMap = (ctx: CommandContext): YMap => ctx.doc.getMap<unknown>('notes') as YMap;
const note = (ctx: CommandContext, id: string): YMap | undefined => noteMap(ctx).get(id) as YMap | undefined;

/**
 * Resolve the note type to store on a new note: the passed `typeId` if it exists, else the first
 * note type by `pos`, else a lazily seeded default (a fresh document whose template carried no note
 * types still needs a valid `ntp` id — `NoteJSON.typeId` is `idSchema('ntp')`, not nullable).
 */
function resolveTypeId(ctx: CommandContext, typeId?: string): string {
  const types = ctx.doc.getMap<unknown>('noteTypes') as YMap;
  if (typeId && types.has(typeId)) return typeId;
  let best: { id: string; pos: string } | null = null;
  for (const v of types.values()) {
    const t = v as YMap;
    const pos = String(t.get('pos') ?? '');
    if (!best || pos < best.pos) best = { id: String(t.get('id')), pos };
  }
  if (best) return best.id;
  const id = newId('ntp', ctx.ids);
  const seed: YMap = types.set(id, new Y.Map<unknown>());
  seed.set('id', id);
  seed.set('key', 'note');
  seed.set('name', 'Note');
  seed.set('color', '#FFD966');
  seed.set('marker', '');
  seed.set('pos', positionBetween(null, null, ctx.ids));
  return id;
}

/** Place `n:<noteId>` marks over a selection so a range note's span survives edits (the stored
 * anchor is `{kind:'range'}` with no coordinates — the marks carry the span). Returns false when the
 * selection is empty. */
function markRange(ctx: CommandContext, range: z.infer<typeof WireRange>, noteId: string): boolean {
  const resolved = resolveRange(ctx, range);
  if (!resolved) return false;
  const [from, to] = resolved;
  const policy = writePolicy(ctx);
  let wrote = false;
  for (const id of elementIdsBetween(ctx, from.elementId, to.elementId)) {
    const element = ctx.doc.getMap<unknown>('elements').get(id) as YMap;
    const text = element.get('text') as Y.Text;
    const start = id === from.elementId ? from.index : 0;
    const end = id === to.elementId ? to.index : text.length;
    if (end <= start) continue;
    text.format(start, end - start, { [`n:${noteId}`]: true } as Record<string, never>);
    touchElement(element, policy);
    wrote = true;
  }
  return wrote;
}

/** Clear every `n:<noteId>` mark from element text (used when a range note is deleted). */
function clearNoteMarks(ctx: CommandContext, noteId: string): void {
  const key = `n:${noteId}`;
  for (const v of ctx.doc.getMap<unknown>('elements').values()) {
    const element = v as YMap;
    const text = element.get('text');
    if (!(text instanceof Y.Text)) continue;
    let pos = 0;
    const clears: { index: number; length: number }[] = [];
    for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      const size = typeof op.insert === 'string' ? op.insert.length : 1;
      if (op.attributes && key in op.attributes) clears.push({ index: pos, length: size });
      pos += size;
    }
    if (clears.length === 0) continue;
    for (const c of [...clears].reverse()) text.format(c.index, c.length, { [key]: null } as Record<string, never>);
    touchElement(element, writePolicy(ctx));
  }
}

const anchorInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('element'), elementId: idSchema('el') }),
  z.object({ kind: z.literal('scene'), elementId: idSchema('el') }),
  z.object({ kind: z.literal('beat'), beatId: idSchema('beat') }),
  z.object({ kind: z.literal('document') }),
  z.object({ kind: z.literal('range'), range: WireRange }),
]);

const spec = <P>(id: string, params: z.ZodType<P>, run: (ctx: CommandContext, p: P) => CommandResult) =>
  defineCommand(id, params, run, { requires: ['comment'] });

export const NOTE_COMMANDS: CommandSpec<never>[] = [
  spec('note.add', z.object({
    id: idSchema('note').optional(),
    anchor: anchorInput,
    title: z.string().max(TITLE_MAX).optional(),
    body: z.string().max(BODY_MAX).optional(),
    typeId: idSchema('ntp').optional(),
    color: HexColor.nullable().optional(),
    includeInPdf: z.boolean().optional(),
    mentions: z.array(z.string()).optional(),
  }), (ctx, p) => {
    // Validate the anchor target up front (refuse-before-write). Capture the id into a local before
    // any closure — TS drops the discriminated-union narrowing of `p.anchor` inside a callback.
    const anchor = p.anchor;
    if (anchor.kind === 'element' && ctx.model.indexOf(anchor.elementId) < 0) return { ok: false, reason: 'notFound' };
    if (anchor.kind === 'scene') {
      const sceneElementId = anchor.elementId;
      if (!ctx.model.scenes().some((s) => s.id === sceneElementId)) return { ok: false, reason: 'notFound' };
    }
    if (anchor.kind === 'beat' && !ctx.doc.getMap<unknown>('beats').has(anchor.beatId)) return { ok: false, reason: 'notFound' };

    const id = p.id ?? newId('note', ctx.ids);
    if (noteMap(ctx).has(id)) return { ok: false, reason: 'notApplicable', detail: { existingId: id } };

    let stored: Record<string, unknown>;
    if (p.anchor.kind === 'range') {
      if (!markRange(ctx, p.anchor.range, id)) return { ok: false, reason: 'emptySelection' };
      stored = { kind: 'range' };
    } else if (p.anchor.kind === 'element') {
      stored = { kind: 'element', elementId: p.anchor.elementId };
    } else if (p.anchor.kind === 'scene') {
      stored = { kind: 'scene', elementId: p.anchor.elementId };
    } else if (p.anchor.kind === 'beat') {
      stored = { kind: 'beat', beatId: p.anchor.beatId };
    } else {
      stored = { kind: 'document' };
    }

    const now = ctx.clock();
    const m: YMap = noteMap(ctx).set(id, new Y.Map<unknown>());
    m.set('id', id);
    m.set('anchor', stored);
    m.set('typeId', resolveTypeId(ctx, p.typeId));
    m.set('title', p.title ?? '');
    writeTextJSON(m.set('body', new Y.Text()) as Y.Text, textJSONFromPlain(p.body ?? ''));
    m.set('color', p.color ?? null);
    m.set('authorUid', ctx.actor.userId);
    m.set('createdAt', now);
    m.set('updatedAt', now);
    m.set('resolved', null);
    m.set('includeInPdf', p.includeInPdf ?? false);
    m.set('replies', new Y.Array<YMap>());
    m.set('mentions', p.mentions ?? []);
    return { ok: true };
  }),

  spec('note.update', z.object({
    noteId: idSchema('note'),
    title: z.string().max(TITLE_MAX).optional(),
    body: z.string().max(BODY_MAX).optional(),
    color: HexColor.nullable().optional(),
    typeId: idSchema('ntp').optional(),
    includeInPdf: z.boolean().optional(),
    mentions: z.array(z.string()).optional(),
  }), (ctx, p) => {
    const m = note(ctx, p.noteId);
    if (!m) return { ok: false, reason: 'notFound' };
    if (p.title !== undefined) m.set('title', p.title);
    if (p.body !== undefined) writeTextJSON(m.set('body', new Y.Text()) as Y.Text, textJSONFromPlain(p.body));
    if (p.color !== undefined) m.set('color', p.color);
    if (p.typeId !== undefined) m.set('typeId', resolveTypeId(ctx, p.typeId));
    if (p.includeInPdf !== undefined) m.set('includeInPdf', p.includeInPdf);
    if (p.mentions !== undefined) m.set('mentions', p.mentions);
    m.set('updatedAt', ctx.clock());
    return { ok: true };
  }),

  // Resolve / reopen — "dismiss" a comment. `resolved` is `{ by, at } | null`, so a dismissed note
  // keeps who dismissed it and when; reopening clears it.
  spec('note.resolve', z.object({ noteId: idSchema('note'), resolved: z.boolean() }), (ctx, p) => {
    const m = note(ctx, p.noteId);
    if (!m) return { ok: false, reason: 'notFound' };
    m.set('resolved', p.resolved ? { by: ctx.actor.userId, at: ctx.clock() } : null);
    m.set('updatedAt', ctx.clock());
    return { ok: true };
  }),

  spec('note.delete', z.object({ noteId: idSchema('note') }), (ctx, p) => {
    const m = note(ctx, p.noteId);
    if (!m) return { ok: false, reason: 'notFound' };
    const anchor = m.get('anchor') as { kind?: string } | undefined;
    if (anchor?.kind === 'range') clearNoteMarks(ctx, p.noteId);
    noteMap(ctx).delete(p.noteId);
    return { ok: true };
  }),

  spec('note.reply', z.object({
    noteId: idSchema('note'),
    id: idSchema('rep').optional(),
    body: z.string().min(1).max(BODY_MAX),
    mentions: z.array(z.string()).optional(),
  }), (ctx, p) => {
    const m = note(ctx, p.noteId);
    if (!m) return { ok: false, reason: 'notFound' };
    const replies = m.get('replies') as Y.Array<YMap>;
    const rm = new Y.Map<unknown>();
    replies.push([rm]);
    const now = ctx.clock();
    rm.set('id', p.id ?? newId('rep', ctx.ids));
    rm.set('authorUid', ctx.actor.userId);
    writeTextJSON(rm.set('body', new Y.Text()) as Y.Text, textJSONFromPlain(p.body));
    rm.set('createdAt', now);
    rm.set('editedAt', null);
    rm.set('mentions', p.mentions ?? []);
    m.set('updatedAt', now);
    return { ok: true };
  }),
];
