# Podhub Mockup GPTs — Acceptance Tests v0.9

## Test 1: Natural planning handshake

Upload one approved design, then send:

```text
Phân tích artwork đính kèm và lập kế hoạch 2 mockup cho mug_11oz và tumbler_20oz, tối ưu bộ ảnh cho etsy và shopify, tỷ lệ 1:1. Trả về 2 prompt mockup cho mỗi sản phẩm, chưa tạo ảnh và chưa tạo listing.
```

Pass criteria:

- Response contains `## Artwork analysis` and `## Mockup strategy` as normal Markdown.
- `## Mockup prompts` is followed by exactly one fenced JSON block.
- JSON schema is `podhub_mockup_prompts_v1` and contains no job, task, design, or asset ID.
- Both products appear in supplied order with exactly two prompts numbered `1` and `2`.
- Every item contains a canonical `scene_type` and an independently executable `prompt`.
- No image is generated.

## Test 2: Exact-prompt image execution

Send only the exact string from `products[0].mockup_prompts[0].prompt`. Do not prepend or append anything.

Pass criteria:

- Exactly one new inline mug image appears.
- No prose, JSON, filename, link, sandbox path, collage, or extra image appears.
- The approved artwork and exact product are preserved.

## Test 2B: Invalid prompt-block repair

Remove one prompt from the JSON block before passing the response to the parser.

Pass criteria:

- Extension requests a corrected `## Mockup prompts` section using `podhub_mockup_prompts_v1`.
- Repair request contains product IDs and expected counts but no internal IDs.
- No image is generated from an incomplete prompt set.

## Test 3: Multi-product continuation

Send each stored prompt exactly once in product order: mug `1/2`, mug `2/2`, tumbler `1/2`, tumbler `2/2`.

Pass criteria: one correct inline image per prompt; extension associates each image with its local product/mockup slot without exposing IDs to GPT.

## Test 4: Natural listing command

After both mug images are captured, send:

```text
Tạo listing SEO đầy đủ cho mug_11oz trên etsy và shopify, sử dụng toàn bộ 2 mockup vừa hoàn thành.
```

Pass criteria:

- GPT returns one raw `podhub_product_listing_bundle_v2` object for mug only.
- Bundle contains exactly Etsy and Shopify listings with complete marketplace payloads.
- Etsy has exactly 13 valid tags and both listings use mockup numbers `[1,2]`.
- GPT need not return internal IDs; extension injects authoritative job/task/design IDs before saving.

Repeat only after tumbler mockups complete. The second bundle must contain tumbler only.

## Test 5: Duplicate image gate

Submit identical image bytes for two mockup slots.

Pass criteria:

- Backend rejects the duplicate and the product remains incomplete.
- Extension retries by resending only the original stored prompt for the missing slot.
- Listing generation remains blocked until all unique images pass validation.

## Test 6: File-path recovery

Simulate an assistant response containing `/mnt/data/mockup.png` without an inline image.

Pass criteria:

- Extension rejects the response and never stores the path.
- Retry sends only the same original stored image prompt, with no corrective wrapper or internal IDs.
- A valid inline image is captured before the workflow continues.

## Test 7: No-ID message audit

Inspect every message sent by the extension during one complete job.

Pass criteria: no message contains `PODHUB_CONTEXT`, `task_id`, `design_id`, `job_id`, `asset_id`, UUID metadata, or the original long filename.
