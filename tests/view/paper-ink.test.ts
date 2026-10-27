import { paperInk } from "../../src/view/paper-ink";

test("white paper gets black ink and a grey 60% of the way to the paper", () =>
  expect(paperInk("#ffffff")).toEqual({ ink: "#000000", muted: "#999999" }));

test("black paper gets white ink and a dark grey", () => expect(paperInk("#000000")).toEqual({ ink: "#ffffff", muted: "#666666" }));

test("off-white paper (#f4f4f4) is still light", () => expect(paperInk("#f4f4f4")).toEqual({ ink: "#000000", muted: "#929292" }));

test("a dark colour gets white ink, a pale one black", () => {
  expect(paperInk("#1e1e1e").ink).toBe("#ffffff");
  expect(paperInk("#fdf6e3").ink).toBe("#000000");
  expect(paperInk("#ffee99").ink).toBe("#000000");
  expect(paperInk("#003366").ink).toBe("#ffffff");
});

test("the switch is at a relative luminance of 0.5", () => {
  // Linear luminance of a grey v/255 is 0.5 near v = 188.
  expect(paperInk("#bdbdbd").ink).toBe("#000000");
  expect(paperInk("#bbbbbb").ink).toBe("#ffffff");
});

test("short, upper-case and alpha forms are read; the alpha is ignored", () => {
  expect(paperInk("#fff")).toEqual(paperInk("#ffffff"));
  expect(paperInk("#FFFFFF")).toEqual(paperInk("#ffffff"));
  expect(paperInk("#000000ff")).toEqual(paperInk("#000"));
  expect(paperInk("#00000000")).toEqual(paperInk("#000"));
});

test("paper that is not a hex colour counts as white", () => {
  for (const bad of ["", "white", "rgb(0,0,0)", "#12", "#ggg", "ffffff"]) expect(paperInk(bad)).toEqual(paperInk("#ffffff"));
});
