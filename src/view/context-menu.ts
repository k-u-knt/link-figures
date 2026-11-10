import { Menu } from "obsidian";
import type { Pt } from "../model/geometry";
import type { Registries } from "../registry";
import type { CommandContext, MenuPlace } from "../registry/command";
import { menuModel } from "./menu-model";

/** What the context menu needs of the figure view. */
export interface MenuHost {
  plugin: { registries: Pick<Registries, "commands"> };
  commandContext(): CommandContext;
  runCommandById(id: string): void;
  /** Places the tool `id` at the client point `at`, as a press there would (see `Command.placeFromMenu`). */
  placeToolAt?(id: string, at: Pt): void;
  /** True while a context menu is open, and for the rest of the task in which it closed (see `showContextMenu`). */
  contextMenuOpen: boolean;
  /** The menu that set `contextMenuOpen`: only it clears the flag, so a menu that hid does not clear a newer one's. */
  contextMenu?: Menu | null;
}

/**
 * Opens the context menu for `where` at `at` (client px): an Obsidian `Menu` generated from the command registry
 * (`menuModel`), a separator between groups. Each entry runs its command through the view, as a toolbar button does;
 * a tool placed from a menu (`Command.placeFromMenu`) is placed at `at`.
 * A menu with nothing in it is not shown, and null is returned.
 */
export function showContextMenu(host: MenuHost, where: MenuPlace, at: Pt): Menu | null {
  const { groups } = menuModel(host.plugin.registries, host.commandContext(), where);
  if (groups.length === 0) return null;
  const menu = new Menu();
  groups.forEach((group, i) => {
    if (i > 0) menu.addSeparator();
    for (const entry of group) {
      menu.addItem((item) => {
        // A tool that is placed from a menu goes where the menu was opened; any other command runs as a button runs it.
        const placed = host.placeToolAt && host.plugin.registries.commands.get(entry.id)?.placeFromMenu;
        item.setTitle(entry.name).setDisabled(entry.disabled).onClick(() => (placed ? host.placeToolAt?.(entry.id, at) : host.runCommandById(entry.id)));
        if (entry.icon) item.setIcon(entry.icon);
      });
    }
  });
  // An on-page Menu does not take the focus: the key that closes it (Escape) also reaches the stage. So the stage is told
  // a menu is open, and for the rest of the task in which it hid, which is the task of that keydown.
  host.contextMenuOpen = true;
  host.contextMenu = menu;
  menu.onHide(() =>
    setTimeout(() => {
      if (host.contextMenu !== menu) return;
      host.contextMenu = null;
      host.contextMenuOpen = false;
    }, 0),
  );
  menu.showAtPosition(at);
  return menu;
}
