# Providers

Open Bot routes one selected provider at a time. It never silently falls back to another account or vendor when authentication, entitlement, or a request fails.

| Provider           | Connect with                       | Notes                                                                  | Primary source                                                                      |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| OpenAI Codex       | ChatGPT/Codex device authorization | Sol, Terra, Luna; Standard and Fast routing                            | [Codex authentication](https://developers.openai.com/codex/auth)                    |
| OpenAI API         | API key                            | Direct OpenAI route and GPT Image 2                                    | [API keys](https://platform.openai.com/api-keys)                                    |
| Anthropic Claude   | Claude Code authorization          | Catalog comes from the local proxy account                             | [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) |
| Google Antigravity | Google OAuth                       | Google models exposed by CLIProxyAPI                                   | [Google OAuth](https://developers.google.com/identity/protocols/oauth2)             |
| Google Vertex AI   | Service-account JSON               | Imported locally, then the temporary upload is deleted                 | [Vertex authentication](https://cloud.google.com/vertex-ai/docs/authentication)     |
| Moonshot Kimi      | Moonshot authorization             | A successful login may still require an active Kimi coding entitlement | [Moonshot platform](https://platform.moonshot.ai/docs/)                             |
| xAI                | xAI authorization                  | Availability and models depend on the connected account                | [xAI API docs](https://docs.x.ai/)                                                  |
| Local server       | Loopback URL                       | Ollama, LM Studio, vLLM, or another OpenAI-compatible server           | [Local models](#local-models)                                                       |

## Local models

The endpoint must use `http://127.0.0.1:<port>/v1` or an equivalent loopback address. Open Bot discovers models from the server and keeps this route local. Tool use depends on the model and server implementing compatible JSON-schema function calling.

- [Ollama OpenAI compatibility](https://docs.ollama.com/openai)
- [LM Studio OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools)
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)

## Credential handling

OAuth credentials are owned by the bundled local CLIProxyAPI sidecar. Direct OpenAI keys and vendor-computer state are protected for the current Windows user. Secrets are excluded from logs and public status responses. See [Privacy](../PRIVACY.md) and [Security](../SECURITY.md).

The OpenAI API key field only accepts a direct `sk-...` key created at [platform.openai.com](https://platform.openai.com/api-keys). A Composio project key (such as `ak_...`) belongs in **Connected apps**, and an OpenRouter key (such as `sk-or-v1-...`) cannot be used with OpenAI's API endpoint.

## Changing models

Settings controls the workspace default. A coworker can override model, reasoning, and Fast mode independently. Clearing an override returns that coworker to the current workspace default.

GPT Image 2 requires a direct OpenAI API key; OAuth routes are not reused for image generation. See [the model reference](https://developers.openai.com/api/docs/models/gpt-image-2).
