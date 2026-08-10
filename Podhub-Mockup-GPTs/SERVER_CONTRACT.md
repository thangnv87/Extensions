# Mockup GPTs Server Contract v2

## Module

```txt
module_id = mockup-gpts
```

`GET /api/extension/config` phải trả GPT link bằng key `mockup-gpts` và pipeline/catalog áp dụng cho license hiện tại.

## Mockup asset

```http
POST /api/extension/mockup-jobs/:job_id/mockups?product_id=tumbler_20oz&mockup_no=1&filename=Podhub-Design__tumbler_20oz__mockup_01.png
Authorization: Bearer <extension token>
Content-Type: image/png
```

```json
{
  "schema_version": "podhub_mockup_asset_v2",
  "job_id": "mjob_xxx",
  "task_id": "mtask_xxx",
  "design_id": "des_xxx",
  "product_id": "tumbler_20oz",
  "mockup_no": 1,
  "image_url": "temporary ChatGPT URL",
  "image_data_url": "data:image/png;base64,...",
  "filename": "des_xxx__tumbler_20oz__mockup_01.png",
  "content_sha256": "sha256 hex",
  "captured_at": "ISO-8601"
}
```

Idempotency key:

```txt
user_id + design_id + product_id + mockup_no
```

Backend phải từ chối cùng `asset_id` hoặc `content_sha256` được dùng cho hai mockup slot khác nhau trong cùng job. Chỉ tính usage sau khi ảnh được lưu CDN/database thành công.

Validation gate:

```http
GET /api/extension/mockup-jobs/:job_id/products/:product_id/validation
```

Một sản phẩm chỉ hoàn thành khi đủ mọi `mockup_no` từ `1..N`, đủ N `asset_id` duy nhất và đủ N content hash duy nhất.

## Listing

```http
POST /api/extension/mockup-jobs/:job_id/listings
Authorization: Bearer <extension token>
Content-Type: application/json
```

```json
{
  "schema_version": "podhub_product_listing_v2",
  "job_id": "mjob_xxx",
  "task_id": "mtask_xxx",
  "design_id": "des_xxx",
  "product_id": "tumbler_20oz",
  "marketplace": "etsy",
  "title": "...",
  "description": "...",
  "tags": [],
  "materials": [],
  "mockup_numbers": [1, 2, 3]
}
```

Idempotency key:

```txt
user_id + design_id + product_id + marketplace
```

Backend phải validate ownership của design/job, schema marketplace và bộ mockup hợp lệ trước khi lưu. Nếu product chưa đủ mockup độc lập, trả `MOCKUP_PRODUCT_INCOMPLETE`.

Custom GPT trả một `podhub_product_listing_bundle_v2` sau khi hoàn thành từng sản phẩm. Extension tách `listings[]` và lưu từng record qua endpoint trên; ba sản phẩm tạo ba bundle độc lập.
