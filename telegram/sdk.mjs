// OpenCode currently injects its v1 SDK, whose generated types omit question.*.
// Reuse its existing transport (including in-process fetch and server auth) with
// the official v2 SDK. This is the only version-specific compatibility boundary.
export async function nativeClient(injected) {
  if (injected.question?.reply && injected.permission?.reply) return injected;
  const transport = injected._client;
  if (typeof transport?.getConfig !== "function") {
    throw new Error("Unsupported OpenCode plugin SDK transport; use OpenCode >= 1.18.3");
  }
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const config = transport.getConfig();
  // getConfig() normalizes headers to a Headers instance. The v2 directory
  // helper spreads plain objects, so normalize before passing them through.
  return createOpencodeClient({ ...config, headers: Object.fromEntries(new Headers(config.headers)) });
}

export async function data(request) {
  const response = await request;
  if (response.error) {
    const error = response.error;
    const failure = new Error(error.data?.message || error.message || "OpenCode operation failed");
    failure.status = response.response?.status;
    throw failure;
  }
  return response.data;
}
