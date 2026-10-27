import { checkLocalFonts, registerDevCommands } from "../../src/commands/dev";

const notices: { message: string; timeout?: number }[] = [];
vi.mock("obsidian", () => ({
  Notice: class {
    constructor(message: string, timeout?: number) {
      notices.push({ message, timeout });
    }
  },
}));

beforeEach(() => {
  notices.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("checkLocalFonts", () => {
  test("says so when the API is not there", async () => {
    expect(await checkLocalFonts({})).toBe("window.queryLocalFonts does not exist in this Obsidian.");
  });

  test("counts the fonts it returns", async () => {
    const queryLocalFonts = vi.fn(async () => [{ family: "Arial" }, { family: "Arial" }, { family: "Georgia" }]);
    expect(await checkLocalFonts({ queryLocalFonts })).toBe("window.queryLocalFonts exists and returned 3 fonts.");
  });

  test("is not fooled by one font, or none", async () => {
    expect(await checkLocalFonts({ queryLocalFonts: async () => [{ family: "A" }] })).toContain("returned 1 font.");
    expect(await checkLocalFonts({ queryLocalFonts: async () => [] })).toContain("returned 0 fonts.");
  });

  test("names the error when the call is refused, whether it throws or rejects", async () => {
    const refused = Object.assign(new Error("Must be handling a user gesture"), { name: "SecurityError" });
    expect(await checkLocalFonts({ queryLocalFonts: async () => { throw refused; } })).toBe("window.queryLocalFonts exists but failed: SecurityError.");
    expect(
      await checkLocalFonts({
        queryLocalFonts: () => {
          throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        },
      }),
    ).toBe("window.queryLocalFonts exists but failed: NotAllowedError.");
  });

  test("calls the API before it waits for anything, so the user activation of the command still counts", () => {
    const queryLocalFonts = vi.fn(async () => []);
    void checkLocalFonts({ queryLocalFonts });
    expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  });
});

describe("the check-fonts command", () => {
  function register() {
    const commands: { id: string; name: string; callback: () => void }[] = [];
    registerDevCommands({ addCommand: (c: (typeof commands)[number]) => void commands.push(c) } as never);
    return commands;
  }

  test("is one command with the id and name of the brief", () => {
    const commands = register();
    expect(commands.map((c) => [c.id, c.name])).toEqual([["check-fonts", "Check local font access"]]);
  });

  test("shows the outcome in a notice that stays long enough to read", async () => {
    vi.stubGlobal("window", { queryLocalFonts: async () => [{ family: "Arial" }] });
    try {
      register()[0].callback();
      await vi.waitFor(() => expect(notices).toHaveLength(1));
      expect(notices[0].message).toBe("Link Figures: window.queryLocalFonts exists and returned 1 font.");
      expect(notices[0].timeout).toBeGreaterThanOrEqual(10000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
