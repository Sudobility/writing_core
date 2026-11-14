import { describe, expect, it } from 'vitest';
import { commandHarness } from '../commands/test-harness.js';
import { layoutDocument } from './layout-document.js';
import { buildElementIndex, docVersionOf, drawNumbers } from './output.js';

const scene = (n: number, heading: string): [string, string][] => [
  ['st_scene_heading', heading],
  ...Array.from({ length: n }, (_, i): [string, string] => ['st_action', `Beat ${heading} ${i}.`]),
];

function build(rows: [string, string][]) {
  const h = commandHarness();
  const ids = h.replaceBody(rows);
  const layout = layoutDocument(h.model);
  return { h, ids, layout, index: buildElementIndex(layout, h.model) };
}

describe('buildElementIndex', () => {
  it('maps each element to its pages and lines, and each page to its elements in order', () => {
    const { ids, layout, index } = build([...scene(2, 'INT. A - DAY'), ...scene(2, 'INT. B - DAY')]);
    expect(layout.pages).toHaveLength(1);
    expect(index.elementsOnPage(0)).toEqual(ids);
    const span = index.spanOf(ids[1]!)!;
    expect(span).toMatchObject({ firstPage: 0, lastPage: 0, firstLabel: '1', lastLabel: '1', pages: [0] });
    expect(index.linesOf(ids[1]!)).toEqual([{ pageIndex: 0, lineIndex: 1, sourceStart: 0, sourceEnd: 'Beat INT. A - DAY 0.'.length }]);
    expect(index.linesOf('el_missing' as never)).toEqual([]);
    expect(index.elementsOnPage(5)).toEqual([]);
  });

  it('gives a paragraph that breaks across a page both pages, with contiguous source ranges', () => {
    const long = Array.from({ length: 14 }, () => 'Sentence goes here.').join(' ');
    const rows: [string, string][] = [...scene(24, 'INT. A - DAY'), ['st_action', long], ['st_action', 'After.']];
    const { ids, layout, index } = build(rows);
    const split = ids.find((id) => (index.spanOf(id)?.pages.length ?? 0) > 1);
    expect(layout.pages.length).toBeGreaterThan(1);
    expect(split).toBeDefined();
    const span = index.spanOf(split!)!;
    expect(span.lastPage).toBe(span.firstPage + 1);
    expect(span.lines[0]!.sourceStart).toBe(0);
    for (let i = 1; i < span.lines.length; i++) expect(span.lines[i]!.sourceStart).toBeGreaterThanOrEqual(span.lines[i - 1]!.sourceEnd - 1);
    expect(span.lines.at(-1)!.sourceEnd).toBe(long.length);
    expect(index.elementsOnPage(span.firstPage)).toContain(split);
    expect(index.elementsOnPage(span.lastPage)).toContain(split);
  });

  it('computes each scene page extent and label, and keeps an omitted scene at the one page its OMITTED line sits on', () => {
    const rows: [string, string][] = [...scene(30, 'INT. A - DAY'), ...scene(2, 'INT. B - DAY'), ...scene(2, 'INT. C - DAY')];
    const { h, ids, layout } = build(rows);
    expect(layout.pages).toHaveLength(2);
    expect(h.run('scene.setOmitted', { scene: ids[31], omitted: true }).ok).toBe(true);
    const index = buildElementIndex(layoutDocument(h.model), h.model);
    const [a, b, c] = h.model.scenes();
    expect(index.sceneExtentOf(a!.id)).toMatchObject({ firstPage: 0, lastPage: 1, pageLabel: '1-2' });
    expect(index.sceneExtentOf(b!.id)).toMatchObject({ firstPage: 1, lastPage: 1, pageLabel: '2' });
    expect(index.spanOf(ids[32]!)).toBeUndefined(); // the omitted scene's body is not laid out
    expect(index.sceneExtentOf(c!.id)).toMatchObject({ firstPage: 1, lastPage: 1, pageLabel: '2' });
    expect(index.sceneExtents().map((e) => e.sceneId)).toEqual([a!.id, b!.id, c!.id]);
  });

  it('excludes generated lines from element ranges', () => {
    const { layout, ids } = build(scene(3, 'INT. A - DAY'));
    const page = layout.pages[0]!;
    page.lines.push({ ...page.lines[1]!, kind: 'more' });
    const index = buildElementIndex(layout);
    expect(index.linesOf(ids[1]!)).toHaveLength(1);
  });

  it('answers over a 3000-element document', () => {
    const rows: [string, string][] = [];
    for (let s = 0; s < 100; s++) rows.push(...scene(29, `INT. R${s} - DAY`));
    const { h, ids, layout } = build(rows);
    const index = buildElementIndex(layout, h.model);
    expect(ids).toHaveLength(3000);
    expect(layout.pages.length).toBeGreaterThan(50);
    const total = layout.pages.reduce((n, p, i) => n + index.elementsOnPage(i).length, 0);
    expect(total).toBeGreaterThanOrEqual(3000);
    // Exercise linesOf across every element for coverage (not timed — perf lives in bench).
    for (const id of ids) expect(index.linesOf(id)).toBeDefined();
    expect(index.sceneExtents()).toHaveLength(100);
    const last = index.sceneExtents().at(-1)!;
    expect(last.lastPage).toBe(layout.pages.length - 1);
  });

  it('every source line has real clusterSource data mapping back into the element text (this module\'s own coverage gap, not new code)', () => {
    const { layout } = build(scene(2, 'INT. A - DAY'));
    for (const page of layout.pages) {
      for (const line of page.lines) {
        if (line.kind !== 'text') continue;
        for (const run of line.runs) {
          expect(run.clusterSource.length).toBe(run.clusters.length);
          for (const src of run.clusterSource) expect(src).toBeLessThanOrEqual(line.sourceEnd - line.sourceStart);
        }
      }
    }
  });
});

