# pi-custom-provider-manager

A [Pi](https://pi.dev) extension for adding and managing custom LLM providers: point it at an endpoint and the models show up in `/model`.

Supports four Pi API implementations:

| API type | Pi API ID |
| --- | --- |
| OpenAI Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |
| Google Gemini | `google-generative-ai` |

Works with any endpoint speaking one of those protocols — OpenAI, Anthropic, Gemini, OpenRouter, LiteLLM, Ollama, vLLM, LM Studio, corporate gateways, and self-hosted OpenAI-compatible servers.

## Install

```bash
pi install /path/to/pi-custom-provider-manager    # local checkout
pi install git:github.com/<you>/pi-custom-provider-manager
```

To try it without installing:

```bash
pi -e /path/to/pi-custom-provider-manager
```

## Quick start

```
/custom-provider add
```

The wizard asks for a base URL, then walks through API type, credential source, discovery endpoint and parser, and model defaults, registering the provider when it saves.

By hand, create `~/.pi/agent/custom-providers.json`:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "local",
      "name": "Local Ollama",
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "auth": {},
      "discovery": { "endpoint": "/models", "parser": "openai" },
      "modelDefaults": {
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 8192
      }
    }
  ]
}
```

Discovered models appear after a refresh.

## Commands

| Command | Description |
| --- | --- |
| `/custom-provider` | List configured providers with API type, parser, and manual model count |
| `/custom-provider add` | Guided setup; saves and registers immediately |
| `/custom-provider edit [id]` | Change a provider and re-register it |
| `/custom-provider delete [id]` | Remove a provider and unregister it from Pi |
| `/custom-provider refresh [id]` | Re-fetch one provider's model list through Pi |
| `/custom-provider test [id]` | Probe discovery and explain what came back |

There is also a `custom_provider_status` tool, so the agent can report what is configured.

## How it works

The extension is a configuration and discovery layer. It owns four things — configure providers, discover models, resolve model metadata, register with Pi — and Pi runs everything after registration: streaming, tool calling, usage and cost, retry, and context management. It implements no runtime of its own.

**Startup is local only.** The factory reads the configuration, builds provider objects, and registers them; it contacts no provider. Dynamic catalogs arrive through `fetchModels`, which Pi restores from its own persisted model store. A slow or unreachable provider therefore cannot delay startup, and the extension keeps no catalog of its own.

**Model resolution** runs discovered metadata through provider `modelDefaults`, then `modelOverrides` (wildcard first, then exact id), then any `manualModels` entry for the same id. Pi's own model catalog is consulted as a reference, so an endpoint serving `claude-opus-4-7` inherits the context window, pricing, thinking levels, and `compat` flags Pi uses natively.

## Discovery

Discovery is configured per provider, because model-list endpoints are not standardized:

```json
{ "discovery": { "endpoint": "/v1/models", "parser": "openai", "timeoutMs": 15000 } }
```

`endpoint` may be a path (resolved against `baseUrl`) or an absolute URL. Three parsers cover four request APIs:

| Parser | Expected shape |
| --- | --- |
| `openai` | `{ "data": [ { "id": "…" } ] }` — a bare array also works |
| `anthropic` | `{ "data": [ { "id": "…", "display_name": "…" } ] }` |
| `gemini` | `{ "models": [ { "name": "models/…" } ] }` — the `models/` prefix is stripped |

The model-list request is authenticated the way the selected API expects (`Authorization: Bearer`, `x-api-key` + `anthropic-version`, or `x-goog-api-key`), using the credential Pi resolved for the provider, with the configured environment variable as a fallback. Provider `headers` are merged on top.

When discovery fails, the failure is reported and the previous catalog is kept — Pi validates a new catalog before publishing it. `/custom-provider test` explains which stage failed.

## Configuration

```ts
interface CustomProviderConfig {
  id: string;                  // Pi provider id
  name: string;
  api: "openai-completions" | "openai-responses"
     | "anthropic-messages" | "google-generative-ai";
  baseUrl: string;
  auth: { env?: string };      // environment-variable fallback
  headers?: Record<string, string>;
  discovery?: { endpoint: string; parser: "openai" | "anthropic" | "gemini"; timeoutMs?: number };
  modelDefaults: { reasoning: boolean; input: ("text" | "image")[]; contextWindow: number; maxTokens: number; cost?: ModelCost };
  manualModels?: ManualModel[];
  modelOverrides?: Record<string, ModelOverride>;
}
```

### Credentials

Credentials come from Pi's store, with an optional environment fallback:

```json
{ "auth": { "env": "COMPANY_LLM_API_KEY" } }
```

`/login <provider-id>` works for a custom provider as it does for a built-in one, and the stored credential takes precedence over the environment. There is no separate secret store; for a non-standard auth header, use `headers`.

### Manual models

For a provider with no usable model-list endpoint, or models it does not return. Both can coexist with discovery, and a manual definition wins for a shared id:

```json
{
  "manualModels": [
    { "id": "company-llm-v7", "name": "Internal Coding Model", "contextWindow": 200000, "maxTokens": 64000, "reasoning": true }
  ]
}
```

### Per-model overrides

Corrections for what a model-list endpoint cannot know. `"*"` applies to every model, then the exact id:

```json
{
  "modelOverrides": {
    "*": { "maxTokens": 8192 },
    "qwen3-coder": { "contextWindow": 262144, "reasoning": true },
    "legacy-model": { "name": "Legacy (deprecated)" }
  }
}
```

### Thinking

Thinking uses Pi's native model fields directly. Omit `thinkingLevelMap` for Pi's default behavior; set it to control which levels a model offers (`null` marks a level unsupported, and `xhigh`/`max` are only offered when named):

```json
{
  "modelOverrides": {
    "reasoning-model": {
      "reasoning": true,
      "thinkingLevelMap": { "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": "max" }
    }
  }
}
```

Provider-specific quirks use Pi's `compat` field, passed through verbatim:

```json
{ "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens", "thinkingFormat": "qwen" } }
```

## Validation

Configuration is validated before registration, and an invalid entry never replaces a running provider. Problems are reported together:

- `id` and `name` non-empty; `baseUrl` a valid URL
- `api` one of the four supported IDs
- `discovery.endpoint` and `discovery.parser` present together
- `contextWindow` and `maxTokens` greater than zero
- manual model ids unique; thinking-level keys are valid Pi levels

A provider removed from the file is unregistered from Pi, so it disappears from the model selector without a restart.

## Development

```bash
npm run check      # type check
npm test           # unit tests
```

Tests cover configuration parsing and validation, the three parsers, model resolution and merge precedence, thinking and `compat` passthrough, provider construction for all four APIs, discovery request shaping, the credential model, and registration/removal behavior.

```
index.ts                     extension factory, command, tool
src/core/types.ts            configuration schema
src/core/store.ts            read/validate/write custom-providers.json
src/core/parsers/            the three model-list parsers
src/core/discovery.ts        model-list fetch, URL and auth shaping
src/core/resolve.ts          defaults → overrides → manual resolution
src/core/heuristics.ts       Pi catalog lookups
src/core/auth.ts             Pi's provider auth model
src/core/provider.ts         createProvider() compilation
src/core/register.ts         register/unregister against Pi
src/flows/                   add, edit, delete, refresh, test
src/ui/                      prompt, table, report, labels
```

## License

MIT
