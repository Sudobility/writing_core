import type * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { commandHarness } from './test-harness.js';
import { bodyElements, positionAfter } from './element-ops.js';

type YMap = Y.Map<unknown>;

/** The old O(n) reference scan (M2 task 34's own correctness bar): the same answer, found by brute force. */
function scanNext(container: YMap, afterPos: string | null): string | null {
  let next: string | null = null;
  for (const v of container.values()) {
    const p = String((v as YMap).get('pos'));
    if ((afterPos === null || p > afterPos) && (next === null || p < next)) next = p;
  }
  return next;
}

describe('positionAfter', () => {
  it('agrees with a brute-force O(n) scan on a freshly built document', () => {
    const h = commandHarness();
    const ids = h.replaceBody(Array.from({ length: 200 }, (_, i): [string, string] => ['st_action', `Line ${i}.`]));
    const container = bodyElements(h.doc);
    for (const afterId of [null, ids[0]!, ids[50]!, ids[199]!]) {
      const afterPos = afterId ? String((container.get(afterId) as YMap).get('pos')) : null;
      const expectedNext = scanNext(container, afterPos);
      const got = positionAfter(container, afterId, { ids: h.ids });
      expect(got > (afterPos ?? '')).toBe(true);
      if (expectedNext !== null) expect(got < expectedNext).toBe(true);
    }
  });

  it('stays correct across many sequential inserts through the real command path (the cache-maintenance case)', () => {
    const h = commandHarness();
    const ids = h.replaceBody([['st_scene_heading', 'INT. A - DAY']]);
    let after: string = ids[0]!;
    const created: string[] = [];
    for (let i = 0; i < 500; i++) {
      const r = h.run('element.insert', { after, style: 'st_action', text: `L${i}` });
      expect(r.ok).toBe(true);
      const id = (r as { ok: true; effects: { inserted: string[] } }).effects.inserted[0];
      expect(id).toBeDefined();
      created.push(id!);
      after = id!;
    }
    // Document order (by stored `pos`) must equal insertion order: each new element landed strictly after the last.
    const order = h.model.elements().map((e) => e.id);
    const tail = order.slice(order.length - created.length);
    expect(tail).toEqual(created);
  });

  it('answers correctly over a 3000-element document', () => {
    const h = commandHarness();
    const ids = h.replaceBody(Array.from({ length: 3000 }, (_, i): [string, string] => ['st_action', `Line ${i}.`]));
    const container = bodyElements(h.doc);
    // Agree with the brute-force O(n) oracle across the whole large document. Perf (that
    // positionAfter stays sub-linear) is tracked by `bun run bench:layout`, not here — a
    // wall-clock assertion in a unit test measures the machine, not the code.
    for (let i = 0; i < 200; i++) {
      const afterId = ids[i * 15]!;
      const afterPos = String((container.get(afterId) as YMap).get('pos'));
      const expectedNext = scanNext(container, afterPos);
      const got = positionAfter(container, afterId, { ids: h.ids });
      expect(got > afterPos).toBe(true);
      if (expectedNext !== null) expect(got < expectedNext).toBe(true);
    }
  });
});
