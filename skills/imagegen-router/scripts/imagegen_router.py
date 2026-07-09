#!/usr/bin/env python3
"""Generate or edit images through routed OpenAI-compatible image endpoints."""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import json
import mimetypes
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


DEFAULT_MODEL = "gpt-image-2"
DEFAULT_STATE_FILE = Path.home() / ".codex" / "state" / "imagegen-router.json"


BUILTIN_PROVIDER_CONFIGS = {
    "sub2api": {
        "base_url": "https://sub2api.douxuenong.xyz/v1",
        "model": DEFAULT_MODEL,
        "api_key_envs": ["SUB2API_API_KEY", "OPENAI_API_KEY"],
    },
    "lthome": {
        "base_url": "https://sub.lthome.tk/v1",
        "model": DEFAULT_MODEL,
        "api_key_envs": ["LTHOME_API_KEY", "OPENAI_API_KEY"],
    },
}


class ApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    model: str
    api_key_envs: tuple[str, ...]


@dataclass(frozen=True)
class SelectedProvider:
    provider: Provider
    api_key: str
    api_key_env: str


def redact(text: str) -> str:
    parts = text.split("sk-")
    if len(parts) == 1:
        return text
    return parts[0] + "sk-[redacted]" + "sk-[redacted]".join(part[40:] for part in parts[1:])


def normalize_base_url(value: str) -> str:
    return value.rstrip("/")


def provider_from_config(name: str, config: dict) -> Provider:
    base_url = config.get("base_url")
    if not base_url:
        raise ApiError(f"Provider {name!r} is missing base_url.")
    api_key_envs = config.get("api_key_envs") or config.get("api_key_env")
    if isinstance(api_key_envs, str):
        api_key_envs = [api_key_envs]
    if not api_key_envs:
        raise ApiError(f"Provider {name!r} is missing api_key_envs.")
    return Provider(
        name=name,
        base_url=normalize_base_url(str(base_url)),
        model=str(config.get("model") or DEFAULT_MODEL),
        api_key_envs=tuple(str(item) for item in api_key_envs),
    )


