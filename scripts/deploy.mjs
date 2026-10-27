// Copies main.js, manifest.json and styles.css into an Obsidian vault's plugin folder.
// `npm run deploy` copies into test-vault, and into $OBSIDIAN_VAULT too when that is set.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "link-figures";
const FILES = ["main.js", "manifest.json", "styles.css"];

function copyInto(vault) {
  const dir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  for (const file of FILES) copyFileSync(join(root, file), join(dir, file));
  console.log(`deploy: ${dir}`);
}

/** Copy the plugin files into test-vault, and into $OBSIDIAN_VAULT when requested and set. */
export function copyToPlugin({ includeEnvVault = true } = {}) {
  if (!existsSync(join(root, "main.js"))) {
    throw new Error("main.js not found: run `npm run build` first");
  }
  copyInto(join(root, "test-vault"));
  const envVault = process.env.OBSIDIAN_VAULT;
  if (includeEnvVault && envVault) {
    if (!existsSync(envVault)) throw new Error(`OBSIDIAN_VAULT does not exist: ${envVault}`);
    copyInto(envVault);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    copyToPlugin();
  } catch (error) {
    console.error(`deploy: ${error.message}`);
    process.exit(1);
  }
}
