import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { newId } from '../ids/ids.js';
import { executeCommand } from './execute.js';
import { TEST_ACTOR, commandHarness } from './test-harness.js';

describe('note commands', () => {
  it('adds element and scene notes, refusing unknown or non-scene targets', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_scene_heading', 'INT. DINER - NIGHT'], ['st_action', 'She sits.']])[1]!;
    const sceneId = h.model.scenes()[0]!.id;

    expect(h.run('note.add', { anchor: { kind: 'element', elementId: action }, title: 'Tighten', body: 'Cut this line.' }).ok).toBe(true);
    expect(h.run('note.add', { anchor: { kind: 'scene', elementId: sceneId }, body: 'Great opener.' }).ok).toBe(true);

    expect(h.run('note.add', { anchor: { kind: 'element', elementId: newId('el', h.ids) } })).toMatchObject({ ok: false, reason: 'notFound' });
    // A scene anchor must point at a scene-heading element, not a plain action line.
    expect(h.run('note.add', { anchor: { kind: 'scene', elementId: action } })).toMatchObject({ ok: false, reason: 'notFound' });

    expect(h.model.notes()).toHaveLength(2);
    const onAction = h.model.notes({ elementId: action })[0]!;
    expect(onAction).toMatchObject({ anchor: { kind: 'element', elementId: action }, title: 'Tighten', resolved: null });
    expect(onAction.body.plain).toBe('Cut this line.');
    expect(onAction.authorUid).toBe('u1');
    // typeId resolved to a real note type (seeded by the template, or lazily created).
    expect(onAction.typeId).toMatch(/^ntp_/);
  });

  it('supports multiple notes on one element', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    h.run('note.add', { anchor: { kind: 'element', elementId: action }, body: 'First.' });
    h.run('note.add', { anchor: { kind: 'element', elementId: action }, body: 'Second.' });
    expect(h.model.notes({ elementId: action })).toHaveLength(2);
  });

  it('resolves (dismisses) and reopens a note', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    expect(h.run('note.add', { anchor: { kind: 'element', elementId: action }, body: 'x' }).ok).toBe(true);
    const noteId = h.model.notes()[0]!.id;

    h.tick(5);
    expect(h.run('note.resolve', { noteId, resolved: true }).ok).toBe(true);
    const resolved = h.model.notes()[0]!;
    expect(resolved.resolved).toMatchObject({ by: 'u1' });
    expect(resolved.resolved!.at).toBe(h.now());

    expect(h.run('note.resolve', { noteId, resolved: false }).ok).toBe(true);
    expect(h.model.notes()[0]!.resolved).toBeNull();

    expect(h.run('note.resolve', { noteId: newId('note', h.ids), resolved: true })).toMatchObject({ ok: false, reason: 'notFound' });
  });

  it('threads replies, updates fields, and deletes', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    h.run('note.add', { anchor: { kind: 'element', elementId: action }, title: 'T', body: 'b' });
    const noteId = h.model.notes()[0]!.id;

    expect(h.run('note.reply', { noteId, body: 'I agree.' }).ok).toBe(true);
    expect(h.run('note.reply', { noteId, body: 'Me too.' }).ok).toBe(true);
    let note = h.model.notes()[0]!;
    expect(note.replies).toHaveLength(2);
    expect(note.replies[0]!.body.plain).toBe('I agree.');
    expect(note.replies[0]!.authorUid).toBe('u1');

    expect(h.run('note.update', { noteId, title: 'Tighter', body: 'Changed.' }).ok).toBe(true);
    note = h.model.notes()[0]!;
    expect(note.title).toBe('Tighter');
    expect(note.body.plain).toBe('Changed.');

    expect(h.run('note.delete', { noteId }).ok).toBe(true);
    expect(h.model.notes()).toHaveLength(0);
  });

  it('anchors a range note with n: marks and clears them on delete', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'The quick brown fox.']])[0]!;
    const range = { anchor: { elementId: action, offset: 4 }, head: { elementId: action, offset: 9 } };

    expect(h.run('note.add', { anchor: { kind: 'range', range } }).ok).toBe(true);
    const noteId = h.model.notes()[0]!.id;
    expect(h.model.notes()[0]!.anchor).toEqual({ kind: 'range' });
    // The span 'quick' now carries the n:<noteId> mark.
    const key = `n:${noteId}`;
    const marked = (h.delta(action) as { insert: string; attributes?: Record<string, unknown> }[])
      .filter((op) => op.attributes && key in op.attributes).map((op) => op.insert).join('');
    expect(marked).toBe('quick');

    h.run('note.delete', { noteId });
    const stillMarked = (h.delta(action) as { insert: string; attributes?: Record<string, unknown> }[])
      .some((op) => op.attributes && key in op.attributes);
    expect(stillMarked).toBe(false);
  });

  it('refuses an empty-selection range note without writing a record', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'Text.']])[0]!;
    const range = { anchor: { elementId: action, offset: 2 }, head: { elementId: action, offset: 2 } };
    expect(h.run('note.add', { anchor: { kind: 'range', range } })).toMatchObject({ ok: false, reason: 'emptySelection' });
    expect(h.model.notes()).toHaveLength(0);
  });

  it('stores structured-comment fields and defaults the rest', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    expect(h.run('note.add', {
      anchor: { kind: 'element', elementId: action }, body: 'Why does she stay?',
      category: 'motive', suggestion: 'Because she promised her sister.', source: 'ai', severity: 'moderate',
    }).ok).toBe(true);
    const ai = h.model.notes()[0]!;
    expect(ai).toMatchObject({ category: 'motive', status: 'pending', source: 'ai', severity: 'moderate' });
    expect(ai.body.plain).toBe('Why does she stay?');
    expect(ai.suggestion?.plain).toBe('Because she promised her sister.');

    // A plain writer comment defaults: category 'other', status 'pending', source 'writer', no suggestion.
    h.run('note.add', { anchor: { kind: 'element', elementId: action }, body: 'Typo.' });
    const plain = h.model.notes({ elementId: action }).find((n) => n.body.plain === 'Typo.')!;
    expect(plain).toMatchObject({ category: 'other', status: 'pending', source: 'writer', severity: null, suggestion: null });
  });

  it('triages status (pending → todo → completed) and keeps the resolved stamp in sync', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    h.run('note.add', { anchor: { kind: 'element', elementId: action }, body: 'x' });
    const noteId = h.model.notes()[0]!.id;

    expect(h.run('note.setStatus', { noteId, status: 'todo' }).ok).toBe(true);
    expect(h.model.notes()[0]!).toMatchObject({ status: 'todo', resolved: null });

    h.tick(7);
    expect(h.run('note.setStatus', { noteId, status: 'completed' }).ok).toBe(true);
    const done = h.model.notes()[0]!;
    expect(done.status).toBe('completed');
    expect(done.resolved).toMatchObject({ by: 'u1', at: h.now() });

    // Only pending/todo are "visible"; completed/rejected are hidden but still present.
    expect(h.model.notes({ visible: true })).toHaveLength(0);
    expect(h.model.notes({ status: ['todo', 'completed'] })).toHaveLength(1);
    expect(h.model.notes({ source: 'writer' })).toHaveLength(1);
  });

  it('derives a legacy note (no status/source) from its resolved stamp', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    h.run('note.add', { anchor: { kind: 'element', elementId: action }, body: 'x' });
    const noteId = h.model.notes()[0]!.id;
    // Simulate a pre-lifecycle note: strip the new fields, leave only `resolved`.
    const m = (h.doc.getMap<unknown>('notes').get(noteId) as Y.Map<unknown>);
    h.doc.transact(() => { m.delete('status'); m.delete('source'); m.delete('category'); m.delete('suggestion'); m.set('resolved', { by: 'u1', at: 10 }); });
    const n = h.model.notes()[0]!;
    expect(n).toMatchObject({ status: 'completed', source: 'writer', category: 'other', suggestion: null });
  });

  it('gates triage behind write capability (a comment-only member may add but not setStatus)', () => {
    const h = commandHarness();
    const action = h.replaceBody([['st_action', 'She sits.']])[0]!;
    const commentOnly = new Set(['comment'] as const);
    const call = (id: string, params: unknown) => executeCommand({
      doc: h.doc, model: h.model, ids: h.ids, actor: TEST_ACTOR,
      origin: h.origins.make('local-command', { commandId: id }), capabilities: commentOnly, clock: h.now, command: { id, params },
    });
    // A member can create a comment...
    const added = call('note.add', { anchor: { kind: 'element', elementId: action }, body: 'A member note.', source: 'member' });
    expect(added.ok).toBe(true);
    const noteId = h.model.notes()[0]!.id;
    // ...but cannot triage it.
    expect(call('note.setStatus', { noteId, status: 'todo' })).toMatchObject({ ok: false, reason: 'capabilityMissing' });
  });
});
