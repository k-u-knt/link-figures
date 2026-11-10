import { afterLinkUpdates } from "../../src/links/link-updates";

/** Obsidian 1.15's `FileManager.updateQueue` (a promise chain) and `inProgressUpdates`. */
function fileManager() {
  return {
    inProgressUpdates: null as unknown[] | null,
    updateQueue: {
      promise: Promise.resolve() as Promise<unknown>,
      queue(job: () => Promise<unknown>) {
        const next = this.promise.then(job, job);
        this.promise = next;
        return next;
      },
    },
  };
}

describe("afterLinkUpdates", () => {
  test("a write waits for a link update under way, and one queued after it waits for the write", async () => {
    const fm = fileManager();
    const app = { fileManager: fm } as never;
    const order: string[] = [];
    let answer!: () => void;
    void fm.updateQueue.queue(async () => {
      await new Promise<void>((r) => (answer = r));
      order.push("update 1");
    });
    const write = afterLinkUpdates(app, async () => {
      order.push("write");
      return 7;
    });
    void fm.updateQueue.queue(async () => void order.push("update 2"));
    await Promise.resolve();
    expect(order).toEqual([]);
    answer();
    await expect(write).resolves.toBe(7);
    await fm.updateQueue.promise;
    expect(order).toEqual(["update 1", "write", "update 2"]);
  });

  test("a write that fails rejects, and the queue goes on", async () => {
    const fm = fileManager();
    const app = { fileManager: fm } as never;
    await expect(afterLinkUpdates(app, async () => Promise.reject(new Error("disk")))).rejects.toThrow("disk");
    await expect(afterLinkUpdates(app, async () => "ok")).resolves.toBe("ok");
  });

  test("inside a link update's own job, or without the queue, a write runs at once", async () => {
    const fm = fileManager();
    fm.inProgressUpdates = [];
    let ran = false;
    void fm.updateQueue.queue(() => new Promise(() => {}));
    const inside = afterLinkUpdates({ fileManager: fm } as never, async () => (ran = true));
    await inside;
    expect(ran).toBe(true);
    await expect(afterLinkUpdates({} as never, async () => "plain")).resolves.toBe("plain");
  });
});