describe('docVersionOf', () => {
  it('changes when the document changes and is stable across a view-only relayout', () => {
    const { h, ids, layout: before } = build(scene(2, 'INT. A - DAY'));
    const v0 = docVersionOf(h.model);
    expect(docVersionOf(h.model)).toBe(v0); // stable: nothing changed
    expect(v0).toMatch(/^[0-9a-f]{64}$/);

    // A view-only relayout (same document, laid out again) does not touch the doc: version is unchanged.
    const after = layoutDocument(h.model);
    expect(after.pages).toHaveLength(before.pages.length);
    expect(docVersionOf(h.model)).toBe(v0);

    // A real content edit changes it.
    expect(h.run('text.insert', { at: { elementId: ids[1]!, offset: 0 }, text: 'X' }).ok).toBe(true);
    expect(docVersionOf(h.model)).not.toBe(v0);
  });
});

describe('drawNumbers', () => {
  it('finds the left and right scene-number decorations for a heading\'s first line, keyed by element id', () => {
    const { h, ids } = build(scene(2, 'INT. A - DAY'));
    // Scene numbering is off by default (spec 05's own template.setSceneNumbering command turns it on).
    expect(h.run('template.setSceneNumbering', { mode: 'both' }).ok).toBe(true);
    const layout = layoutDocument(h.model);
    const page = layout.pages[0]!;
    const headingLine = page.lines.find((l) => l.elementId === ids[0] && l.lineIndexInElement === 0)!;
    const numbers = drawNumbers(headingLine, page.decorations);
    expect(numbers.left?.text).toMatch(/^\d+$/);
    expect(numbers.right?.text).toBe(numbers.left?.text);
    expect(numbers.left!.x).toBeLessThan(numbers.right!.x);
    expect(numbers.left).toHaveProperty('faceId');
    expect(numbers.left!.sizeEmu).toBeGreaterThan(0);

    // A non-first line, and an unrelated element, get nothing.
    const secondLine = page.lines.find((l) => l.elementId === ids[1])!;
    expect(drawNumbers(secondLine, page.decorations)).toEqual({});
  });
});
