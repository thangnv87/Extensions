# Podhub GPTs Bridge

Unified Chrome extension foundation for Podhub modules.

## Current modules

- `clone`: sends a job mockup image into a Custom GPT and stores returned images as Raw Clone.
- `redesign`: sends a job mockup image plus title into a Custom GPT and stores returned images as Raw Redesign.
- `mockup`: sends Raw Clone/Redesign assets into a Custom GPT and stores returned images/JSON as Mockup and Design Library records.

## Server-owned config

The extension expects GPT links and optional module endpoint overrides from `https://tools.podhub.space`.

Recommended module config shape:

```json
{
  "modules": [
    {
      "id": "clone",
      "enabled": true,
      "gpt_url": "https://chatgpt.com/g/...",
      "next_job_path": "/api/extension/clone-jobs/next",
      "result_path_template": "/api/extension/clone-jobs/:job_id/raw-clone"
    },
    {
      "id": "redesign",
      "enabled": true,
      "gpt_url": "https://chatgpt.com/g/...",
      "next_job_path": "/api/extension/redesign-jobs/next",
      "result_path_template": "/api/extension/redesign-jobs/:job_id/raw-redesign"
    },
    {
      "id": "mockup",
      "enabled": true,
      "gpt_url": "https://chatgpt.com/g/...",
      "next_job_path": "/api/extension/mockup-jobs/next",
      "result_path_template": "/api/extension/mockup-jobs/:job_id/results"
    }
  ]
}
```

## Result routing contract

Keep this contract stable so new modules can be added without changing the shared runner.

| Module | Input sent to GPTs | Prompt style | Saved result |
| --- | --- | --- | --- |
| `clone` | Job mockup/design image | Short prompt, one raw clone image | `POST /api/extension/clone-jobs/:job_id/raw-clone` |
| `redesign` | Job mockup/design image + title | Short prompt like Mockup GPTs, `N` raw redesign images | `POST /api/extension/redesign-jobs/:job_id/raw-redesign` |
| `mockup` | Raw clone/redesign image | Mockup GPTs flow: planning prompt, mockup images, listing prompt | `POST /api/extension/mockup-jobs/:job_id/mockups` and `POST /api/extension/mockup-jobs/:job_id/listings` |

Default result keys used by the extension:

```json
{
  "clone": {
    "result_kind": "raw_clone",
    "result_path_template": "/api/extension/clone-jobs/:job_id/raw-clone"
  },
  "redesign": {
    "result_kind": "raw_redesign",
    "result_path_template": "/api/extension/redesign-jobs/:job_id/raw-redesign"
  },
  "mockup": {
    "result_kind": "mockup",
    "result_path_template": "/api/extension/mockup-jobs/:job_id/mockups",
    "listing_path_template": "/api/extension/mockup-jobs/:job_id/listings"
  }
}
```

Server can override any `*_path_template` in `/api/extension/config`. The extension replaces `:job_id`, then uploads image blobs with `filename`, `kind`, and `runner_id` query/meta data.

## Integration path

This version keeps module tabs separated while sharing license/config/runtime storage.

Current runner behavior:

1. Opens the module Custom GPT from the server-provided `gpt_url`.
2. Fetches the job asset from `asset_id` or image URL.
3. Attaches the image to ChatGPT.
4. Sends a short module prompt.
5. Captures returned GPT images/text.
6. Uploads the result to the module result route above.
7. Updates job status through the module status route.

Keep GPT URLs, style presets, product catalog, listing options, and endpoint overrides on the server so changing Custom GPT links or module setup does not require extension updates.

## Commercial release build

Install the pinned build dependency once:

```bash
npm ci
```

Create the protected release package:

```bash
npm run build:release
```

The release pipeline performs these checks before producing an artifact:

- validates JavaScript syntax and every file referenced by `manifest.json`;
- blocks known private-key, GitHub-token, Podhub Team API key, and server-password patterns;
- obfuscates all executable JavaScript with Chrome Manifest V3-compatible settings;
- rejects `eval` and `new Function` from the generated code;
- packages only the files required by the extension;
- writes a SHA-256 checksum beside the versioned ZIP.

Only distribute `Podhub-GPTs-Bridge-v<version>.zip`. Keep the source repository private. Obfuscation raises the cost of reverse engineering, but browser extension code cannot be made completely unreadable; sensitive keys and business-critical configuration must remain on the server.
