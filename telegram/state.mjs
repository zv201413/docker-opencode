import { mkdir, open, readFile, rename, unlink, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join, relative, isAbsolute } from "node:path";

export class StateStore {
  constructor(directory) { this.directory = directory; this.data = { offset: 0, routes: {} }; this.writes = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"));
      if (!Number.isSafeInteger(this.data.offset) || !this.data.routes) throw new Error("Invalid Telegram state");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  save() {
    const snapshot = JSON.stringify(this.data);
    const write = this.writes.catch(() => {}).then(async () => {
      const path = join(this.directory, "state.json");
      const file = await open(`${path}.tmp`, "w", 0o600);
      try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); }
      await rename(`${path}.tmp`, path);
    });
    this.writes = write;
    return write;
  }
}

// A bot has one getUpdates consumer. The OS releases this lease on plugin disposal;
// a crashed process can be recovered without deleting another live consumer's state.
export async function acquireLease(directory, token) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(token).digest("hex").slice(0, 20);
  const path = join(directory, `bot-${name}.lock`);
  let file;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { file = await open(path, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (owner.host === hostname()) {
          try { process.kill(owner.pid, 0); } catch (err) { stale = err.code === "ESRCH"; }
        } else stale = Date.now() - (await stat(path)).mtimeMs > 120_000;
      } catch (err) {
        if (err.code === "ENOENT") continue;
        // Recover a process that died between creating the lock and writing its owner.
        if (err instanceof SyntaxError) stale = Date.now() - (await stat(path)).mtimeMs > 120_000;
        else throw err;
      }
      if (!stale) return null;
      await unlink(path).catch((err) => { if (err.code !== "ENOENT") throw err; });
    }
  }
  if (!file) return null;
  await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
  const timer = setInterval(() => file.utimes(new Date(), new Date()).catch(() => {}), 30_000);
  timer.unref();
  return async () => { clearInterval(timer); await file.close(); await unlink(path).catch(() => {}); };
}

export async function workspaceFile(root, filename) {
  const base = await realpath(root);
  const path = await realpath(join(base, filename));
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("File must be inside the Telegram workspace");
  if (!(await stat(path)).isFile()) throw new Error("Not a regular file");
  return path;
}
