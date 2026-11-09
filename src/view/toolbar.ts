import { setIcon } from "obsidian";
import type { Command } from "../registry/command";
import type { LinkFiguresView } from "./figure-view";
import { commandApplies as applies, commandState as stateOf } from "./menu-model";

/**
 * The toolbar from the command registry: one icon button per command that is not `hidden`, a separator between groups. Buttons are disabled
 * when their command does not apply, and the button of the armed tool is shown pressed (`is-active`). A command that
 * shows the view's state (`Command.state`, a toggle's mode) has its button's name, icon and pressed look follow it.
 */
export class Toolbar {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  /** The name and icon each button shows now, so that a state that has not changed sets neither again. */
  private readonly shown = new Map<string, { name: string; icon: string }>();
  /** What the buttons were built from, so that a change in the registry (and only that) rebuilds them. */
  private built = "";

  constructor(private readonly view: LinkFiguresView, private readonly el: HTMLElement) {}

  render(): void {
    const commands = this.view.plugin.registries.commands.all().filter((c) => !c.hidden);
    const signature = commands.map((c) => `${c.group}/${c.id}/${c.icon ?? ""}/${c.name}`).join("|");
    // The buttons outlive a change in the document, so a button that has the focus keeps it.
    if (signature !== this.built) this.build(commands, signature);
    const ctx = this.view.commandContext();
    const armed = this.view.armedTool?.id;
    for (const command of commands) {
      const button = this.buttons.get(command.id);
      if (!button) continue;
      button.disabled = this.view.readOnly || !applies(command, ctx);
      const state = stateOf(command, ctx);
      const name = state.name ?? command.name;
      const icon = state.icon ?? command.icon ?? "square";
      const shown = this.shown.get(command.id);
      if (shown?.name !== name) button.setAttribute("aria-label", name);
      if (shown?.icon !== icon) setIcon(button, icon);
      this.shown.set(command.id, { name, icon });
      const active = command.id === armed || state.active === true;
      button.toggleClass("is-active", active);
      // A tool, or a state command whose state says active or not, is a pressed or an unpressed button;
      // a one-shot command, or a state command that carries its state in its name, has no such state.
      if (command.place || command.placeDrag || typeof state.active === "boolean") button.setAttribute("aria-pressed", String(active));
      else button.removeAttribute("aria-pressed");
    }
  }

  private build(commands: Command[], signature: string): void {
    this.built = signature;
    this.el.empty();
    this.buttons.clear();
    this.shown.clear();
    let group: string | null = null;
    for (const command of commands) {
      if (group !== null && command.group !== group) this.el.createDiv({ cls: "lf-sep" });
      group = command.group;
      const button = this.el.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": command.name } });
      setIcon(button, command.icon ?? "square");
      this.shown.set(command.id, { name: command.name, icon: command.icon ?? "square" });
      button.addEventListener("click", () => {
        // Keys (Delete, Cmd+Z) belong to the stage, and the button has just taken the focus from it. It also commits an inspector field being typed in.
        this.view.stageEl.focus({ preventScroll: true });
        this.view.runCommand(command);
      });
      this.buttons.set(command.id, button);
    }
  }
}
