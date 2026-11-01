import { mkdir, writeFile, readFile, stat, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { authorized, routeOf } from "./config.mjs";
import { data } from "./sdk.mjs";
import { sendText } from "./api.mjs";
import { workspaceFile } from "./state.mjs";
import { MessageOutput } from "./output.mjs";

const HELP = `OpenCode 云端工作区
直接发消息、图片或文件即可开始任务。
/new [标题] · /sessions · /use 会话ID · /fork
/status · /history · /stop · /rename 标题
/model [供应商/模型] · /agent [名称] · /variant [名称|off]
/commands · /cmd 名称 参数（也可直接 /自定义命令）
/shell 命令 · /compact · /diff · /undo · /redo
/files [目录] · /get 文件路径 · /mcp [connect|disconnect 名称]
/pending · /reply 答案 · /reject
权限通过按钮确认；追问可点选，或回复追问消息填写答案。
多题答案：/reply [["第一题答案"],["第二题答案"]]`;

export class TelegramBot {
  constructor({ client, api, store, config, log = () => {} }) {
    Object.assign(this, { client, api, store, config, log });
    this.abort = new AbortController(); this.jobs = new Set(); this.eventQueue = Promise.resolve();
    this.outputs = new Map(); this.roles = new Map(); this.toolAttachments = new Set();
    this.store.data.actions ||= {}; this.store.data.questions ||= {};
    for (const route of Object.values(this.store.data.routes)) {
      route.sessions ||= route.sessionID ? [route.sessionID] : [];
      route.started ||= {}; route.rendered ||= {}; route.delivered ||= [];
    }
  }
  route(message, user = message.from) {
    const address = routeOf(message);
    const route = this.store.data.routes[address.key] ||= { ...address, sessions: [], delivered: [] };
    route.sessions ||= route.sessionID ? [route.sessionID] : [];
    route.delivered ||= [];
    route.started ||= {}; route.rendered ||= {};
    route.chatType = message.chat.type; route.userID = user.id;
    return route;
  }
  sessionRoute(sessionID) { return Object.values(this.store.data.routes).find((route) => route.sessions.includes(sessionID) &&
    authorized(this.config, { chat: { id: route.chatID, type: route.chatType || "private" }, from: { id: route.userID } })); }
  params(route, extra = {}) { return { directory: this.config.directory, sessionID: route.sessionID, ...extra }; }
  async say(route, text, extra) { return sendText(this.api, route, text, extra); }
  safeError(error) { return String(error?.message || error).replaceAll(this.config.token, "[redacted]").slice(0, 1500); }
  report(route, error) {
    const message = this.safeError(error); this.log("error", message);
    return this.say(route, `操作失败：${message}`).catch(() => {});
  }
  background(route, promise) {
    const job = promise.catch((error) => this.report(route, error)).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }
  async bind(route, session) {
    if (session.directory !== this.config.directory) throw new Error("会话不属于当前 TG 工作区");
    const owner = this.sessionRoute(session.id);
    if (owner && owner.key !== route.key) throw new Error("此会话已由另一个聊天或话题接管");
    route.sessionID = session.id;
    if (!route.sessions.includes(session.id)) route.sessions.push(session.id);
    await this.store.save();
  }
  async session(route) {
    if (route.sessionID) {
      try { return await data(this.client.session.get(this.params(route))); }
      catch (error) {
        // Only a confirmed 404 permits replacing a lost binding. Network/auth failures
        // must never silently create a second session and lose the user's context.
        if (error.status !== 404) throw error;
        route.sessions = route.sessions.filter((id) => id !== route.sessionID); delete route.sessionID;
      }
    }
    const session = await data(this.client.session.create({ directory: this.config.directory,
      title: `Telegram ${route.key}` }));
    await this.bind(route, session); return session;
  }
  async action(route, record) {
    const id = randomBytes(8).toString("hex");
    this.store.data.actions[id] = { route: route.key, ...record };
    const keys = Object.keys(this.store.data.actions);
    for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete this.store.data.actions[key];
    await this.store.save();
    return `oc:${id}`;
  }
  async start() {
    this.me = await this.api.call("getMe");
    if (this.store.data.botID && this.store.data.botID !== this.me.id) {
      throw new Error("此 tg_state 属于另一个 Bot；请指定新的 tg_state 目录");
    }
    this.store.data.botID = this.me.id; await this.store.save();
    const webhook = await this.api.call("getWebhookInfo");
    if (webhook.url) throw new Error("此 Bot 已启用 webhook；请先停用原接入并删除 webhook，再启动本插件");
    await this.api.call("setMyCommands", { commands: [
      ["help", "使用说明"], ["new", "新建会话"], ["sessions", "切换会话"],
      ["status", "任务状态"], ["stop", "停止任务"], ["model", "选择模型"],
      ["agent", "选择 Agent"], ["files", "工作区文件"], ["pending", "待确认和追问"],
    ].map(([command, description]) => ({ command, description })) });
    this.log("info", `Telegram plugin ready for @${this.me.username}`);
    // Reconnect cards and unfinished output after process/container restart.
    for (const route of Object.values(this.store.data.routes)) {
      if (route.sessionID) this.background(route, this.restore(route));
    }
    await this.poll();
  }
  async poll() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.api.call("getUpdates", { offset: this.store.data.offset,
          timeout: 30, allowed_updates: ["message", "callback_query"] }, this.abort.signal);
        failures = 0;
        for (const update of updates) {
          if (this.abort.signal.aborted) break;
          if (update.update_id < this.store.data.offset) continue;
          // Commit before dispatch: never repeat a shell command after a crash.
          // Telegram is a control surface; failed work is retried explicitly by the user.
          this.store.data.offset = update.update_id + 1; await this.store.save();
          await this.handle(update);
        }
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.log("error", this.safeError(error));
        if ([401, 409].includes(error.code)) throw error;
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined,
          { signal: this.abort.signal }).catch(() => {});
      }
    }
  }
  async handle(update) {
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    if (!authorized(this.config, message, callback?.from || message?.from)) {
      if (callback) await this.api.call("answerCallbackQuery", { callback_query_id: callback.id,
        text: "无权操作此 Bot", show_alert: true }).catch(() => {});
      return;
    }
    const route = this.route(message, callback?.from || message.from);
    try {
      if (callback) return await this.callback(route, callback);
      let text = message.text || message.caption || "";
      if (message.chat.type !== "private") {
        const mention = `@${this.me.username}`;
        const addressed = text.includes(mention) || message.reply_to_message?.from?.id === this.me.id;
        // Forum topics are explicitly allowlisted; normal groups require addressing the bot.
        if (!message.message_thread_id && !addressed) return;
        text = text.replaceAll(mention, "").trim();
      }
      const match = text.match(/^\/([\w-]+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/);
      if (match?.[2] && match[2].toLowerCase() !== this.me.username.toLowerCase()) return;
      if (match && !this.media(message)) return await this.command(route, match[1], match[3]?.trim() || "");
      const question = Object.values(this.store.data.questions).find((item) => item.route === route.key &&
        item.messageID === message.reply_to_message?.message_id);
      if (question && text && !this.media(message)) return await this.answerText(route, question, text);
      const parts = await this.inputParts(route, message, text);
      if (!parts.length) return;
      await this.session(route);
      const statuses = await data(this.client.session.status({ directory: this.config.directory }));
      if (statuses?.[route.sessionID] && statuses[route.sessionID].type !== "idle") {
        return await this.say(route, "当前会话仍在执行。可用 /stop 停止，或 /new 开始另一个会话。");
      }
      route.started[route.sessionID] = Date.now(); await this.store.save();
      // Let OpenCode generate its ordered message IDs. A syntactically valid
      // hand-made ID can sort before an existing reply and make a new turn disappear.
      await data(this.client.session.promptAsync(this.params(route, { parts,
        model: route.model, agent: route.agent, variant: route.variant })));
    } catch (error) { await this.report(route, error); }
  }
  media(message) {
    return message.document || message.photo?.at(-1) || message.voice || message.audio || message.video || message.animation || message.video_note;
  }
  async inputParts(route, message, text) {
    const parts = text ? [{ type: "text", text }] : [];
    const media = this.media(message);
    if (!media) return parts;
    if (media.file_size > this.config.maxBytes) throw new Error("文件超过 tg_max_mb");
    const bytes = await this.api.download(media.file_id);
    const original = basename((media.file_name || (message.photo ? "photo.jpg" : "attachment")).replaceAll("\\", "/"));
    const filename = `${randomBytes(8).toString("hex")}-${original.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-160)}`;
    const directory = join(this.config.directory, ".telegram", "uploads", route.key.replaceAll(":", "_"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const actual = await realpath(directory);
    if (relative(this.config.directory, actual).split("/")[0] === "..") throw new Error("上传目录不能指向工作区外部");
    const path = join(directory, filename);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const mime = media.mime_type || (message.photo ? "image/jpeg" : "application/octet-stream");
    parts.push({ type: "text", text: `用户上传文件：${relative(this.config.directory, path)}` });
    if (mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("text/")) {
      parts.push({ type: "file", filename: original, mime, url: pathToFileURL(path).toString() });
    }
    return parts;
  }
  async command(route, name, argument) {
    if (["start", "help"].includes(name)) return this.say(route, HELP);
    if (name === "new") {
      const session = await data(this.client.session.create({ directory: this.config.directory, title: argument || `Telegram ${route.key}` }));
      await this.bind(route, session); return this.say(route, `新会话：${session.id}`);
    }
    if (name === "sessions") {
      const sessions = (await data(this.client.session.list({ directory: this.config.directory, limit: 100 })))
        .filter((session) => session.directory === this.config.directory && (!this.sessionRoute(session.id) || this.sessionRoute(session.id).key === route.key));
      const page = Math.max(0, Number.parseInt(argument || "0", 10) || 0);
      const rows = [];
      for (const session of sessions.slice(page * 10, page * 10 + 10)) rows.push([{ text: `${session.id === route.sessionID ? "✓ " : ""}${session.title || session.id}`.slice(0, 60),
        callback_data: await this.action(route, { kind: "use", sessionID: session.id }) }]);
      if (sessions.length > (page + 1) * 10) rows.push([{ text: "下一页", callback_data: await this.action(route, { kind: "sessions", page: page + 1 }) }]);
      return this.say(route, sessions.length ? "选择会话，也可 /use 会话ID：" : "暂无会话，直接发消息即可创建。", { reply_markup: { inline_keyboard: rows } });
    }
    if (name === "use") {
      if (!argument) throw new Error("用法：/use 会话ID");
      await this.bind(route, await data(this.client.session.get({ directory: this.config.directory, sessionID: argument })));
      await this.restore(route); return this.say(route, `当前会话：${route.sessionID}`);
    }
    if (name === "model") {
      const providers = await data(this.client.provider.list({ directory: this.config.directory }));
      const models = providers.all.filter((provider) => providers.connected.includes(provider.id))
        .flatMap((provider) => Object.keys(provider.models).map((id) => `${provider.id}/${id}`));
      if (argument === "off") { delete route.model; await this.store.save(); return this.say(route, "恢复 OpenCode 会话默认模型。"); }
      if (models.includes(argument)) {
        const slash = argument.indexOf("/"); route.model = { providerID: argument.slice(0, slash), modelID: argument.slice(slash + 1) };
        await this.store.save(); return this.say(route, `模型：${argument}`);
      }
      const filtered = models.filter((model) => !argument || model.includes(argument));
      const rows = [];
      for (const model of filtered.slice(0, 20)) rows.push([{ text: model.slice(0, 60), callback_data: await this.action(route, { kind: "model", model }) }]);
      return this.say(route, `已配置模型（${filtered.length} 个，显示前 20 个）：\n可 /model 关键词 筛选，/model 供应商/模型 选择，/model off 恢复默认。`,
        { reply_markup: { inline_keyboard: rows } });
    }
    if (name === "agent") {
      const agents = (await data(this.client.app.agents({ directory: this.config.directory }))).filter((agent) => !agent.hidden && agent.mode !== "subagent");
      if (argument === "off") { delete route.agent; await this.store.save(); return this.say(route, "恢复 OpenCode 会话默认 Agent。"); }
      if (agents.some((agent) => agent.name === argument)) {
        route.agent = argument; await this.store.save(); return this.say(route, `Agent：${argument}`);
      }
      const rows = [];
      for (const agent of agents) rows.push([{ text: agent.name, callback_data: await this.action(route, { kind: "agent", agent: agent.name }) }]);
      return this.say(route, "选择 Agent：", { reply_markup: { inline_keyboard: rows } });
    }
    if (name === "variant") {
      if (!argument) return this.say(route, `当前 variant：${route.variant || "默认"}。用 /variant 名称 或 /variant off。`);
      if (argument === "off") delete route.variant; else route.variant = argument;
      await this.store.save(); return this.say(route, `variant：${route.variant || "默认"}`);
    }
    if (name === "commands") {
      const commands = await data(this.client.command.list({ directory: this.config.directory }));
      return this.say(route, commands.map((cmd) => `/${cmd.name} ${cmd.description || ""}`).join("\n") || "暂无自定义命令。");
    }
    if (name === "files") {
      const files = await data(this.client.file.list({ directory: this.config.directory, path: argument || "." }));
      return this.say(route, files.slice(0, 100).map((file) => `${file.type === "directory" ? "📁" : "📄"} ${file.path}`).join("\n") || "空目录");
    }
    if (name === "get") {
      if (!argument) throw new Error("用法：/get 工作区内文件路径");
      return this.sendFile(route, await workspaceFile(this.config.directory, argument));
    }
    if (name === "mcp") {
      const [operation, server] = argument.split(/\s+/);
      if (["connect", "disconnect"].includes(operation) && server) {
        await data(this.client.mcp[operation]({ directory: this.config.directory, name: server }));
      }
      const status = await data(this.client.mcp.status({ directory: this.config.directory }));
      return this.say(route, Object.entries(status).map(([key, value]) => `${key}: ${value.status}${value.error ? ` (${value.error})` : ""}`).join("\n") || "未配置 MCP。");
    }
    await this.session(route);
    if (name === "stop") {
      await data(this.client.session.abort(this.params(route))); return this.say(route, "已停止当前会话。");
    }
    if (name === "status") {
      const session = await data(this.client.session.get(this.params(route)));
      const status = await data(this.client.session.status({ directory: this.config.directory }));
      const todos = await data(this.client.session.todo(this.params(route)));
      return this.say(route, `${session.title}\n${session.id}\n工作区：${this.config.directory}\n状态：${status[session.id]?.type || "idle"}\n模型：${route.model ? `${route.model.providerID}/${route.model.modelID}` : "OpenCode 默认"}\nAgent：${route.agent || "OpenCode 默认"}\n${todos.map((todo) => `${todo.status}: ${todo.content}`).join("\n")}`);
    }
    if (name === "history") {
      const messages = await data(this.client.session.messages(this.params(route, { limit: 10 })));
      return this.say(route, messages.map(({ info, parts }) => `${info.role === "user" ? "你" : "OpenCode"}：\n${parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")}`).join("\n\n") || "暂无消息。");
    }
    if (name === "rename") {
      if (!argument) throw new Error("用法：/rename 标题");
      await data(this.client.session.update(this.params(route, { title: argument }))); return this.say(route, `会话标题：${argument}`);
    }
    if (name === "fork") {
      await this.bind(route, await data(this.client.session.fork(this.params(route)))); return this.say(route, `已分叉：${route.sessionID}`);
    }
    if (name === "pending") return this.pending(route);
    if (name === "reply") {
      const questions = Object.values(this.store.data.questions).filter((item) => item.route === route.key && item.request.sessionID === route.sessionID);
      if (questions.length !== 1) throw new Error("请回复具体追问消息，或 /pending 查看当前待答问题");
      return this.answerText(route, questions[0], argument);
    }
    if (name === "reject") {
      const questions = Object.values(this.store.data.questions).filter((item) => item.route === route.key && item.request.sessionID === route.sessionID);
      if (questions.length !== 1) throw new Error("请通过追问消息上的跳过按钮操作");
      await data(this.client.question.reject({ directory: this.config.directory, requestID: questions[0].request.id }));
      delete this.store.data.questions[questions[0].request.id]; await this.store.save(); return this.say(route, "已跳过追问。");
    }
    if (name === "diff") {
      const diffs = await data(this.client.session.diff(this.params(route)));
      const text = diffs.map((diff) => `--- ${diff.file}\n+${diff.additions} -${diff.deletions}\n${diff.before || ""}\n→\n${diff.after || ""}`).join("\n\n");
      if (text.length > 8000) return this.api.document(route, Buffer.from(text), "opencode-diff.txt", "text/plain");
      return this.say(route, text || "暂无文件变更。");
    }
    if (name === "undo") {
      const session = await data(this.client.session.get(this.params(route)));
      const messages = await data(this.client.session.messages(this.params(route)));
      const user = messages.filter(({ info }) => info.role === "user" && (!session.revert || info.id < session.revert.messageID)).at(-1);
      if (!user) throw new Error("没有可撤回的用户消息");
      await data(this.client.session.revert(this.params(route, { messageID: user.info.id })));
      return this.say(route, "已撤回最近一轮及其文件变更。/redo 可恢复。");
    }
    if (name === "redo") {
      await data(this.client.session.unrevert(this.params(route))); return this.say(route, "已恢复撤回内容。");
    }
    if (name === "compact") {
      const model = route.model || await this.currentModel(route);
      this.background(route, data(this.client.session.summarize(this.params(route, model))));
      return this.say(route, "OpenCode 正在压缩会话上下文。");
    }
    if (name === "shell") {
      if (!argument) throw new Error("用法：/shell 命令");
      route.started[route.sessionID] = Date.now(); await this.store.save();
      this.background(route, data(this.client.session.shell(this.params(route, { command: argument,
        agent: route.agent || "build", model: route.model })))); return;
    }
    const commands = await data(this.client.command.list({ directory: this.config.directory }));
    let command = name;
    if (name === "cmd") {
      const match = argument.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      if (!match) throw new Error("用法：/cmd 命令名称 参数");
      command = match[1]; argument = match[2] || "";
    }
    if (!commands.some((cmd) => cmd.name === command)) return this.say(route, "未知命令。/help 查看操作，/commands 查看 OpenCode 自定义命令。");
    route.started[route.sessionID] = Date.now(); await this.store.save();
    this.background(route, data(this.client.session.command(this.params(route, { command, arguments: argument,
      model: route.model ? `${route.model.providerID}/${route.model.modelID}` : undefined, agent: route.agent, variant: route.variant }))));
  }
  async currentModel(route) {
    const session = await data(this.client.session.get(this.params(route)));
    if (session.model) return { providerID: session.model.providerID, modelID: session.model.id };
    const messages = await data(this.client.session.messages(this.params(route, { limit: 20 })));
    const latest = messages.filter(({ info }) => info.role === "assistant").at(-1)?.info;
    if (latest?.providerID && latest?.modelID) return { providerID: latest.providerID, modelID: latest.modelID };
    const config = await data(this.client.config.get({ directory: this.config.directory }));
    if (config.model?.includes("/")) {
      const slash = config.model.indexOf("/"); return { providerID: config.model.slice(0, slash), modelID: config.model.slice(slash + 1) };
    }
    throw new Error("请先 /model 选择模型，或完成一轮对话后再压缩上下文");
  }
  async callback(route, callback) {
    await this.api.call("answerCallbackQuery", { callback_query_id: callback.id });
    const id = callback.data?.startsWith("oc:") ? callback.data.slice(3) : "";
    const action = this.store.data.actions[id];
    if (!action || action.route !== route.key) throw new Error("按钮已失效，或不属于当前聊天。请 /pending 或重新打开菜单。");
    if (action.kind === "use") return this.command(route, "use", action.sessionID);
    if (action.kind === "sessions") return this.command(route, "sessions", String(action.page));
    if (action.kind === "model") return this.command(route, "model", action.model);
    if (action.kind === "agent") return this.command(route, "agent", action.agent);
    if (action.kind === "permission") {
      if (this.sessionRoute(action.sessionID)?.key !== route.key) throw new Error("权限请求不属于当前聊天");
      const requests = await data(this.client.permission.list({ directory: this.config.directory }));
      if (!requests.some((request) => request.id === action.requestID && request.sessionID === action.sessionID)) throw new Error("权限请求已处理");
      await data(this.client.permission.reply({ directory: this.config.directory, requestID: action.requestID, reply: action.reply }));
      await this.api.edit(route, callback.message.message_id, `权限已处理：${action.reply}`);
      delete this.store.data.actions[id]; await this.store.save(); return;
    }
    const item = this.store.data.questions[action.requestID];
    if (!item || item.route !== route.key || this.sessionRoute(item.request.sessionID)?.key !== route.key) throw new Error("追问已处理或不属于当前聊天");
    const pending = await data(this.client.question.list({ directory: this.config.directory }));
    if (!pending.some((request) => request.id === item.request.id)) throw new Error("追问已处理");
    if (action.kind === "reject") {
      await data(this.client.question.reject({ directory: this.config.directory, requestID: item.request.id }));
      delete this.store.data.questions[item.request.id]; await this.store.save();
      return this.api.edit(route, item.messageID, "已跳过追问。");
    }
    if (action.cursor !== item.cursor) throw new Error("此题已回答，请使用最新的追问消息");
    if (action.kind === "choice") {
      const question = item.request.questions[item.cursor];
      const label = question.options[action.option]?.label;
      if (!label) throw new Error("无效选项");
      if (question.multiple) {
        item.selected = item.selected.includes(label) ? item.selected.filter((value) => value !== label) : [...item.selected, label];
        await this.store.save(); return this.showQuestion(route, item, true);
      }
      return this.answerOne(route, item, [label]);
    }
    if (action.kind === "done") {
      if (!item.selected.length) throw new Error("请至少选择一项");
      return this.answerOne(route, item, item.selected);
    }
    throw new Error("未知按钮");
  }
  async permission(route, request) {
    const rows = [];
    for (const [text, reply] of [["允许一次", "once"], ["总是允许", "always"], ["拒绝", "reject"]]) {
      rows.push({ text, callback_data: await this.action(route, { kind: "permission", sessionID: request.sessionID, requestID: request.id, reply }) });
    }
    return this.say(route, `OpenCode 请求权限：${request.permission}\n会话：${request.sessionID}\n${(request.patterns || []).join("\n")}\n${JSON.stringify(request.metadata || {}).slice(0, 2000)}`,
      { reply_markup: { inline_keyboard: [rows] } });
  }
  async question(route, request) {
    const existing = this.store.data.questions[request.id];
    const item = existing || { route: route.key, request, cursor: 0, answers: [], selected: [] };
    this.store.data.questions[request.id] = item;
    await this.store.save(); return this.showQuestion(route, item);
  }
  async showQuestion(route, item, edit = false) {
    const question = item.request.questions[item.cursor]; const rows = [];
    for (let option = 0; option < question.options.length; option++) {
      const choice = question.options[option];
      rows.push([{ text: `${item.selected.includes(choice.label) ? "✓ " : ""}${choice.label}`.slice(0, 60),
        callback_data: await this.action(route, { kind: "choice", requestID: item.request.id, cursor: item.cursor, option }) }]);
    }
    if (question.multiple) rows.push([{ text: "提交已选项", callback_data: await this.action(route, { kind: "done", requestID: item.request.id, cursor: item.cursor }) }]);
    rows.push([{ text: "跳过此请求", callback_data: await this.action(route, { kind: "reject", requestID: item.request.id }) }]);
    const text = `OpenCode 追问 (${item.cursor + 1}/${item.request.questions.length})\n${question.header}\n${question.question}\n${question.options.map((option) => `${option.label}：${option.description}`).join("\n")}\n${question.multiple ? "可多选后提交。" : "请选择。"}${question.custom === false ? "" : "也可回复这条消息填写答案。"}`;
    const extra = { reply_markup: { inline_keyboard: rows } };
    if (edit && item.messageID) await this.api.edit(route, item.messageID, text.slice(0, 4000), extra);
    else item.messageID = (await this.say(route, text, extra)).message_id;
    await this.store.save();
  }
  async answerText(route, item, text) {
    if (!text) throw new Error("答案不能为空");
    if (text.startsWith("[")) {
      let answers;
      try { answers = JSON.parse(text); } catch { throw new Error("答案 JSON 格式错误，应为二维字符串数组"); }
      return this.submitAnswers(route, item, answers);
    }
    return this.answerOne(route, item, [text]);
  }
  async answerOne(route, item, answer) {
    const question = item.request.questions[item.cursor];
    if (question.custom === false && answer.some((value) => !question.options.some((option) => option.label === value))) {
      throw new Error("此题须选择已有选项");
    }
    const answers = [...item.answers]; answers[item.cursor] = answer;
    if (item.cursor + 1 === item.request.questions.length) return this.submitAnswers(route, item, answers);
    item.answers = answers; item.cursor++; item.selected = [];
    await this.store.save(); return this.showQuestion(route, item);
  }
  async submitAnswers(route, item, answers) {
    if (!Array.isArray(answers) || answers.length !== item.request.questions.length || answers.some((answer, index) =>
      !Array.isArray(answer) || !answer.length || answer.some((value) => typeof value !== "string" || !value.trim()) ||
      (!item.request.questions[index].multiple && answer.length > 1) ||
      (item.request.questions[index].custom === false && answer.some((value) => !item.request.questions[index].options.some((option) => option.label === value))))) {
      throw new Error("答案必须逐题填写；单选题只能提供一个答案，禁止自定义的题目须选择已有选项");
    }
    await data(this.client.question.reply({ directory: this.config.directory, requestID: item.request.id, answers }));
    delete this.store.data.questions[item.request.id]; await this.store.save();
    return this.say(route, "已提交答案，OpenCode 将继续执行。");
  }
  async pending(route) {
    const [permissions, questions] = await Promise.all([
      data(this.client.permission.list({ directory: this.config.directory })),
      data(this.client.question.list({ directory: this.config.directory })),
    ]);
    let count = 0;
    for (const request of permissions) if (this.sessionRoute(request.sessionID)?.key === route.key) { await this.permission(route, request); count++; }
    for (const request of questions) if (this.sessionRoute(request.sessionID)?.key === route.key) { await this.question(route, request); count++; }
    for (const [id, item] of Object.entries(this.store.data.questions)) {
      if (item.route === route.key && !questions.some((request) => request.id === id)) delete this.store.data.questions[id];
    }
    await this.store.save();
    if (!count) await this.say(route, "暂无待确认权限或追问。");
  }
  enqueue(event) {
    const job = this.eventQueue.catch(() => {}).then(() => this.event(event));
    this.eventQueue = job.catch((error) => this.log("error", this.safeError(error)));
    // Do not await Telegram I/O inside OpenCode hooks, especially permission.asked.
  }
  async event(event) {
    const props = event.properties || {}; const part = props.part; const info = props.info;
    if (event.type === "message.updated" && info) {
      this.roles.set(info.id, info.role);
      if (this.roles.size > 1000) this.roles.delete(this.roles.keys().next().value);
    }
    const sessionID = part?.sessionID || info?.sessionID || props.sessionID;
    const route = this.sessionRoute(sessionID); if (!route) return;
    if (event.type === "permission.asked") return this.permission(route, props);
    if (event.type === "question.asked") return this.question(route, props);
    if (["question.replied", "question.rejected"].includes(event.type)) {
      delete this.store.data.questions[props.requestID]; await this.store.save(); return;
    }
    if (event.type === "session.error") return this.report(route, new Error(props.error?.data?.message || "OpenCode 会话错误"));
    if (event.type === "message.part.updated" && part) {
      if (route.delivered.includes(part.messageID)) return;
      let role = this.roles.get(part.messageID);
      if (!role) {
        const message = await data(this.client.session.message({ directory: this.config.directory, sessionID, messageID: part.messageID }));
        role = message.info.role; this.roles.set(part.messageID, role);
      }
      if (role !== "assistant") return;
      if (!this.outputs.has(part.messageID)) this.outputs.set(part.messageID,
        new MessageOutput(this.api, route, this.config.interval, (error) => this.log("error", this.safeError(error)),
          route.rendered?.[part.messageID], async (snapshot) => {
            route.rendered ||= {}; route.rendered[part.messageID] = snapshot; await this.store.save();
          }));
      this.outputs.get(part.messageID).update(part);
      if (part.type === "tool" && part.state.status === "completed" && !this.toolAttachments.has(part.id)) {
        this.toolAttachments.add(part.id);
        if (this.toolAttachments.size > 1000) this.toolAttachments.delete(this.toolAttachments.values().next().value);
        for (const attachment of part.state.attachments || []) await this.attachment(route, attachment);
      }
    }
    if (event.type === "message.part.delta") {
      const output = this.outputs.get(props.messageID); const current = output?.parts.get(props.partID);
      if (current && props.field === "text") output.update({ ...current, text: current.text + props.delta });
    }
    if (event.type === "message.updated" && info?.role === "assistant" && info.time?.completed) {
      await this.finishMessage(route, info.id);
    }
    if (event.type === "session.idle" || (event.type === "session.status" && props.status?.type === "idle")) {
      for (const [id, output] of this.outputs) if (output.route.key === route.key && [...output.parts.values()].some((part) => part.sessionID === sessionID)) await this.finishMessage(route, id);
      delete route.started?.[sessionID]; await this.store.save();
    }
  }
  async finishMessage(route, id) {
    const output = this.outputs.get(id); if (!output) return;
    await output.finish(); this.outputs.delete(id); this.roles.delete(id);
    delete route.rendered?.[id];
    if (!route.delivered.includes(id)) route.delivered.push(id);
    route.delivered = route.delivered.slice(-200); await this.store.save();
  }
  restore(route) {
    const job = this.eventQueue.catch(() => {}).then(() => this.reconcile(route));
    this.eventQueue = job.catch((error) => this.log("error", this.safeError(error)));
    return job;
  }
  async reconcile(route) {
    const statuses = await data(this.client.session.status({ directory: this.config.directory }));
    for (const sessionID of route.sessions) {
      if (!route.started?.[sessionID] && (!statuses[sessionID] || statuses[sessionID].type === "idle")) continue;
      const messages = await data(this.client.session.messages({ directory: this.config.directory, sessionID, limit: 100 }));
      const since = route.started?.[sessionID] || messages.filter(({ info }) => info.role === "user").at(-1)?.info.time.created || Date.now();
      for (const message of messages) {
        if (message.info.role !== "assistant" || route.delivered.includes(message.info.id) ||
          message.info.time.created < since) continue;
        await this.event({ type: "message.updated", properties: { info: { ...message.info, time: { ...message.info.time, completed: undefined } } } });
        for (const part of message.parts) await this.event({ type: "message.part.updated", properties: { part } });
        if (message.info.time.completed) await this.finishMessage(route, message.info.id);
      }
    }
    const permissions = await data(this.client.permission.list({ directory: this.config.directory }));
    const questions = await data(this.client.question.list({ directory: this.config.directory }));
    for (const request of permissions) if (this.sessionRoute(request.sessionID)?.key === route.key) await this.permission(route, request);
    for (const request of questions) if (this.sessionRoute(request.sessionID)?.key === route.key) await this.question(route, request);
  }
  async sendFile(route, path, filename, mime) {
    if ((await stat(path)).size > this.config.maxBytes) throw new Error("文件超过 tg_max_mb");
    return this.api.document(route, await readFile(path), filename || basename(path), mime);
  }
  async attachment(route, attachment) {
    const url = new URL(attachment.url);
    if (url.protocol === "file:") {
      const path = fileURLToPath(url);
      return this.sendFile(route, await workspaceFile(this.config.directory, relative(this.config.directory, path)), attachment.filename, attachment.mime);
    }
    if (url.protocol === "data:") {
      const match = attachment.url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
      if (!match) throw new Error("无效文件附件");
      const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
      return this.api.document(route, bytes, attachment.filename || "opencode-output", attachment.mime || match[1]);
    }
    // Tool-produced external URLs are displayed as text; never fetch arbitrary URLs with credentials.
    return this.say(route, `输出文件：${attachment.filename || "附件"}\n${attachment.url}`);
  }
  async close() {
    this.abort.abort(); await this.eventQueue.catch(() => {});
    await Promise.allSettled([...this.outputs.values()].map((output) => output.close()));
    await this.store.save();
  }
}
