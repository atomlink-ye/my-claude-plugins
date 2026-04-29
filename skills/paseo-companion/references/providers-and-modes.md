# Providers, models, and modes

Paseo dispatches agents through pluggable providers. Discover what is available locally before assuming any provider/model exists.

## `paseo provider ls` — list providers

```bash
paseo provider ls
```

Shows every provider, its label, availability status, the default mode, and the list of supported modes. A provider may be present but unavailable (missing CLI, missing auth) — the `STATUS` column tells you.

## `paseo provider models <provider>` — list models for a provider

```bash
paseo provider models claude
paseo provider models codex
paseo provider models opencode
```

Returns every model ID the provider exposes locally. Use this rather than memorizing model names — the list changes as new models ship.

## Selecting provider and model on `paseo run`

Three equivalent ways to specify the model:

```bash
paseo run --provider claude --model <model-id> "..."
paseo run --provider claude/<model-id> "..."     # combined form
paseo run --provider <provider-only> "..."       # use the provider's default model
```

The combined form (`provider/model`) is the most common.

## `--mode <mode>` — provider-specific operational mode

Modes are provider-specific (e.g. `plan`, `default`, `bypass` for one provider; `build`, `plan`, `orchestrator` for another). Run `paseo provider ls` to see what each provider supports, or `paseo agent mode <id> --list` for an existing agent.

```bash
paseo run --provider <provider> --mode <mode> "..."
paseo agent mode <id> <mode>          # change mode on a running agent
```

## `--thinking <id>` — provider thinking option

Some providers expose distinct "thinking" tiers (e.g. effort levels). The IDs are provider-specific.

```bash
paseo run --provider <provider> --thinking <id> "..."
paseo ls --thinking <id>               # filter list by thinking tier
```

## Choice rule

Paseo does not enforce any provider/model/mode/thinking default — those are caller decisions. This skill lists the flags but does not pick values.
