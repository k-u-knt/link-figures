import { arrangeCommands } from "../../src/commands/arrange";
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cropCommands } from "../../src/commands/crop";
import { displayCommands } from "../../src/commands/display";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { createDocument } from "../../src/model/defaults";
import { DocumentStore } from "../../src/model/store";
import { createRegistries, type Registries } from "../../src/registry";
import type { Command, CommandContext, MenuPlace } from "../../src/registry/command";
import { menuModel } from "../../src/view/menu-model";

function setup(commands: Command[]) {
  const registries = createRegistries();
  for (const c of commands) registries.commands.register(c);
  const store = new DocumentStore(createDocument("a4-portrait"));
  const ctx: CommandContext = { app: {} as never, registries, view: null, store, selection: [], page: store.doc.pages[0] };
  return { registries, ctx };
}

const cmd = (id: string, group: Command["group"], menu: MenuPlace[] | undefined, extra: Partial<Command> = {}): Command =>
  ({ id, name: `Name ${id}`, icon: `icon-${id}`, group, menu, applies: () => true, run() {}, ...extra });

const ids = (model: ReturnType<typeof menuModel>) => model.groups.map((g) => g.map((e) => e.id));

test("lists the commands that opt in for the place, grouped by GROUP_ORDER, in registration order within a group", () => {
  const { registries, ctx } = setup([
    cmd("export", "export", ["item"]),
    cmd("b", "edit", ["item"]),
    cmd("page-only", "page", ["page"]),
    cmd("a", "edit", ["item", "page"]),
    cmd("none", "edit", undefined),
    cmd("fwd", "arrange", ["item"]),
  ]);
  expect(ids(menuModel(registries, ctx, "item"))).toEqual([["b", "a"], ["fwd"], ["export"]]);
  expect(ids(menuModel(registries, ctx, "page"))).toEqual([["a"], ["page-only"]]);
  expect(ids(menuModel(registries, ctx, "canvas"))).toEqual([]);
});

test("a command that does not apply, or cannot tell, is disabled", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { registries, ctx } = setup([
    cmd("yes", "edit", ["item"]),
    cmd("no", "edit", ["item"], { applies: () => false }),
    cmd("bad", "edit", ["item"], { applies: () => { throw new Error("no"); } }),
  ]);
  expect(menuModel(registries, ctx, "item").groups[0].map((e) => [e.id, e.disabled])).toEqual([["yes", false], ["no", true], ["bad", true]]);
  spy.mockRestore();
});

test("the name and icon come from state() when it gives them, else from the command", () => {
  const { registries, ctx } = setup([
    cmd("snap", "view", ["canvas"], { state: () => ({ name: "Snap: on", icon: "magnet-on" }) }),
    cmd("half", "view", ["canvas"], { state: () => ({ name: "Half" }) }),
    cmd("plain", "view", ["canvas"]),
  ]);
  expect(menuModel(registries, ctx, "canvas").groups[0].map(({ id, name, icon }) => ({ id, name, icon }))).toEqual([
    { id: "snap", name: "Snap: on", icon: "magnet-on" },
    { id: "half", name: "Half", icon: "icon-half" },
    { id: "plain", name: "Name plain", icon: "icon-plain" },
  ]);
});

test("hidden commands never appear, even when they opt in", () => {
  const { registries, ctx } = setup([cmd("shown", "edit", ["item"]), cmd("hidden", "edit", ["item"], { hidden: true })]);
  expect(ids(menuModel(registries, ctx, "item"))).toEqual([["shown"]]);
});

/** Every command the plugin registers at load, as `main.ts` registers them. */
function allBuiltins(): Registries {
  const registries = createRegistries();
  const plugin = { registries, addCommand: () => undefined, activeFigureView: () => null };
  registerBuiltinCommands(plugin as never);
  for (const c of [...drawingCommands(), ...groupCommands(), ...arrangeCommands(), ...cropCommands(), ...displayCommands()]) registries.commands.register(c);
  return registries;
}

test("each built-in opts in where the design says", () => {
  const registries = allBuiltins();
  const where = (place: MenuPlace) => registries.commands.all().filter((c) => c.menu?.includes(place)).map((c) => c.id).sort();
  expect(where("item")).toEqual(
    [
      "duplicate", "delete", "bring-forward", "send-backward", "group.create", "group.ungroup",
      "align.left", "align.hcenter", "align.right", "align.top", "align.vcenter", "align.bottom",
      "distribute.horizontal", "distribute.vertical", "crop.edit", "panel.crop-reset", "panel.display-auto",
      "panel.display-reset", "reset-aspect", "open-source", "lock", "unlock",
    ].sort(),
  );
  expect(where("page")).toEqual(["add-page", "delete-page", "insert-text", "tool.rect", "tool.ellipse", "tool.connector", "fit-page", "export"].sort());
  expect(where("canvas")).toEqual(["fit-page", "zoom-100", "add-page", "export"].sort());
  // No hidden command opts in: it would never be shown.
  for (const c of registries.commands.all()) if (c.hidden) expect(c.menu).toBeUndefined();
});

test("the item menu of the built-ins, in group order", () => {
  const registries = allBuiltins();
  const store = new DocumentStore(createDocument("a4-portrait"));
  const ctx: CommandContext = { app: {} as never, registries, view: null, store, selection: [], page: store.doc.pages[0] };
  expect(ids(menuModel(registries, ctx, "item"))).toEqual([
    ["delete", "duplicate", "open-source", "lock", "unlock", "panel.crop-reset", "crop.edit"],
    ["bring-forward", "send-backward", "reset-aspect", "group.create", "group.ungroup"],
    ["align.left", "align.hcenter", "align.right", "align.top", "align.vcenter", "align.bottom"],
    ["distribute.horizontal", "distribute.vertical"],
    ["panel.display-auto", "panel.display-reset"],
  ]);
  // Nothing is selected: every one of them is disabled.
  expect(menuModel(registries, ctx, "item").groups.flat().every((e) => e.disabled)).toBe(true);
});
