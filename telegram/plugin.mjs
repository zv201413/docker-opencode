import { realpath } from "node:fs/promises";
import { readConfig } from "./config.mjs";
import { StateStore, acquireLease } from "./state.mjs";
import { TelegramApi } from "./api.mjs";
import { nativeClient } from "./sdk.mjs";
import { TelegramBot } from "./bot.mjs";

// Export only the plugin function: OpenCode treats every legacy module export
// as a plugin. Helpers live in other modules, outside its auto-loaded directory.
export default async function TelegramPlugin(context) {
  const config = readConfig();
  if (!config) return {};
  if (await realpath(context.directory) !== await realpath(config.directory)) return {};
  config.directory = await realpath(config.directory);
  const release = await acquireLease(config.stateDir, config.token);
  if (!release) return {};
  let bot;
  try {
    const store = new StateStore(config.stateDir); await store.load();
    if (store.data.directory && store.data.directory !== config.directory) {
      throw new Error("Telegram workspace changed; choose a new tg_state directory");
    }
    store.data.directory = config.directory; await store.save();
    const client = await nativeClient(context.client);
    const log = (level, message) => context.client.app.log({ body: {
      service: "telegram", level, message: message.replaceAll(config.token, "[redacted]"),
    } }).catch(() => {});
    bot = new TelegramBot({ client, store, config, api: new TelegramApi(config), log });
    let disposed = false;
    const dispose = async () => { if (disposed) return; disposed = true; try { await bot.close(); } finally { await release(); } };
    // Startup/polling runs independently; returning hooks must not wait for getUpdates.
    void bot.start().catch(async (error) => { log("error", bot.safeError(error)); await dispose(); })
      .catch((error) => log("error", bot.safeError(error)));
    return {
      event: async ({ event }) => {
        if (event.type === "server.instance.disposed") { await dispose(); return; }
        bot.enqueue(event);
      },
      dispose,
    };
  } catch (error) { if (bot) await bot.close(); await release(); throw error; }
}
