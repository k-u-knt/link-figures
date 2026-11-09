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
}

/**
 * Opens the context menu for `where` at `at` (client px): an Obsidian `Menu` generated from the command registry
 * (`menuModel`), a separator between groups. Each entry runs its command through the view, as a toolbar button does.
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
        item.setTitle(entry.name).setDisabled(entry.disabled).onClick(() => host.runCommandById(entry.id));
        if (entry.icon) item.setIcon(entry.icon);
      });
    }
  });
  menu.showAtPosition(at);
  return menu;
}
