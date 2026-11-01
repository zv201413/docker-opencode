import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig, authorized, routeOf } from "../telegram/config.mjs";
import { StateStore, acquireLease, workspaceFile } from "../telegram/state.mjs";
import { TelegramApi, splitText } from "../telegram/api.mjs";
import { TelegramBot } from "../telegram/bot.mjs";
import { MessageOutput } from "../telegram/output.mjs";
import { nativeClient, data } from "../telegram/sdk.mjs";
import { createOpencodeClient as createV1 } from "@opencode-ai/sdk";
import { install } from "../scripts/install-telegram.mjs";

const directory = "/workspace";
const message = (text, extra = {}) => ({ message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text, ...extra });
const result = (value) => Promise.resolve({ data: value });
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "oc-tg-test-"));
  const config = readConfig({ tg_token: "123:test", tg_users: "7", tg_dir: directory, tg_state: temp });
  const store = new StateStore(temp); await store.load();
  const calls = []; const messages = []; let count = 0;
  const api = {
    send: async (route, text, extra) => { messages.push({ route: route.key, text, extra, message_id: ++count }); return { message_id: count }; },
    edit: async (route, id, text, extra) => { messages.push({ route: route.key, text, extra, message_id: id }); },
    call: async (method, params) => { calls.push({ method, params }); return true; },
    document: async (route, bytes, name) => { calls.push({ method: "document", route: route.key, bytes, name }); },
  };
  const sessions = new Map(); let serial = 0;
  const client = {
    session: {
      create: async (params) => { const session = { id: `ses_${++serial}`, title: params.title, directory: params.directory }; sessions.set(session.id, session); return { data: session }; },
      get: (params) => result(sessions.get(params.sessionID)),
      status: () => result({}), messages: () => result([]), todo: () => result([]),
      promptAsync: (params) => { calls.push({ method: "promptAsync", params }); return result(); },
      abort: (params) => { calls.push({ method: "abort", params }); return result(true); },
      shell: (params) => { calls.push({ method: "shell", params }); return result({}); },
      message: (params) => result({ info: { role: "assistant", id: params.messageID }, parts: [] }),
    },
    command: { list: () => result([{ name: "review", description: "Review" }]) },
    provider: { list: () => result({ all: [{ id: "mock", models: { test: {} } }], connected: ["mock"] }) },
    app: { agents: () => result([{ name: "plan", mode: "primary" }, { name: "explore", mode: "subagent" }]) },
    permission: { list: () => result([]), reply: (params) => { calls.push({ method: "permission.reply", params }); return result(true); } },
    question: { list: () => result([]), reply: (params) => { calls.push({ method: "question.reply", params }); return result(true); }, reject: () => result(true) },
  };
  const bot = new TelegramBot({ client, api, config, store }); bot.me = { id: 999, username: "testbot" };
  return { bot, client, config, store, api, calls, messages, temp, sessions };
}

test("authorization requires user IDs and explicit group allowlist; topics isolate sessions", () => {
  assert.equal(readConfig({}), null);
  assert.throws(() => readConfig({ tg_token: "test" }), /numeric/);
  assert.throws(() => readConfig({ tg_token: "test", tg_users: "*" }), /numeric/);
  assert.throws(() => readConfig({ tg_token: "test", tg_users: "7", tg_max_mb: "NaN" }), /tg_max_mb/);
  const config = readConfig({ tg_token: "test", tg_users: "7" });
  assert.equal(authorized(config, message("hello")), true);
  assert.equal(authorized(config, message("hello", { from: { id: 8 } })), false);
  const group = message("hello", { chat: { id: -100, type: "supergroup" } });
  assert.equal(authorized(config, group), false); config.chats.add("-100");
  assert.equal(authorized(config, group), true);
  assert.notEqual(routeOf({ ...group, message_thread_id: 1 }).key, routeOf({ ...group, message_thread_id: 2 }).key);
});

test("native SDK bridge retains injected in-process transport, auth and directory", async () => {
  const requests = [];
  const injected = createV1({ baseUrl: "http://in-process", directory: "/workspace/中文", headers: { authorization: "Basic test" },
    fetch: async (req) => { requests.push(req); return Response.json([]); } });
  const client = await nativeClient(injected);
  await data(client.question.list({ directory: "/workspace/中文" }));
  await data(client.permission.reply({ directory: "/workspace/中文", requestID: "per_1", reply: "once" }));
  assert.equal(requests[0].headers.get("authorization"), "Basic test");
  assert.equal(new URL(requests[0].url).searchParams.get("directory"), "/workspace/中文");
  assert.equal(new URL(requests[1].url).pathname, "/permission/per_1/reply");
  assert.deepEqual(await requests[1].json(), { reply: "once" });
});