def load_custom_provider_configs(path_value: str | None) -> dict[str, dict]:
    if not path_value:
        return {}
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        raise ApiError(f"IMAGEGEN_ROUTER_CONFIG does not exist: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ApiError(f"Invalid JSON in IMAGEGEN_ROUTER_CONFIG: {path}") from exc
    providers = raw.get("providers")
    if not isinstance(providers, dict):
        raise ApiError("IMAGEGEN_ROUTER_CONFIG must contain an object field named providers.")
    return providers


def load_providers() -> dict[str, Provider]:
    configs = dict(BUILTIN_PROVIDER_CONFIGS)
    configs.update(load_custom_provider_configs(os.environ.get("IMAGEGEN_ROUTER_CONFIG")))
    return {name: provider_from_config(name, config) for name, config in configs.items()}


def key_from_envs(envs: tuple[str, ...]) -> tuple[str, str] | None:
    for env_name in envs:
        value = os.environ.get(env_name)
        if value:
            return value, env_name
    return None


def require_provider(name: str, providers: dict[str, Provider]) -> SelectedProvider:
    provider = providers.get(name)
    if provider is None:
        known = ", ".join(sorted(providers))
        raise ApiError(f"Unknown provider {name!r}. Known providers: {known}.")
    key = key_from_envs(provider.api_key_envs)
    if key is None:
        joined = ", ".join(provider.api_key_envs)
        raise ApiError(f"Missing API key for provider {name!r}. Set one of: {joined}.")
    api_key, api_key_env = key
    return SelectedProvider(provider=provider, api_key=api_key, api_key_env=api_key_env)


def readable_provider(provider: Provider) -> dict:
    key_available = [env_name for env_name in provider.api_key_envs if os.environ.get(env_name)]
    return {
        "name": provider.name,
        "base_url": provider.base_url,
        "model": provider.model,
        "api_key_envs": list(provider.api_key_envs),
        "available_key_envs": key_available,
    }


def ordered_available_providers(providers: dict[str, Provider]) -> list[str]:
    return [name for name in sorted(providers) if key_from_envs(providers[name].api_key_envs) is not None]


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def choose_round_robin(providers: dict[str, Provider], state_file: Path) -> str:
    available = ordered_available_providers(providers)
    if not available:
        raise ApiError("No configured provider has an available API key.")
    state = load_state(state_file)
    last = state.get("last_provider")
    if last in available:
        index = (available.index(last) + 1) % len(available)
    else:
        index = 0
    chosen = available[index]
    state["last_provider"] = chosen
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    save_state(state_file, state)
    return chosen


def selected_candidates(args: argparse.Namespace, providers: dict[str, Provider]) -> list[SelectedProvider]:
    provider_name = args.provider
    if provider_name == "auto":
        names = ordered_available_providers(providers)
        if not names:
            raise ApiError("No configured provider has an available API key.")
        return [override_selected(require_provider(name, providers), args) for name in names]
    if provider_name == "round-robin":
        state_file = Path(args.state_file).expanduser().resolve()
        chosen = choose_round_robin(providers, state_file)
        names = [chosen] + [name for name in ordered_available_providers(providers) if name != chosen]
        return [override_selected(require_provider(name, providers), args) for name in names]
    return [override_selected(require_provider(provider_name, providers), args)]


def override_selected(selected: SelectedProvider, args: argparse.Namespace) -> SelectedProvider:
    provider = selected.provider
    api_key = selected.api_key
    api_key_env = selected.api_key_env
    api_key_envs = tuple(args.api_key_env) if args.api_key_env else provider.api_key_envs
    if args.api_key_env:
        key = key_from_envs(api_key_envs)
        if key is None:
            joined = ", ".join(api_key_envs)
            raise ApiError(f"Missing API key. Set one of: {joined}.")
        api_key, api_key_env = key
    overridden = Provider(
        name=provider.name,
        base_url=normalize_base_url(args.base_url or provider.base_url),
        model=args.model or provider.model,
        api_key_envs=api_key_envs,
    )
    return SelectedProvider(provider=overridden, api_key=api_key, api_key_env=api_key_env)


def format_http_error(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception:
        raw = ""
    redacted = redact(raw)
    if len(redacted) > 800:
        redacted = redacted[:800] + "..."
    return f"HTTP {exc.code}: {redacted or exc.reason}"


def request_json(method: str, url: str, key: str, payload: dict | None = None) -> dict:
    data = None
    headers = {"Authorization": f"Bearer {key}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    body = open_url_with_retry(req, timeout=180).decode("utf-8")
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiError(f"Endpoint returned non-JSON response: {body[:300]}") from exc


def encode_multipart(fields: dict[str, str], files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = "----imagegen-router-" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")
    for name, path in files:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.append(f"--{boundary}\r\n".encode())
        disposition = f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
        chunks.append(disposition.encode())
        chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
        chunks.append(path.read_bytes())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def request_multipart(url: str, key: str, fields: dict[str, str], files: list[tuple[str, Path]]) -> dict:
    body, boundary = encode_multipart(fields, files)
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    raw = open_url_with_retry(req, timeout=300).decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"Endpoint returned non-JSON response: {raw[:300]}") from exc


def open_url_with_retry(req: urllib.request.Request, timeout: int) -> bytes:
    last_error: ApiError | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise ApiError(format_http_error(exc)) from exc
        except urllib.error.URLError as exc:
            last_error = ApiError(f"Request failed: {exc.reason}")
            if attempt == 0:
                time.sleep(1)
    if last_error is not None:
        raise last_error
    raise ApiError("Request failed.")


def build_generation_payload(args: argparse.Namespace, selected: SelectedProvider) -> dict:
    payload = {
        "model": selected.provider.model,
        "prompt": args.prompt,
        "n": args.n,
        "size": args.size,
    }
    for field in ["quality", "background", "moderation", "output_format", "response_format", "user"]:
        value = getattr(args, field, None)
        if value:
            payload[field] = value
    if args.output_compression is not None:
        payload["output_compression"] = args.output_compression
    return payload


def build_edit_fields(args: argparse.Namespace, selected: SelectedProvider) -> dict[str, str]:
    fields = {
        "model": selected.provider.model,
        "prompt": args.prompt,
        "n": str(args.n),
        "size": args.size,
    }
    for field in ["quality", "background", "output_format", "response_format", "user"]:
        value = getattr(args, field, None)
        if value:
            fields[field] = str(value)
    return fields


def ensure_output_dir(path: str | Path) -> Path:
    out_dir = Path(path).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def infer_extension(item: dict, default_format: str | None) -> str:
    if default_format:
        return ".jpg" if default_format == "jpeg" else f".{default_format}"
    url = item.get("url")
    if url:
        suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
            return suffix
    return ".png"


def download_url(url: str, path: Path, key: str) -> None:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            path.write_bytes(resp.read())
    except urllib.error.HTTPError:
        with urllib.request.urlopen(url, timeout=180) as resp:
            path.write_bytes(resp.read())


def save_images(
    response: dict,
    output_dir: Path,
    prefix: str,
    output_format: str | None,
    selected: SelectedProvider,
) -> dict:
    items = response.get("data") or response.get("images") or []
    if not isinstance(items, list) or not items:
        raise ApiError(f"No image data found in response: {json.dumps(response)[:500]}")

    saved = []
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        ext = infer_extension(item, output_format)
        path = output_dir / f"{prefix}-{selected.provider.name}-{timestamp}-{index}{ext}"
        if item.get("b64_json"):
            path.write_bytes(base64.b64decode(item["b64_json"]))
        elif item.get("image_base64"):
            path.write_bytes(base64.b64decode(item["image_base64"]))
        elif item.get("url"):
            download_url(item["url"], path, selected.api_key)
        else:
            raise ApiError(f"Image item did not include b64_json or url: {json.dumps(item)[:300]}")
        saved.append({"path": str(path), "revised_prompt": item.get("revised_prompt")})

    manifest = {
        "created_at": timestamp,
        "provider": selected.provider.name,
        "base_url": selected.provider.base_url,
        "api_key_env_used": selected.api_key_env,
        "model": selected.provider.model,
        "id": response.get("id"),
        "saved": saved,
        "usage": response.get("usage"),
    }
    manifest_path = output_dir / f"{prefix}-{selected.provider.name}-{timestamp}-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def try_candidates(candidates: list[SelectedProvider], action) -> tuple[SelectedProvider, dict, list[dict]]:
    errors = []
    for selected in candidates:
        try:
            return selected, action(selected), errors
        except ApiError as exc:
            errors.append({"provider": selected.provider.name, "error": str(exc)})
            if len(candidates) == 1:
                raise
    raise ApiError("All candidate providers failed: " + json.dumps(errors, ensure_ascii=False))


def command_providers(args: argparse.Namespace) -> int:
    providers = load_providers()
    result = {
        "providers": [readable_provider(provider) for provider in providers.values()],
        "state_file": str(Path(args.state_file).expanduser().resolve()),
    }
    print(json.dumps(result, indent=2))
    return 0


def check_selected(selected: SelectedProvider) -> dict:
    response = request_json("GET", f"{selected.provider.base_url}/models", selected.api_key)
    ids = [item.get("id") for item in response.get("data", []) if isinstance(item, dict)]
    return {
        "provider": selected.provider.name,
        "base_url": selected.provider.base_url,
        "api_key_env_used": selected.api_key_env,
        "model": selected.provider.model,
        "model_available": selected.provider.model in ids,
        "model_count": len(ids),
        "image_models": [model for model in ids if model and "image" in model.lower()],
    }


def command_check(args: argparse.Namespace) -> int:
    providers = load_providers()
    candidates = selected_candidates(args, providers)
    if args.provider == "auto":
        results = []
        exit_code = 2
        for selected in candidates:
            try:
                result = check_selected(selected)
                results.append(result)
                if result["model_available"] and exit_code != 0:
                    exit_code = 0
            except ApiError as exc:
                results.append({"provider": selected.provider.name, "error": str(exc)})
        print(json.dumps({"results": results}, indent=2))
        return exit_code
    selected, result, errors = try_candidates(candidates, check_selected)
    if errors:
        result["fallback_errors"] = errors
    print(json.dumps(result, indent=2))
    return 0 if result["model_available"] else 2


def command_generate(args: argparse.Namespace) -> int:
    providers = load_providers()
    candidates = selected_candidates(args, providers)

    def action(selected: SelectedProvider) -> dict:
        payload = build_generation_payload(args, selected)
        return request_json("POST", f"{selected.provider.base_url}/images/generations", selected.api_key, payload)

    selected, response, errors = try_candidates(candidates, action)
    manifest = save_images(response, ensure_output_dir(args.output_dir), args.prefix, args.output_format, selected)
    if errors:
        manifest["fallback_errors"] = errors
    print(json.dumps(manifest, indent=2))
    return 0


def command_edit(args: argparse.Namespace) -> int:
    providers = load_providers()
    candidates = selected_candidates(args, providers)
    files = []
    for image_path in args.image:
        path = Path(image_path).expanduser().resolve()
        if not path.exists():
            raise ApiError(f"Image not found: {path}")
        files.append(("image", path))
    if args.mask:
        mask_path = Path(args.mask).expanduser().resolve()
        if not mask_path.exists():
            raise ApiError(f"Mask not found: {mask_path}")
        files.append(("mask", mask_path))

    def action(selected: SelectedProvider) -> dict:
        fields = build_edit_fields(args, selected)
        return request_multipart(f"{selected.provider.base_url}/images/edits", selected.api_key, fields, files)

    selected, response, errors = try_candidates(candidates, action)
    manifest = save_images(response, ensure_output_dir(args.output_dir), args.prefix, args.output_format, selected)
    if errors:
        manifest["fallback_errors"] = errors
    print(json.dumps(manifest, indent=2))
    return 0


def add_provider_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--provider", default="auto", help="Provider name, auto, or round-robin.")
    parser.add_argument("--base-url", help="Override selected provider base URL.")
    parser.add_argument("--api-key-env", action="append", help="Override API key env priority. Repeat for fallback envs.")
    parser.add_argument("--model", help="Override selected provider model.")
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_FILE), help="Round-robin state file.")


def add_image_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--quality")
    parser.add_argument("--background")
    parser.add_argument("--output-format", choices=["png", "jpeg", "webp"])
    parser.add_argument("--response-format", choices=["url", "b64_json"])
    parser.add_argument("--user")
    parser.add_argument("--output-dir", default="imagegen-router-output")
    parser.add_argument("--prefix", default="imagegen")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    providers = subparsers.add_parser("providers", help="List configured providers without printing key values.")
    providers.add_argument("--state-file", default=str(DEFAULT_STATE_FILE), help="Round-robin state file.")
    providers.set_defaults(func=command_providers)

    check = subparsers.add_parser("check", help="Verify endpoint, key, and model availability without generating an image.")
    add_provider_options(check)
    check.set_defaults(func=command_check)

    generate = subparsers.add_parser("generate", help="Generate image(s) from a text prompt.")
    generate.add_argument("prompt")
    add_provider_options(generate)
    add_image_options(generate)
    generate.add_argument("--moderation")
    generate.add_argument("--output-compression", type=int)
    generate.set_defaults(func=command_generate)

    edit = subparsers.add_parser("edit", help="Edit image(s) from a prompt and input image files.")
    edit.add_argument("prompt")
    edit.add_argument("--image", action="append", required=True, help="Input image path. Repeat for multiple images.")
    edit.add_argument("--mask", help="Optional mask image path.")
    add_provider_options(edit)
    add_image_options(edit)
    edit.set_defaults(func=command_edit)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
