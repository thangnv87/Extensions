# PODHUB Pipeline Server Contract

Extension v3.4.10 posts GPT output to Railway after JSON/design generation. The server is the source of truth: store JSON in the database and import every generated image into Raw design storage/CDN before background removal. Server jobs do not auto-download JSON/TXT locally; manual History buttons can still export files on demand. The extension checkpoints the active job by chat URL and resumes unfinished image generation after reload.

## Endpoint

```http
POST /api/ext-queue/jobs/:job_id/gpt-result
```

Generated images are also pushed to the Raw Designs library endpoint used by the earlier extension:

```http
POST /api/raw-designs/jobs/manual
POST /api/raw-designs/jobs/:raw_design_job_id/outputs
```

## Required behavior

1. Validate `schema_version === "podhub_gpt_batch_v1"`.
2. Upsert `product_id`, `job_id`, `batch_id`.
3. Persist `batch.meta` and `batch.styles[]` in database for later listing creation.
4. For every style with `image_url`, create a Raw design record.
5. Import every generated `image_url` server-side and upload it to Shopify CDN. For generated ChatGPT images, the extension may send `image_url` as a `data:image/...` URL because temporary ChatGPT URLs often require the browser session and cannot be fetched by Railway.
   - Use `style.raw_design_filename` when saving the file.
   - The filename ends with the background color slug before `.png`.
6. Insert pipeline event `gpt.batch.validated`.
7. Enqueue next steps:
   - `raw_design.import.requested`
   - `bg.removal.requested`
   - `mockup.requested`
   - `listing.requested`
8. Return JSON:

```json
{
  "ok": true,
  "product_id": "prod_xxx",
  "job_id": "job_xxx",
  "batch_id": "batch_xxx",
  "next_status": "raw_design_queued"
}
```

## Database intent

Store the GPT batch in any database structure that lets listing creation query by `product_id`, `job_id`, `batch_id`, or `style_id`.

Minimum useful tables/collections:

```txt
products
generation_jobs
gpt_batches
gpt_styles
raw_designs
assets
mockups
listings
pipeline_events
```

Minimum style fields needed later by listing:

```json
{
  "product_id": "prod_xxx",
  "job_id": "job_xxx",
  "batch_id": "batch_xxx",
  "style_id": 1,
  "design_id": "des_xxx",
  "title": "...",
  "bullets": ["..."],
  "description": "...",
  "image_prompt": "...",
  "background_color": "black",
  "background_color_slug": "black",
  "image_url": "data:image/png;base64,... or temporary ChatGPT image URL",
  "chatgpt_image_url": "temporary ChatGPT image URL when image_url is a data URL",
  "raw_design_filename": "etsy_1234567890__product__style_1_retro__des_batch_xxx_1__bg_black.png",
  "raw_design_asset_id": "asset_xxx",
  "raw_design_url": "https://cdn.shopify.com/...",
  "raw_design_storage": "shopify_cdn"
}
```

## Raw design filename convention

```txt
{product_id}__{product_slug}__style_{style_id}_{style_slug}__{design_id}__bg_{background_color_slug}.png
```

Examples:

```txt
etsy_1234567890__vintage_dog_mom_shirt__style_1_retro__des_batch_abc_1__bg_black.png
amz_b0abc12345__vintage_dog_mom_shirt__style_2_minimal__des_batch_abc_2__bg_transparent.png
```

`product_id` should be the original marketplace ID whenever available:

```txt
Etsy listing ID -> etsy_1234567890
Amazon ASIN -> amz_b0abc12345
```

This keeps all scaled designs, mockups, and listings searchable by the original source product ID.

## Main statuses

```txt
gpt_running
gpt_json_validated
design_generating
design_generated
raw_design_queued
raw_design_importing
raw_design_done
gpt_result_post_failed
done
failed
```

## Event chain

```txt
gpt.batch.validated
  -> raw_design.import.requested
  -> raw_design.imported
  -> bg.removal.requested
  -> bg.removed
  -> mockup.requested
  -> mockup.generated
  -> listing.requested
  -> listing.ready
```

If this endpoint fails, the extension exports a local JSON backup but marks the job failed so it can be retried.
