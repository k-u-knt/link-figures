import type { Registries } from "../registry";
import type { Command, CommandContext, CommandState, MenuPlace } from "../registry/command";

/** One entry of a context menu: the command it runs, and how it is shown now. */
export interface MenuEntry {
  id: string;
  name: string;
  icon: string | undefined;
  disabled: boolean;
}

/** A context menu: its entries in groups (one per command group, in `GROUP_ORDER`), a separator between groups. */
export interface MenuModel {
  groups: MenuEntry[][];
}

/**
 * The context menu for a right-click at `where`, generated from the command registry as the toolbar is: every command
 * that is not hidden and opts in for `where` (`Command.menu`), in the registry's order (by group, then registration).
 * An entry whose command does not apply is disabled; its name and icon follow the command's `state` when it has one.
 */
export function menuModel(registries: Pick<Registries, "commands">, ctx: CommandContext, where: MenuPlace): MenuModel {
  const groups: MenuEntry[][] = [];
  let group: string | null = null;
  for (const command of registries.commands.all()) {
    if (command.hidden || !command.menu?.includes(where)) continue;
    const state = commandState(command, ctx);
    const entry: MenuEntry = { id: command.id, name: state.name ?? command.name, icon: state.icon ?? command.icon, disabled: !commandApplies(command, ctx) };
    if (command.group !== group) groups.push([]);
    group = command.group;
    groups[groups.length - 1].push(entry);
  }
  return { groups };
}

/** Whether `command` applies in `ctx`; a command that cannot tell does not. */
export function commandApplies(command: Command, ctx: CommandContext): boolean {
  try {
    return command.applies(ctx);
  } catch (error) {
    console.error(`Link Figures: could not tell whether "${command.name}" applies`, error);
    return false;
  }
}

/** How `command` shows the view's state now; as the command is when it has no `state`, or cannot tell. */
export function commandState(command: Command, ctx: CommandContext): CommandState {
  try {
    return command.state?.(ctx) ?? {};
  } catch (error) {
    console.error(`Link Figures: could not tell how "${command.name}" is set`, error);
    return {};
  }
}
