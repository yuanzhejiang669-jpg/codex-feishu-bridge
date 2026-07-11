---
name: imagegen-router
description: Generate or edit raster images through the user's non-built-in OpenAI-compatible GPT Image endpoints with provider routing, fallback, and round-robin. Use when the user mentions imagegen-router, third-party image APIs, Sub2API, lthome, OpenAI-compatible image endpoints, provider fallback, round-robin, or asks to use GPT Image 2 outside Codex's official built-in imagegen tool.
---

# Imagegen Router

Use this skill for image generation or editing through the user's personal OpenAI-compatible image endpoints. Keep ordinary image requests on the official `.system/imagegen` skill unless the user asks for Sub2API, lthome, a third-party GPT Image 2 API path, provider fallback, or round-robin behavior.

Bundled CLI:

```powershell
python "$env:USERPROFILE\.codex\skills\imagegen-router\scripts\imagegen_router.py" --help
```

## Providers

Built-in provider presets:

- `sub2api`: `https://sub2api.douxuenong.xyz/v1`, model `gpt-image-2`, key env priority `SUB2API_API_KEY`, `OPENAI_API_KEY`.
- `lthome`: `https://sub.lthome.tk/v1`, model `gpt-image-2`, key env priority `LTHOME_API_KEY`, `OPENAI_API_KEY`.

Optional custom providers can be added with `IMAGEGEN_ROUTER_CONFIG`, pointing to a JSON file:

```json
{
  "providers": {
    "my-provider": {
      "base_url": "https://example.com/v1",
      "model": "gpt-image-2",
      "api_key_envs": ["MY_IMAGE_API_KEY", "OPENAI_API_KEY"]
    }
  }
}
```

Never print API keys. Report only which environment variable was used.

## Workflow

1. Use the official `.system/imagegen` skill for ordinary image generation/editing.
2. Use this router when the user explicitly asks for Sub2API, lthome, third-party API, OpenAI-compatible, GPT Image 2 API, fallback, or round-robin behavior.
3. Run `providers` or `check` before spending image credits in a new environment.
4. Prefer `--provider auto` for availability-based fallback. Use `--provider round-robin` when the user asks to distribute calls.
5. Use `generate` for text-to-image and `edit` when one or more source images should guide the result.
6. Save outputs under the task folder, not inside the skill folder.
7. Report saved image paths, manifest path, provider used, and any API warning or revised prompt returned by the endpoint.

## Commands

List configured providers:

```powershell
python "$env:USERPROFILE\.codex\skills\imagegen-router\scripts\imagegen_router.py" providers
```

Check one provider:

```powershell
python "$env:USERPROFILE\.codex\skills\imagegen-router\scripts\imagegen_router.py" check --provider auto
```

Generate through the first available provider:

```powershell
python "$env:USERPROFILE\.codex\skills\imagegen-router\scripts\imagegen_router.py" generate `
  "A clean product mockup on a white studio background, no text." `
  --provider auto `
  --output-dir .\generated-images `
  --response-format b64_json
```

Generate with round-robin provider selection:

```powershell
python "$env:USERPROFILE\.codex\skills\imagegen-router\scripts\imagegen_router.py" generate `
  "A simple clean product icon on a white background, no text." `
  --provider round-robin `
  --output-dir .\generated-images `
  --response-format b64_json
```

Edit one or more images:

```powershell
python "$env:USERPROFILE\.codex\skills\imagegen-router\scripts\imagegen_router.py" edit `
  "Replace the background with a soft gray studio backdrop; preserve the subject." `
  --image .\input.png `
  --provider auto `
  --output-dir .\generated-images `
  --response-format b64_json
```

## Options

- `--provider`: Provider name, `auto`, or `round-robin`. Defaults to `auto`.
- `--base-url`: Override the selected provider base URL for this call.
- `--api-key-env`: Override key env priority. Repeat to provide multiple env names.
- `--model`: Override model. Defaults to the selected provider model.
- `--size`: Defaults to `1024x1024`.
- `--quality`: Optional; omit unless the user asks or the endpoint requires it.
- `--output-format`: `png`, `jpeg`, or `webp`.
- `--response-format`: Prefer `b64_json` when the provider supports it because URL download behavior can vary.
- `--n`: Number of images, default `1`.
- `--state-file`: Override the round-robin state file. Default is `$env:USERPROFILE\.codex\state\imagegen-router.json` on Windows.

## Notes

- The CLI uses only the Python standard library.
- It supports both `b64_json` and URL image responses.
- It writes a JSON manifest beside generated images.
- It does not implement Codex's official built-in `image_gen` path. That remains in `.system/imagegen`.
