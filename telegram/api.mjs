import { setTimeout as delay } from "node:timers/promises";

export class TelegramError extends Error {
  constructor(code, description, retryAfter) {
    super(`Telegram ${code}: ${description}`); this.code = code; this.retryAfter = retryAfter;
  }
}

export class TelegramApi {
  constructor(config, fetcher = fetch) { this.config = config; this.fetch = fetcher; }
  async call(method, body = {}, signal) {
    const url = `${this.config.api}/bot${this.config.token}/${method}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.fetch(url, {
          method: "POST", body: body instanceof FormData ? body : JSON.stringify(body),
          headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Fetch errors can contain the token-bearing URL. Never propagate them to logs or chats.
        throw new Error("Telegram network request failed");
      }
      const result = await response.json().catch(() => null);
      if (result?.ok) return result.result;
      const code = result?.error_code || response.status;
      const description = String(result?.description || "Invalid API response").replaceAll(this.config.token, "[redacted]");
      if (code === 429 && attempt < 3) {
        await delay(Math.max(1, result?.parameters?.retry_after || 1) * 1000, undefined, { signal });
        continue;
      }
      throw new TelegramError(code, description, result?.parameters?.retry_after);
    }
  }
  send(route, text, extra = {}) {
    return this.call("sendMessage", { chat_id: route.chatID, message_thread_id: route.threadID,
      text, link_preview_options: { is_disabled: true }, ...extra });
  }
  edit(route, messageID, text, extra = {}) {
    return this.call("editMessageText", { chat_id: route.chatID, message_id: messageID, text,
      link_preview_options: { is_disabled: true }, ...extra }).catch((error) => {
      if (error.code === 400 && /message is not modified/i.test(error.message)) return;
      throw error;
    });
  }
  async document(route, bytes, name, mime = "application/octet-stream") {
    if (bytes.byteLength > this.config.maxBytes) throw new Error("File exceeds tg_max_mb");
    const form = new FormData();
    form.set("chat_id", String(route.chatID));
    if (route.threadID) form.set("message_thread_id", String(route.threadID));
    form.set("document", new Blob([bytes], { type: mime }), name);
    return this.call("sendDocument", form);
  }
  async download(fileID) {
    const file = await this.call("getFile", { file_id: fileID });
    if (file.file_size > this.config.maxBytes) throw new Error("File exceeds tg_max_mb");
    const path = file.file_path;
    if (!path || path.split("/").some((part) => part === "..") || path.startsWith("/")) throw new Error("Invalid Telegram file path");
    let response;
    try {
      response = await this.fetch(`${this.config.api}/file/bot${this.config.token}/${path}`, {
        signal: AbortSignal.timeout(45_000), redirect: "error",
      });
    } catch { throw new Error("Telegram file download failed"); }
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > this.config.maxBytes) { await response.body.cancel().catch(() => {}); throw new Error("File exceeds tg_max_mb"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

export function splitText(text, limit = 4000) {
  // Telegram counts UTF-16 entities; don't split a surrogate pair across messages.
  const result = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) result.push(text);
  return result;
}

export async function sendText(api, route, text, extra = {}) {
  const parts = splitText(text || "（空）");
  let sent;
  for (let index = 0; index < parts.length; index++) {
    sent = await api.send(route, parts[index], index === parts.length - 1 ? extra : {});
  }
  return sent;
}
