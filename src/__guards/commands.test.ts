import { describe, expect, it } from 'vitest';
import { COMMAND_ID_RE, listCommands } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtin.js';

describe('command vocabulary', () => {
  it('registers every M1 command with a stable id, label key and JSON-only params', () => {
    registerBuiltinCommands();
    const ids = listCommands().map((c) => c.id).sort();
    expect(ids).toEqual([
      'dual.clear', 'dual.create', 'dual.dissolve', 'dual.make', 'dual.swapSides', 'element.cycleStyle', 'element.duplicate', 'element.insert', 'element.move', 'element.revertOverrides', 'element.setOverride',
      'element.setStyle', 'element.split', 'entity.addAlias', 'entity.create', 'entity.delete', 'entity.merge', 'entity.rebuild',
      'entity.removeAlias', 'entity.update', 'mark.clear', 'mark.set', 'mark.toggle', 'note.add', 'note.delete', 'note.reply', 'note.resolve', 'note.update', 'page.lock', 'page.unlock', 'revision.clear', 'revision.markElements', 'revision.mode', 'revision.setCurrent', 'revision.setDisplay', 'scene.lockNumbers', 'scene.move', 'scene.setOmitted', 'scene.setSynopsis', 'scene.unlockNumbers', 'smartType.addEntry',
      'smartType.alphabetize', 'smartType.cleanup', 'smartType.rebuild', 'smartType.removeEntry', 'smartType.reorder',
      'template.setContinueds', 'template.setHeaderFooter', 'template.setSceneNumbering', 'text.deleteBackward', 'text.deleteForward', 'text.deleteRange', 'text.insert', 'text.insertSoftReturn', 'text.insertSpecial',
      'text.replaceRange', 'text.transformCase', 'title.setField',
    ]);
    for (const c of listCommands()) {
      expect(c.id).toMatch(COMMAND_ID_RE);
      expect(c.labelKey).toBe(`writing.command.${c.id}`);
      expect(c.requires.length, c.id).toBeGreaterThan(0);
    }
  });
});