test("messages reuse genuine sessions and retain model/agent choices after restart", async () => {
  const f = await fixture();
  await f.bot.handle({ update_id: 1, message: message("first") });
  await f.bot.handle({ update_id: 2, message: message("/model mock/test") });
  await f.bot.handle({ update_id: 3, message: message("/agent plan") });
  await f.bot.handle({ update_id: 4, message: message("second") });
  const prompts = f.calls.filter((call) => call.method === "promptAsync");
  assert.equal(prompts.length, 2); assert.equal(prompts[0].params.sessionID, prompts[1].params.sessionID);
  assert.deepEqual(prompts[1].params.model, { providerID: "mock", modelID: "test" });
  assert.equal(prompts[1].params.agent, "plan");
  assert.deepEqual(prompts[1].params.parts, [{ type: "text", text: "second" }]);
  const restored = new StateStore(f.temp); await restored.load();
  assert.equal(restored.data.routes["7:0"].sessionID, prompts[0].params.sessionID);
  assert.equal((await stat(join(f.temp, "state.json"))).mode & 0o777, 0o600);
  await f.bot.close();
});

test("unauthorized input cannot execute commands; getUpdates commits before dispatch", async () => {
  const f = await fixture();
  await f.bot.handle({ update_id: 1, message: message("/shell id", { from: { id: 8 } }) });
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.size, 0);
  let polls = 0; let dispatches = 0;
  f.api.call = async () => { if (polls++ === 0) return [{ update_id: 11, message: message("hello") }]; f.bot.abort.abort(); return []; };
  f.bot.handle = async () => {
    const restored = new StateStore(f.temp); await restored.load();
    assert.equal(restored.data.offset, 12); dispatches++;
  };
  await f.bot.poll(); assert.equal(dispatches, 1);
});

test("permission buttons check route ownership and fresh native pending requests", async () => {
  const f = await fixture(); await f.bot.handle({ message: message("hello") });
  const route = f.store.data.routes["7:0"];
  const request = { id: "per_1", sessionID: route.sessionID, permission: "bash", patterns: ["git status"] };
  f.client.permission.list = () => result([request]);
  await f.bot.event({ type: "permission.asked", properties: request });
  const card = f.messages.at(-1); const callbackData = card.extra.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(callbackData) <= 64);
  await f.bot.handle({ callback_query: { id: "cb", data: callbackData, from: { id: 7 }, message: message(card.text,
    { from: { id: 999, is_bot: true }, message_id: card.message_id }) } });
  assert.equal(f.calls.find((call) => call.method === "permission.reply").params.reply, "once");
  assert.equal(route.userID, 7);
  f.client.permission.list = () => result([]);
  await f.bot.handle({ callback_query: { id: "stale", data: callbackData, from: { id: 7 }, message: message(card.text) } });
  assert.equal(f.calls.filter((call) => call.method === "permission.reply").length, 1);
  await f.bot.close();
});

test("multi-question and multiple-choice answers return arrays to OpenCode; failed reply is retryable", async () => {
  const f = await fixture(); await f.bot.handle({ message: message("hello") });
  const route = f.store.data.routes["7:0"];
  const request = { id: "que_1", sessionID: route.sessionID, questions: [
    { header: "One", question: "Pick", options: [{ label: "A", description: "A" }], custom: false },
    { header: "Two", question: "Pick many", options: [{ label: "B", description: "B" }, { label: "C", description: "C" }], multiple: true },
  ] };
  await f.bot.question(route, request); const item = f.store.data.questions[request.id];
  await assert.rejects(f.bot.answerOne(route, item, ["wrong"]), /已有选项/);
  assert.equal(item.cursor, 0);
  await f.bot.answerOne(route, item, ["A"]); assert.equal(item.cursor, 1);
  f.client.question.reply = () => Promise.reject(new Error("temporary"));
  await assert.rejects(f.bot.answerOne(route, item, ["B", "C"]), /temporary/);
  assert.equal(item.cursor, 1);
  f.client.question.reply = (params) => { f.calls.push({ method: "question.reply", params }); return result(true); };
  await f.bot.answerOne(route, item, ["B", "C"]);
  assert.deepEqual(f.calls.find((call) => call.method === "question.reply").params.answers, [["A"], ["B", "C"]]);
  assert.equal(f.store.data.questions.que_1, undefined);
  await f.bot.close();
});

