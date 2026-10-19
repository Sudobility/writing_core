import { DUAL_COMMANDS } from './dual.js';
import { ELEMENT_COMMANDS } from './element.js';
import { ENTITY_COMMANDS } from './entity.js';
import { MARK_COMMANDS } from './mark.js';
import { NOTE_COMMANDS } from './note.js';
import { LOCKING_COMMANDS } from './locking.js';
import { PAGE_SETUP_COMMANDS } from './page-setup.js';
import { registerCommand } from './registry.js';
import { REVISION_COMMANDS } from './revisions.js';
import { SMARTTYPE_COMMANDS } from './smarttype.js';
import { TEXT_COMMANDS } from './text.js';
import type { CommandSpec } from './types.js';

const BUILTIN: CommandSpec<never>[][] = [TEXT_COMMANDS, MARK_COMMANDS, NOTE_COMMANDS, ELEMENT_COMMANDS, ENTITY_COMMANDS, SMARTTYPE_COMMANDS, PAGE_SETUP_COMMANDS, DUAL_COMMANDS, LOCKING_COMMANDS, REVISION_COMMANDS];
let registered = false;

export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;
  for (const list of BUILTIN) for (const spec of list) registerCommand(spec as CommandSpec<unknown>);
}

export function addBuiltinCommands(list: CommandSpec<never>[]): void {
  BUILTIN.push(list);
  if (registered) for (const spec of list) registerCommand(spec as CommandSpec<unknown>);
}
