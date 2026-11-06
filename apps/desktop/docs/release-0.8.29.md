# 0.8.29 — Provider model capacity discovery

Adding a Responses Provider now detects its versioned Codex model catalog and saves `model_catalog_url` only after validating the response. Custom Provider Bot creation follows the same flow. Existing global and client-managed isolated Providers are checked in the background at startup; compatible endpoints are connected without changing the selected Provider or stopping Bots.

The Provider table and configuration-space view show capacity provenance. A successful check displays the service's declared window, effective percentage, and derived usable window. Missing metadata remains unknown or uses Codex's built-in defaults; configured local catalogs, manual window overrides, and disabled API-key discovery are identified explicitly. A transient query failure preserves an existing catalog configuration.

The **Detect capacity** action also accepts a service-supplied nonstandard catalog URL. Catalog requests include the installed Codex version and configured headers/query parameters, refuse redirects, and enforce Codex's 1 MiB limit and a bounded timeout. Keys and response bodies are excluded from diagnostics.

Window management and compaction remain native Codex behavior. No fixed context-window value or compaction threshold is written. Restart the corresponding idle Bot to make a newly configured catalog available to its next Codex process.
