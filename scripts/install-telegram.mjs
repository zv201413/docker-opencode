#!/usr/bin/env node
import { mkdir, readFile, writeFile, cp, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export async function install(configDir) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolve(configDir);
  await mkdir(join(target, "plugins"), { recursive: true });
  const manifestPath = join(target, "package.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; manifest = { private: true }; }
  // Keep unrelated plugins and dependencies. OpenCode installs this official SDK
  // in its own runtime; the Python installer does not need system Node.js.
  manifest.dependencies ||= {};
  manifest.dependencies["@opencode-ai/sdk"] = "1.19.5";
  const library = join(target, "telegram");
  if (await realpath(source) !== target) await cp(join(source, "telegram"), library, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const wrapper = "export { default } from '../telegram/plugin.mjs';\n";
  await writeFile(join(target, "plugins", "telegram.js"), wrapper);
  console.log(`Telegram plugin installed: ${join(target, "plugins", "telegram.js")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--config-dir");
  if (index >= 0 && !process.argv[index + 1]) throw new Error("--config-dir requires a directory");
  await install(index >= 0 ? process.argv[index + 1] : process.env.OPENCODE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode"));
}
