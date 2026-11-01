import { splitText } from "./api.mjs";

// One renderer per assistant message. Events update a snapshot immediately;
// Telegram writes are serialized and throttled independently of agent execution.
export class MessageOutput {
  constructor(api, route, interval, onError, snapshot = {}, save = async () => {}) {
    this.api = api; this.route = route; this.interval = interval; this.onError = onError;
    this.parts = new Map(); this.sent = snapshot.sent || []; this.texts = snapshot.texts || []; this.queue = Promise.resolve();
    this.save = save;
  }
  update(part) {
    this.parts.set(part.id, part);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush().catch(this.onError); }, this.interval);
      this.timer.unref();
    }
  }
  text() {
    const lines = [];
    for (const part of this.parts.values()) {
      if (part.type === "text" && !part.synthetic && !part.ignored) lines.push(part.text);
      if (part.type === "tool") {
        const state = part.state;
        const icon = state.status === "completed" ? "✓" : state.status === "error" ? "✗" : "⏳";
        lines.push(`${icon} ${part.tool}: ${String(state.title || state.error || "执行中").slice(0, 250)}`);
      }
    }
    return lines.filter(Boolean).join("\n\n") || "⏳ OpenCode 正在处理…";
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const text = this.text();
    const job = this.queue.catch(() => {}).then(async () => {
      const chunks = splitText(text);
      for (let index = 0; index < chunks.length; index++) {
        if (this.texts[index] === chunks[index]) continue;
        if (this.sent[index]) await this.api.edit(this.route, this.sent[index], chunks[index]);
        else this.sent[index] = (await this.api.send(this.route, chunks[index])).message_id;
        this.texts[index] = chunks[index];
        await this.save({ sent: this.sent, texts: this.texts });
      }
      for (let index = chunks.length; index < this.sent.length; index++) {
        if (this.texts[index] !== "（内容已更新）") {
          await this.api.edit(this.route, this.sent[index], "（内容已更新）");
          this.texts[index] = "（内容已更新）";
          await this.save({ sent: this.sent, texts: this.texts });
        }
      }
    });
    this.queue = job;
    return job;
  }
  async finish() { await this.flush(); }
  async close() { clearTimeout(this.timer); await this.queue.catch(() => {}); }
}