test("long streaming output preserves emoji boundaries and updates earlier messages", async () => {
  const f = await fixture(); const route = f.bot.route(message(""));
  const text = "a".repeat(3999) + "😀" + "中".repeat(4500);
  const chunks = splitText(text); assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  let snapshot;
  const output = new MessageOutput(f.api, route, 1000, () => {}, {}, async (value) => { snapshot = structuredClone(value); });
  output.update({ id: "p", type: "text", text }); await output.finish();
  assert.equal(f.messages.length, 3);
  const restored = new MessageOutput(f.api, route, 1000, () => {}, snapshot);
  restored.update({ id: "p", type: "text", text: `${text}!` }); await restored.finish();
  assert.equal(f.messages.length, 4); assert.equal(f.messages.at(-1).message_id, 3);
  await output.close(); await restored.close();
});

test("user text never echoes as assistant output; deltas and tool results stream", async () => {
  const f = await fixture(); await f.bot.handle({ message: message("secret prompt") });
  const route = f.store.data.routes["7:0"];
  await f.bot.event({ type: "message.updated", properties: { info: { id: "msg_user", role: "user", sessionID: route.sessionID } } });
  await f.bot.event({ type: "message.part.updated", properties: { part: { id: "p_user", messageID: "msg_user", sessionID: route.sessionID, type: "text", text: "secret prompt" } } });
  assert.equal(f.bot.outputs.size, 0);
  await f.bot.event({ type: "message.updated", properties: { info: { id: "msg_ai", role: "assistant", sessionID: route.sessionID } } });
  await f.bot.event({ type: "message.part.updated", properties: { part: { id: "p_ai", messageID: "msg_ai", sessionID: route.sessionID, type: "text", text: "hello" } } });
  await f.bot.event({ type: "message.part.delta", properties: { sessionID: route.sessionID, messageID: "msg_ai", partID: "p_ai", field: "text", delta: " world" } });
  await f.bot.event({ type: "message.updated", properties: { info: { id: "msg_ai", role: "assistant", sessionID: route.sessionID, time: { completed: 1 } } } });
  assert.equal(f.messages.at(-1).text, "hello world"); assert.ok(route.delivered.includes("msg_ai"));
  await f.bot.close();
});

test("stop is available while a shell command is still running", async () => {
  const f = await fixture(); let complete;
  f.client.session.shell = () => new Promise((resolve) => { complete = resolve; });
  await f.bot.handle({ message: message("/shell sleep 100") });
  await f.bot.handle({ message: message("/stop") });
  assert.ok(f.calls.some((call) => call.method === "abort"));
  complete({ data: {} }); await Promise.allSettled(f.bot.jobs); await f.bot.close();
});

test("file paths reject traversal and symlink escape; bot lease excludes duplicate consumers", async () => {
  const f = await fixture(); const workspace = join(f.temp, "workspace"); await mkdir(workspace);
  await writeFile(join(workspace, "safe.txt"), "safe"); await writeFile(join(f.temp, "outside.txt"), "outside");
  await symlink(join(f.temp, "outside.txt"), join(workspace, "escape"));
  assert.equal(await workspaceFile(workspace, "safe.txt"), join(workspace, "safe.txt"));
  await assert.rejects(workspaceFile(workspace, "../outside.txt"), /inside/);
  await assert.rejects(workspaceFile(workspace, "escape"), /inside/);
  const release = await acquireLease(f.temp, "test"); assert.ok(release);
  assert.equal(await acquireLease(f.temp, "test"), null); await release();
  const next = await acquireLease(f.temp, "test"); assert.ok(next); await next();
});

test("Telegram errors redact tokens and downloads enforce limits independently of metadata", async () => {
  const config = readConfig({ tg_token: "123:secret", tg_users: "7" }); config.maxBytes = 3;
  const broken = new TelegramApi(config, async () => { throw new Error(`fetch ${config.token}`); });
  await assert.rejects(broken.call("getMe"), (error) => !error.message.includes(config.token));
  let called = 0;
  const download = new TelegramApi(config, async () => called++ === 0
    ? Response.json({ ok: true, result: { file_path: "files/test" } }) : new Response("too big"));
  await assert.rejects(download.download("file"), /exceeds/);
});

test("Node.js and Python installers preserve existing config and install auto-discovered .js wrapper", async () => {
  const f = await fixture(); const target = join(f.temp, "config"); await mkdir(target);
  const existing = { private: true, dependencies: { "another-plugin": "1.0.0" } };
  await writeFile(join(target, "package.json"), JSON.stringify(existing));
  await writeFile(join(target, "opencode.jsonc"), "// user config\n{}");
  await install(target);
  const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["another-plugin"], "1.0.0");
  assert.ok((await readFile(join(target, "plugins", "telegram.js"), "utf8")).includes("plugin.mjs"));
  const process = spawnSync("python3", ["scripts/install-telegram.py", "--config-dir", target], { encoding: "utf8" });
  assert.equal(process.status, 0, process.stderr);
  assert.equal(await readFile(join(target, "opencode.jsonc"), "utf8"), "// user config\n{}");
});
