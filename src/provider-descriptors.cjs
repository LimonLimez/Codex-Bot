"use strict";

const MODEL_CATALOG = Object.freeze([
  Object.freeze({
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    description: "Frontier capability for the hardest work.",
  }),
  Object.freeze({
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    description: "Balanced capability and speed.",
  }),
  Object.freeze({
    id: "gpt-5.6-luna",
    label: "5.6 Luna",
    description: "Efficient for quick, routine work.",
  }),
]);

const REASONING_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const LOCAL_REASONING_EFFORTS = Object.freeze(["none"]);

function frozenModels(models) {
  return Object.freeze(
    models.map((model) => Object.freeze({ ...model })),
  );
}

const PROVIDER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    providerId: "openai-codex",
    windowsProviderId: "codex",
    label: "OpenAI Codex",
    description: "Use a ChatGPT account with Codex access.",
    loginKind: "account",
    loginFlag: "-codex-device-login",
    authType: "codex",
    authFilePattern: /^codex-.*\.json$/i,
    defaultModel: "gpt-5.6-terra",
    reasoningEfforts: REASONING_EFFORTS,
    fastModeSupported: true,
    models: MODEL_CATALOG,
  }),
  Object.freeze({
    providerId: "anthropic-claude",
    windowsProviderId: "claude",
    label: "Anthropic Claude",
    description: "Connect a Claude account through Anthropic OAuth.",
    loginKind: "oauth",
    loginFlag: "-claude-login",
    authType: "claude",
    authFilePattern: /^claude-.*\.json$/i,
    defaultModel: "claude-sonnet-5",
    reasoningEfforts: Object.freeze([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    fastModeSupported: false,
    models: frozenModels([
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        description: "Maximum capability for demanding long-horizon work.",
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        description: "Balanced agentic coding and everyday work.",
      },
      {
        id: "claude-fable-5",
        label: "Claude Fable 5",
        description: "Capable general reasoning for broad workflows.",
      },
    ]),
  }),
  Object.freeze({
    providerId: "google-antigravity",
    windowsProviderId: "antigravity",
    label: "Google Antigravity",
    description: "Connect Google models through Antigravity OAuth.",
    loginKind: "oauth",
    loginFlag: "-antigravity-login",
    authType: "antigravity",
    authFilePattern: /^antigravity(?:-.*)?\.json$/i,
    defaultModel: "gemini-3.6-flash-high",
    reasoningEfforts: Object.freeze(["low", "medium", "high"]),
    fastModeSupported: false,
    models: frozenModels([
      {
        id: "gemini-3.6-flash-high",
        label: "Gemini 3.6 Flash",
        description: "Fast Google model with high reasoning.",
      },
      {
        id: "gemini-pro-agent",
        label: "Gemini 3.1 Pro",
        description: "Google's higher-capability agent model.",
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Claude routed through the Antigravity account.",
      },
    ]),
  }),
  Object.freeze({
    providerId: "moonshot-kimi",
    windowsProviderId: "kimi",
    label: "Moonshot Kimi",
    description: "Connect a Kimi account with device authorization.",
    loginKind: "device",
    loginFlag: "-kimi-login",
    authType: "kimi",
    authFilePattern: /^kimi-.*\.json$/i,
    defaultModel: "kimi-k3",
    reasoningEfforts: Object.freeze(["low", "high", "max"]),
    fastModeSupported: false,
    models: frozenModels([
      {
        id: "kimi-k3",
        label: "Kimi K3",
        description: "Moonshot's next-generation flagship model.",
      },
      {
        id: "kimi-k3-256k",
        label: "Kimi K3 256K",
        description: "Kimi K3 with a lower-quota 256K context.",
      },
      {
        id: "kimi-k2.7-code-highspeed",
        label: "Kimi K2.7 Code HighSpeed",
        description: "Coding-focused Kimi with higher output speed.",
      },
    ]),
  }),
  Object.freeze({
    providerId: "xai",
    windowsProviderId: "xai",
    label: "xAI",
    description: "Connect an xAI account with device authorization.",
    loginKind: "device",
    loginFlag: "-xai-login",
    authType: "xai",
    authFilePattern: /^xai-.*\.json$/i,
    defaultModel: "grok-4.5",
    reasoningEfforts: Object.freeze(["none", "low", "medium", "high"]),
    fastModeSupported: false,
    models: frozenModels([
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        description: "xAI's flagship agentic model.",
      },
      {
        id: "grok-4.3",
        label: "Grok 4.3",
        description: "Long-context reasoning with optional thinking.",
      },
      {
        id: "grok-build-0.1",
        label: "Grok Build 0.1",
        description: "Fast coding model for software workflows.",
      },
    ]),
  }),
  Object.freeze({
    providerId: "google-vertex-ai",
    windowsProviderId: "vertex",
    label: "Google Vertex AI",
    description: "Import a Google Cloud service-account JSON key.",
    loginKind: "service-account",
    loginFlag: "-vertex-import",
    authType: "vertex",
    authFilePattern: /^vertex-.*\.json$/i,
    defaultModel: "gemini-3.1-pro",
    reasoningEfforts: Object.freeze(["none", "low", "medium", "high"]),
    fastModeSupported: false,
    models: frozenModels([
      {
        id: "gemini-3.6-flash",
        label: "Gemini 3.6 Flash",
        description: "Fast Vertex model for high-volume work.",
      },
      {
        id: "gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        description: "High-capability Gemini through Google Cloud.",
      },
      {
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        description: "Stable, efficient Vertex model.",
      },
    ]),
  }),
  Object.freeze({
    providerId: "openai-api-key",
    windowsProviderId: "openai-api-key",
    label: "OpenAI API key",
    description: "Use a direct OpenAI API key.",
    loginKind: "api-key",
    loginFlag: null,
    authType: null,
    authFilePattern: /^$/,
    defaultModel: "gpt-5.6-terra",
    reasoningEfforts: REASONING_EFFORTS,
    fastModeSupported: true,
    models: MODEL_CATALOG,
  }),
  Object.freeze({
    providerId: "local",
    windowsProviderId: "local",
    label: "Local models",
    description: "Connect Ollama, LM Studio, or vLLM running on this PC.",
    loginKind: "local",
    loginFlag: null,
    authType: null,
    authFilePattern: /^$/,
    defaultModel: "local-model",
    reasoningEfforts: LOCAL_REASONING_EFFORTS,
    fastModeSupported: false,
    models: Object.freeze([]),
  }),
]);

