import { createDocument } from "../../src/model/defaults";
import { DocumentStore } from "../../src/model/store";
import { createRegistries } from "../../src/registry";
import type { Command } from "../../src/registry/command";
import { FakeEl } from "./fake-dom";

const icons: [FakeEl, string][] = [];
vi.mock("obsidian", () => ({ setIcon: (el: FakeEl, name: string) => void icons.push([el, name]) }));

const { Toolbar } = await import("../../src/view/toolbar");

function setup(commands: Command[]) {
  const registries = createRegistries();
  for (const c of commands) registries.commands.register(c);
  const store = new DocumentStore(createDocument("a4-portrait"));
  const stage = new FakeEl("div");
  const ran: string[] = [];
  const view = {
    readOnly: false,
    store,
    stageEl: Object.assign(stage, { focus: () => void ran.push("focus-stage") }),
    plugin: { registries },
    commandContext: () => ({ store, selection: [] as string[] }),
    runCommand: (c: Command) => void ran.push(`run:${c.id}`),
  };
  const el = new FakeEl("div");
  const toolbar = new Toolbar(view as never, el as never);
  toolbar.render();
  return { el, toolbar, view, ran, store };
}

const cmd = (id: string, group: Command["group"], applies: Command["applies"] = () => true, icon: string | undefined = `icon-${id}`): Command =>
  ({ id, name: `Name ${id}`, icon, group, applies, run() {} });

beforeEach(() => void (icons.length = 0));

test("one button per command, in group order, with a separator between groups", () => {
  const { el } = setup([cmd("export", "export"), cmd("undo", "edit"), cmd("redo", "edit"), cmd("fit", "view")]);
  expect(el.children.map((c) => (c.hasClass("lf-sep") ? "|" : c.attrs["aria-label"]))).toEqual(["Name undo", "Name redo", "|", "Name fit", "|", "Name export"]);
  const buttons = el.children.filter((c) => c.tag === "button");
  for (const b of buttons) expect(b.hasClass("clickable-icon")).toBe(true);
  expect(icons.map(([, name]) => name)).toEqual(["icon-undo", "icon-redo", "icon-fit", "icon-export"]);
});

test("a command without an icon still gets a button", () => {
  const { el } = setup([cmd("plain", "edit", () => true, undefined)]);
  expect(el.children).toHaveLength(1);
  expect(icons).toHaveLength(1);
});

test("a button is disabled when its command does not apply, and follows the document", () => {
  const { el, toolbar, store } = setup([cmd("undo", "edit", (ctx) => ctx.store.canUndo()), cmd("fit", "view")]);
  const [undo, , fit] = el.children;
  expect([undo.disabled, fit.disabled]).toEqual([true, false]);
  store.commit("edit", (d) => { d.pages[0].name = "x"; });
  toolbar.render();
  expect(undo.disabled).toBe(false);
  // The same button, not a new one: a button that has the focus keeps it.
  expect(el.children[0]).toBe(undo);
});

test("everything is disabled while the view is read-only", () => {
  const { el, toolbar, view } = setup([cmd("a", "edit"), cmd("b", "view")]);
  view.readOnly = true;
  toolbar.render();
  expect(el.children.filter((c) => c.tag === "button").map((b) => b.disabled)).toEqual([true, true]);
});

test("a command that throws from applies is disabled and does not stop the others being drawn", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { el } = setup([cmd("bad", "edit", () => { throw new Error("no"); }), cmd("good", "edit")]);
  expect(el.children.map((b) => b.disabled)).toEqual([true, false]);
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

test("clicking a button gives the stage the focus and then runs the command", () => {
  const { el, ran } = setup([cmd("undo", "edit")]);
  el.children[0].fire("click");
  expect(ran).toEqual(["focus-stage", "run:undo"]);
});

test("a command registered later gets a button, and the buttons are built again", () => {
  const { el, toolbar, view } = setup([cmd("a", "edit")]);
  view.plugin.registries.commands.register(cmd("b", "view"));
  toolbar.render();
  expect(el.children.map((c) => (c.hasClass("lf-sep") ? "|" : c.attrs["aria-label"]))).toEqual(["Name a", "|", "Name b"]);
});
