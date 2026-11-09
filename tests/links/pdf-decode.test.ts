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

test("a PDF page is rendered without requestAnimationFrame (stalled in a hidden window), yielding through messages between slices", async () => {
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), toDataURL: () => "data:image/png;base64,AA" }) });
  const raf = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf);
  const timeout = vi.spyOn(globalThis, "setTimeout");
  // A render task that pauses twice, as pdf.js does after each time slice, calling `onContinue` when it is set.
  const order: string[] = [];
  render.mockImplementationOnce(() => {
    const task: { promise: Promise<void>; onContinue?: (cont: () => void) => void } = { promise: Promise.resolve() };
    task.promise = (async () => {
      await Promise.resolve();
      for (const slice of [1, 2]) {
        await new Promise<void>((resolve) => {
          if (task.onContinue) {
            order.push("paused");
            task.onContinue(resolve);
          }
          else resolve();
        });
        order.push(`slice ${slice}`);
      }
    })();
    return task;
  });
  await decodePdf(new ArrayBuffer(1), 0, 1);
  // pdf.js schedules with requestAnimationFrame unless the intent is "print".
  expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ intent: "print" }));
  expect(order).toEqual(["paused", "slice 1", "paused", "slice 2"]);
  expect(raf).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
  timeout.mockRestore();
  vi.unstubAllGlobals();
});
