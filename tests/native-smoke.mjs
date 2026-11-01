// Opt-in integration test: real OpenCode, local Telegram + model fixtures.
// No BotFather token, external Telegram chat or paid model is used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { install } from "../scripts/install-telegram.mjs";

const root = await mkdtemp(join(tmpdir(), "opencode-native-tg-"));
const workspace = join(root, "workspace"); await mkdir(workspace);
const config = join(root, "config", "opencode"); await install(config);
const version = spawnSync(process.env.OPENCODE_BIN || "opencode", ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
const dependencies = spawnSync("npm", ["install", "--prefix", config, `@opencode-ai/plugin@${version.stdout.trim()}`,
  "--ignore-scripts", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=20000"], { encoding: "utf8", timeout: 120_000 });
assert.equal(dependencies.status, 0, dependencies.stderr);
const updates = []; const messages = []; const requests = []; let updateID = 0; let messageID = 100;
const emit = (text) => updates.push({ update_id: ++updateID, message: {
  message_id: updateID, from: { id: 7 }, chat: { id: 7, type: "private" }, text,
} });
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  let payload = {}; try { payload = JSON.parse(body); } catch {}
  requests.push({ url: req.url, payload });
  if (req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1,
      model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const last = payload.messages?.at(-1);
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
    if (text?.includes("native-shell-tool") && last.role === "user") {
      event({ role: "assistant", tool_calls: [{ index: 0, id: "call_native", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf native-tool-ok", description: "Native shell smoke test" }) } }] });
      event({}, "tool_calls");
    } else if (text?.includes("native-question-tool") && last.role === "user") {
      event({ role: "assistant", tool_calls: [{ index: 0, id: "call_question", type: "function", function: { name: "question", arguments: JSON.stringify({ questions: [
        { header: "Native", question: "Pick a native answer", options: [{ label: "Proceed", description: "Continue execution" }] },
      ] }) } }] });
      event({}, "tool_calls");
    } else {
      event({ role: "assistant", content: "native-plugin-ok" }); event({}, "stop");
    }
    res.end("data: [DONE]\n\n"); return;
  }
  let result = true;
  if (req.url.endsWith("/getMe")) result = { id: 999, is_bot: true, username: "native_testbot" };
  if (req.url.endsWith("/getWebhookInfo")) result = { url: "" };
  if (req.url.endsWith("/getUpdates")) {
    await delay(150); result = updates.filter((update) => update.update_id >= (payload.offset || 0));
  }
  if (req.url.endsWith("/sendMessage")) { messages.push(payload); result = { message_id: ++messageID }; }
  if (req.url.endsWith("/editMessageText")) { messages.push(payload); result = { message_id: payload.message_id }; }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result }));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const api = `http://127.0.0.1:${server.address().port}`;
await writeFile(join(config, "opencode.json"), JSON.stringify({
  model: "native/test", small_model: "native/test", permission: { bash: "ask" },
  provider: { native: { npm: "@ai-sdk/openai-compatible", name: "Native fixture",
    options: { baseURL: `${api}/v1`, apiKey: "fixture" }, models: { test: { name: "test", limit: { context: 8192, output: 1024 } } } } },
}));
let output = "";
const env = {
  PATH: process.env.PATH, LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_TEST_HOME: root,
  TELEGRAM_BOT_TOKEN: "123:fixture", TELEGRAM_USER_IDS: "7", TELEGRAM_API_URL: api,
  TELEGRAM_DIRECTORY: workspace, TELEGRAM_STATE_DIR: join(root, "telegram-state"),
  OPENCODE_SERVER_PASSWORD: "fixture-password",
  HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, ALL_PROXY: process.env.ALL_PROXY,
  NO_PROXY: "127.0.0.1,localhost",
};
const portServer = createServer(); await new Promise((done) => portServer.listen(0, "127.0.0.1", done));
const port = portServer.address().port; await new Promise((done) => portServer.close(done));
Object.assign(env, { OPENCODE_BIN: process.env.OPENCODE_BIN || "opencode", OPENCODE_PORT: String(port), OPENCODE_HOST: "127.0.0.1", OPENCODE_MODE: "serve" });
const child = spawn("bash", [resolve("scripts/start-opencode.sh")], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
let exitCode; child.on("exit", (code) => { exitCode = code; });
async function waitFor(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (exitCode !== undefined) throw new Error(`OpenCode exited (${exitCode}) during ${label}: ${output.slice(-3000)}`);
    await delay(250);
  }
  throw new Error(`Timed out: ${label}\n${output.slice(-3000)}\n${messages.map((message) => message.text).join("\n").slice(-3000)}`);
}
const headers = { authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` };
try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/global/health`,
      { headers, signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
  }, "server + plugin initialization");
  await waitFor(() => requests.some((req) => req.url.endsWith("/getUpdates")), "native Telegram polling");
  emit("/new native-smoke"); await waitFor(() => messages.some((message) => message.text.startsWith("新会话")), "native session create");
  emit("hello native"); await waitFor(() => messages.some((message) => message.text.includes("native-plugin-ok")), "native model reply + plugin events");
  const state = JSON.parse(await readFile(join(root, "telegram-state", "state.json"), "utf8"));
  const sessionID = state.routes["7:0"].sessionID;
  const nativeSession = await (await fetch(`http://127.0.0.1:${port}/session/${sessionID}?directory=${encodeURIComponent(workspace)}`, { headers })).json();
  assert.equal(nativeSession.directory, workspace);
  emit("native-shell-tool"); await waitFor(() => messages.some((message) => message.text.includes("请求权限：bash")), "native bash permission event");
  const permission = messages.findLast((message) => message.text.includes("请求权限：bash"));
  updates.push({ update_id: ++updateID, callback_query: { id: "native-callback", from: { id: 7 },
    data: permission.reply_markup.inline_keyboard[0][0].callback_data,
    message: { message_id: messageID, chat: { id: 7, type: "private" }, from: { id: 999, is_bot: true } } } });
  await waitFor(() => messages.some((message) => message.text.includes("权限已处理：once")), "native permission callback");
  await waitFor(() => messages.some((message) => message.text.includes("✓ bash")), "native tool result events");
  await waitFor(async () => {
    const status = await (await fetch(`http://127.0.0.1:${port}/session/status?directory=${encodeURIComponent(workspace)}`, { headers })).json();
    return !status[sessionID] || status[sessionID].type === "idle";
  }, "tool turn complete");
  emit("native-question-tool");
  await waitFor(() => messages.some((message) => message.text.includes("Pick a native answer")), "native question event");
  const question = messages.findLast((message) => message.text.includes("Pick a native answer"));
  updates.push({ update_id: ++updateID, callback_query: { id: "native-question-callback", from: { id: 7 },
    data: question.reply_markup.inline_keyboard[0][0].callback_data,
    message: { message_id: messageID, chat: { id: 7, type: "private" }, from: { id: 999, is_bot: true } } } });
  await waitFor(() => messages.some((message) => message.text.includes("已提交答案")), "native question callback");
  console.log(`PASS: real OpenCode session, authenticated transport, model reply, bash approval/execution and question callback. Artifacts: ${root}`);
} finally {
  await writeFile(join(root, "smoke-results.json"), JSON.stringify({ requests, messages, output }, null, 2));
  child.kill("SIGTERM");
  await Promise.race([new Promise((done) => child.once("exit", done)), delay(5000).then(() => child.kill("SIGKILL"))]);
  server.closeAllConnections(); await new Promise((done) => server.close(done));
}
