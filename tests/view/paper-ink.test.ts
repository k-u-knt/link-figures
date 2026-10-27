import { paperInk } from "../../src/view/paper-ink";

test("white paper gets black ink and a grey 60% of the way to the paper", () =>
  expect(paperInk("#ffffff")).toEqual({ ink: "#000000", muted: "#999999" }));

test("black paper gets white ink and a dark grey", () => expect(paperInk("#000000")).toEqual({ ink: "#ffffff", muted: "#666666" }));

test("off-white paper (#f4f4f4) is still light", () => expect(paperInk("#f4f4f4")).toEqual({ ink: "#000000", muted: "#929292" }));

test("mid and dark greys follow the contrast crossover: #999999 gets black ink, #333333 white", () => {
  expect(paperInk("#999999")).toEqual({ ink: "#000000", muted: "#5c5c5c" });
  expect(paperInk("#333333")).toEqual({ ink: "#ffffff", muted: "#858585" });
});

test("a dark colour gets white ink, a pale or mid one black", () => {
  expect(paperInk("#1e1e1e").ink).toBe("#ffffff");
  expect(paperInk("#003366").ink).toBe("#ffffff");
  expect(paperInk("#fdf6e3").ink).toBe("#000000");
  expect(paperInk("#ffee99").ink).toBe("#000000");
  expect(paperInk("#808080").ink).toBe("#000000");
});

test("the switch is at a relative luminance of 0.179, where black and white text have equal contrast", () => {
  // Linear luminance of a grey v/255 is 0.179 at v = 117.4.
  expect(paperInk("#767676").ink).toBe("#000000");
  expect(paperInk("#757575").ink).toBe("#ffffff");
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
