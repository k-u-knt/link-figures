/** What `normalizePath` does in Obsidian: forward slashes, no repeats, none at either end (`"/"` stays). */
export const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "") || "/";

export class FakeTFile {
  constructor(readonly path: string) {}
}
export class FakeTFolder {
  constructor(readonly path: string) {}
}

/** Just the parts of an Obsidian vault that writing a file touches, recording what was done to it. */
export function fakeVault() {
  const entries = new Map<string, FakeTFile | FakeTFolder>();
  const content = new Map<string, ArrayBuffer>();
  const calls: string[] = [];
  const vault = {
    entries,
    content,
    calls,
    /** Make `createFolder` fail with this message, once per path it is asked for. */
    createFolderError: null as string | null,
    getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
    async createFolder(path: string) {
      calls.push(`createFolder ${path}`);
      if (vault.createFolderError) throw new Error(vault.createFolderError);
      const folder = new FakeTFolder(path);
      entries.set(path, folder);
      return folder;
    },
    async createBinary(path: string, data: ArrayBuffer) {
      calls.push(`createBinary ${path}`);
      const file = new FakeTFile(path);
      entries.set(path, file);
      content.set(path, data);
      return file;
    },
    async modifyBinary(file: FakeTFile, data: ArrayBuffer) {
      calls.push(`modifyBinary ${file.path}`);
      content.set(file.path, data);
    },
  };
  return vault;
}