const PROVIDER_IDS = Object.freeze(
  PROVIDER_DESCRIPTORS.map(({ providerId }) => providerId),
);
const PROVIDER_BY_ID = new Map(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.providerId, descriptor]),
);
const LEGACY_PROVIDER_IDS = Object.freeze({
  codex: "openai-codex",
  claude: "anthropic-claude",
  antigravity: "google-antigravity",
  kimi: "moonshot-kimi",
  vertex: "google-vertex-ai",
  "cliproxy-codex": "openai-codex",
  "cliproxy-anthropic": "anthropic-claude",
  "cliproxy-antigravity": "google-antigravity",
  "cliproxy-kimi": "moonshot-kimi",
  "cliproxy-xai": "xai",
  "cliproxy-vertex": "google-vertex-ai",
});

function tryProviderDescriptor(value) {
  if (typeof value !== "string") return null;
  const providerId = LEGACY_PROVIDER_IDS[value] ?? value;
  return PROVIDER_BY_ID.get(providerId) || null;
}

function canonicalProviderId(value) {
  if (typeof value !== "string") throw new TypeError("Provider ID is invalid.");
  const providerId = LEGACY_PROVIDER_IDS[value] ?? value;
  if (!PROVIDER_BY_ID.has(providerId))
    throw new TypeError("Provider ID is invalid.");
  return providerId;
}

function providerDescriptor(value) {
  return tryProviderDescriptor(value) ||
    (() => {
      throw new TypeError("Provider ID is invalid.");
    })();
}

function providerModelIdentity(providerId, modelId) {
  const canonical = canonicalProviderId(providerId);
  if (
    typeof modelId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(modelId)
  ) {
    throw new TypeError("Model ID is invalid.");
  }
  return JSON.stringify([canonical, modelId]);
}

module.exports = {
  PROVIDER_IDS,
  PROVIDER_DESCRIPTORS,
  canonicalProviderId,
  providerDescriptor,
  tryProviderDescriptor,
  providerModelIdentity,
};
