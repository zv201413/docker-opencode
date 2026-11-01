import { homedir } from "node:os";
import { resolve } from "node:path";

export function readConfig(env = process.env, cwd = process.cwd()) {
  const value = (short, full, fallback = "") => env[short] || env[full] || fallback;
  const token = value("tg_token", "TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  const ids = (text) => new Set(text.split(/[\s,]+/).filter(Boolean));
  const users = ids(value("tg_users", "TELEGRAM_USER_IDS"));
  const chats = ids(value("tg_chats", "TELEGRAM_CHAT_IDS"));
  if (!users.size || [...users].some((id) => !/^\d+$/.test(id))) {
    throw new Error("tg_users / TELEGRAM_USER_IDS must contain numeric Telegram user IDs");
  }
  if ([...chats].some((id) => !/^-?\d+$/.test(id))) throw new Error("Invalid Telegram chat IDs");
  const maxBytes = Number(value("tg_max_mb", "TELEGRAM_MAX_FILE_MB", "20")) * 1024 * 1024;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > 50 * 1024 * 1024) {
    throw new Error("tg_max_mb must be greater than 0 and at most 50");
  }
  const interval = Number(value("tg_interval", "TELEGRAM_STREAM_INTERVAL", "1500"));
  if (!Number.isFinite(interval) || interval < 1000) throw new Error("tg_interval must be at least 1000 ms");
  const api = new URL(value("tg_api", "TELEGRAM_API_URL", "https://api.telegram.org"));
  if (!/^https?:$/.test(api.protocol) || api.username || api.password || api.search || api.hash) {
    throw new Error("Invalid Telegram API URL");
  }
  return {
    token, users, chats, maxBytes, interval, api: api.toString().replace(/\/$/, ""),
    directory: resolve(value("tg_dir", "TELEGRAM_DIRECTORY", cwd)),
    stateDir: resolve(value("tg_state", "TELEGRAM_STATE_DIR",
      `${env.XDG_STATE_HOME || `${homedir()}/.local/state`}/opencode/telegram`)),
  };
}

export function routeOf(message) {
  return { key: `${message.chat.id}:${message.message_thread_id || 0}`,
    chatID: message.chat.id, threadID: message.message_thread_id || undefined };
}

export function authorized(config, message, user = message?.from) {
  return !!message?.chat && !!user && !user.is_bot && config.users.has(String(user.id)) &&
    (message.chat.type === "private"
      ? !config.chats.size || config.chats.has(String(message.chat.id))
      : config.chats.has(String(message.chat.id)));
}
