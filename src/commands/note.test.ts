import { describe, expect, it } from 'vitest';
import { newId } from '../ids/ids.js';
import { commandHarness } from './test-harness.js';

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
});
