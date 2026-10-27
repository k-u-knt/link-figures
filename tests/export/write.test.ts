import { FakeTFile, FakeTFolder, fakeVault, normalizePath } from "./fake-vault";
import type { LinkFiguresSettings } from "../../src/settings/settings";

vi.mock("obsidian", async () => {
  const fake = await import("./fake-vault");
  return { normalizePath: fake.normalizePath, TFile: fake.FakeTFile };
});
const { exportFolderFor, writeExportFile } = await import("../../src/export/write");

const settings = (exportFolder: string): LinkFiguresSettings => ({
  attachmentFolder: "",
  openAsFigure: true,
  defaultPreset: "nature-double",
  exportFolder,
  exportDpi: 300,
});
const blob = (text: string) => new Blob([text]);
const text = (data: ArrayBuffer | undefined) => new TextDecoder().decode(data);
const asApp = (vault: ReturnType<typeof fakeVault>) => ({ vault }) as unknown as Parameters<typeof writeExportFile>[0];

test("exports go to the export folder setting when there is one, else beside the figure", () => {
  expect(exportFolderFor(settings("exports"), "Figures/Fig.lnkfig.md")).toBe("exports");
  expect(exportFolderFor(settings(""), "Figures/Papers/Fig.lnkfig.md")).toBe("Figures/Papers");
  expect(exportFolderFor(settings(""), "Fig.lnkfig.md")).toBe("");
});

test("a new file is created with the blob's bytes", async () => {
  const vault = fakeVault();
  const file = await writeExportFile(asApp(vault), "", "Fig - Page 1.svg", blob("<svg/>"));
  expect(vault.calls).toEqual(["createBinary Fig - Page 1.svg"]);
  expect(file.path).toBe("Fig - Page 1.svg");
  expect(text(vault.content.get("Fig - Page 1.svg"))).toBe("<svg/>");
});

test("a file that exists is modified in place, not duplicated or refused", async () => {
  const vault = fakeVault();
  await writeExportFile(asApp(vault), "out", "a.svg", blob("one"));
  const again = await writeExportFile(asApp(vault), "out", "a.svg", blob("two"));
  expect(vault.calls).toEqual(["createFolder out", "createBinary out/a.svg", "modifyBinary out/a.svg"]);
  expect(again).toBeInstanceOf(FakeTFile);
  expect(text(vault.content.get("out/a.svg"))).toBe("two");
});

test("missing folders are created from the top down, and existing ones are left alone", async () => {
  const vault = fakeVault();
  vault.entries.set("a", new FakeTFolder("a"));
  await writeExportFile(asApp(vault), "a/b/c", "x.svg", blob("x"));
  expect(vault.calls).toEqual(["createFolder a/b", "createFolder a/b/c", "createBinary a/b/c/x.svg"]);
});

test("the folder is normalised, and '/' means the vault root", async () => {
  const vault = fakeVault();
  await writeExportFile(asApp(vault), "/out//sub/", "x.svg", blob("x"));
  expect(vault.calls).toEqual(["createFolder out", "createFolder out/sub", "createBinary out/sub/x.svg"]);
  const root = fakeVault();
  await writeExportFile(asApp(root), "/", "y.svg", blob("y"));
  expect(root.calls).toEqual(["createBinary y.svg"]);
  expect(normalizePath("/")).toBe("/");
});

test("'folder already exists' from the vault is not an error, any other failure is", async () => {
  const stale = fakeVault();
  stale.createFolderError = "Folder already exists.";
  await expect(writeExportFile(asApp(stale), "out", "x.svg", blob("x"))).resolves.toBeInstanceOf(FakeTFile);

  const broken = fakeVault();
  broken.createFolderError = "Permission denied";
  await expect(writeExportFile(asApp(broken), "out", "x.svg", blob("x"))).rejects.toThrow("Permission denied");
  expect(broken.calls).not.toContain("createBinary out/x.svg");
});

test("a file where the folder should be, or a folder where the file should be, is reported", async () => {
  const fileInTheWay = fakeVault();
  fileInTheWay.entries.set("out", new FakeTFile("out"));
  await expect(writeExportFile(asApp(fileInTheWay), "out", "x.svg", blob("x"))).rejects.toThrow('"out" is a file');

  const folderInTheWay = fakeVault();
  folderInTheWay.entries.set("x.svg", new FakeTFolder("x.svg"));
  await expect(writeExportFile(asApp(folderInTheWay), "", "x.svg", blob("x"))).rejects.toThrow('"x.svg" is a folder');
});

test("characters a file name cannot hold do not make subfolders", async () => {
  const vault = fakeVault();
  await writeExportFile(asApp(vault), "out", "Fig - A/B: ../c.svg", blob("x"));
  expect(vault.calls).toEqual(["createFolder out", "createBinary out/Fig - A-B- ..-c.svg"]);
});
