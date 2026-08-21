# Podhub GPTs Bridge

## Stable Queue Sync — v0.1.9.5 Tools Clear

This variant uses `https://tools.podhub.space` for activation, configuration, job queues, asset downloads, and result uploads. It contains readable source code and no obfuscated runtime files.

- Amazon/Etsy tạo job xong sẽ đồng bộ trực tiếp vào danh sách đang mở.
- Có lớp hiển thị dự phòng kèm nút Chạy/Xóa nếu giao diện lõi không cập nhật state.
- Luồng tạo, đọc, chạy và cập nhật job cùng sử dụng stable extension queue; không trộn với Bridge v1 queue.

- Marketplace dùng endpoint Unified ổn định trên `https://tools.podhub.space` để server xử lý đồng thời Spy, license entitlement và tạo job.
- Khi Amazon/Etsy lưu listing thành công, extension phát tín hiệu cập nhật và panel ChatGPT tự tải lại job ngay; polling 8 giây là lớp dự phòng.
- Trạng thái tài khoản hiển thị theo gói và email, đồng thời khóa các module ngoài entitlement trên giao diện.

## Bridge v1

- Extension chỉ gọi gateway `https://tools.podhub.space/api/bridge/v1` bằng access token của license.
- Extension không nhận hoặc lưu Team token và không tự chọn server team.
- Capability probe được cache 5 phút. Chỉ fallback route cũ khi gateway trả rõ `404` hoặc `CAPABILITY_NOT_SUPPORTED`/`BRIDGE_V1_DISABLED`.
- Lỗi mạng hoặc `TEAM_SERVER_UNAVAILABLE` không fallback, nhằm tránh ghi trùng hoặc gửi dữ liệu sang server khác.
- Các request ghi listing, claim, status, result và tạo mockup job đều có `Idempotency-Key` ổn định.
- Runtime dùng trực tiếp source rõ ràng trong `background-source.js`; bản v0.1.9.5 này không chứa mã obfuscate.

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

## Clear source build

Install the pinned build dependency once:

```bash
npm ci
```

Run the source checks and tests:

```bash
npm run check
npm test
```

The v0.1.9.5 source tree committed here:

- validates JavaScript syntax and every file referenced by `manifest.json`;
- blocks known private-key, GitHub-token, Podhub Team API key, and server-password patterns;
- keeps executable JavaScript readable for review and maintenance;
- does not include an obfuscated artifact or generated release ZIP.

Sensitive keys and business-critical configuration must remain on the server and must never be embedded in the extension source.
