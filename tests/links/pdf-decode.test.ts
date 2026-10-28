export {};
const render = vi.fn(() => ({ promise: Promise.resolve() }));
vi.mock("obsidian", () => ({
  loadPdfJs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getViewport: () => ({ width: 10, height: 10 }), render }),
      }),
      destroy: async () => {},
    }),
  }),
}));
const { decodePdf } = await import("../../src/links/decoders/pdf");

test("a PDF page is rendered onto a transparent background", async () => {
  const context = {};
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,AA" }) });
  const out = await decodePdf(new ArrayBuffer(1), 0, 1);
  expect(render).toHaveBeenCalledWith(expect.objectContaining({ background: "rgba(0,0,0,0)" }));
  expect(out.pageCount).toBe(1);
  vi.unstubAllGlobals();
});
