import { SelectionState } from "../../src/view/selection";

test("set replaces the selection, drops repeats and keeps the order", () => {
  const s = new SelectionState();
  s.set(["b", "a", "b"]);
  expect([...s.ids]).toEqual(["b", "a"]);
  expect(s.has("a")).toBe(true);
  expect(s.has("z")).toBe(false);
});

test("toggle adds an id that is not selected and removes one that is", () => {
  const s = new SelectionState();
  s.toggle("a"); s.toggle("b");
  expect([...s.ids]).toEqual(["a", "b"]);
  s.toggle("a");
  expect([...s.ids]).toEqual(["b"]);
});

test("clear empties the selection", () => {
  const s = new SelectionState();
  s.set(["a", "b"]);
  s.clear();
  expect([...s.ids]).toEqual([]);
});

test("listeners hear each change with a copy of the ids, and none for a no-op", () => {
  const s = new SelectionState();
  const heard: string[][] = [];
  s.onChange((ids) => heard.push(ids));
  s.set(["a"]);
  s.set(["a"]);
  s.toggle("b");
  s.clear();
  s.clear();
  expect(heard).toEqual([["a"], ["a", "b"], []]);
  heard[0].push("mutated");
  expect([...s.ids]).toEqual([]);
});

test("a reference to ids taken earlier is not changed by later edits", () => {
  const s = new SelectionState();
  s.set(["a"]);
  const before = s.ids;
  s.toggle("b");
  expect([...before]).toEqual(["a"]);
});

test("onChange returns an unsubscribe, which may be called from inside a listener", () => {
  const s = new SelectionState();
  let calls = 0;
  const off = s.onChange(() => { calls++; off(); });
  let other = 0;
  s.onChange(() => { other++; });
  s.set(["a"]);
  s.set(["b"]);
  expect(calls).toBe(1);
  expect(other).toBe(2);
});
