# Podhub Mockup GPTs

Chrome Extension Manifest V3 điều phối workflow thương mại theo Queue.

## Workflow v0.9

1. Nhận một hoặc nhiều Raw Design từ Podhub hoặc Upload thủ công.
2. Tạo một backend job cho mỗi design và hiển thị thành card trong Queue.
3. Mở một cuộc chat Custom GPT mới cho từng job, upload design và gửi một câu yêu cầu phân tích tự nhiên, không gửi ID hay tên file.
4. GPT trả phân tích Markdown và một fenced JSON block `podhub_mockup_prompts_v1` chứa đúng số `mockup_prompts` cho từng sản phẩm.
5. Extension lưu prompt rồi gửi nguyên văn từng `prompt`; không ghép thêm context hoặc contract.
6. Mỗi ảnh được lưu backend với `product_id`, `mockup_no`, `asset_id` và `content_sha256`.
7. Backend chỉ xác nhận hoàn thành sản phẩm khi đủ N mockup number, N asset và N content hash duy nhất.
8. Sau khi một sản phẩm đủ ảnh, extension gửi câu tự nhiên yêu cầu listing SEO cho các marketplace đã chọn; GPT trả `podhub_product_listing_bundle_v2`.
9. Extension tự gắn job/task/design ID, tách bundle thành từng listing record, lưu backend rồi chuyển sang sản phẩm tiếp theo.
10. Job chỉ chuyển `done` khi mọi sản phẩm và listing đều được backend xác nhận đầy đủ.

## UI

- Checkbox cho phép chọn nhiều sản phẩm, listing và job.
- Số mockup gợi ý của sản phẩm lấy từ `default_mockup_count` trong catalog backend.
- Nút trên cùng điều khiển Chạy, Tạm dừng an toàn và Tiếp tục.
- Upload thủ công hỗ trợ nhiều file và sử dụng cùng Queue với mọi nguồn khác.

## Cài thử

1. Mở `chrome://extensions`.
2. Bật Developer mode.
3. Chọn **Load unpacked**.
4. Chọn thư mục `Podhub-Mockup-GPTs` hoặc thư mục `release`.
5. Nhập license thuộc module `mockup-gpts`.

Backend phải có GPT link active, catalog sản phẩm và listing options cho module `mockup-gpts`. Extension không hard-code URL Custom GPT.

## Contract chính

- `POST /api/extension/mockup-jobs/manual`
- `GET /api/extension/mockup-jobs`
- `POST /api/extension/mockup-jobs/:id/mockups`
- `GET /api/extension/mockup-jobs/:id/products/:productId/validation`
- `POST /api/extension/mockup-jobs/:id/listings`
- `POST /api/extension/mockup-jobs/:id/status`

Chi tiết nằm trong `SERVER_CONTRACT.md` và `GPT_ACCEPTANCE_TESTS.md`.

Dùng toàn bộ `podhub-mockup-gpt-instructions-v2.9-compact.txt` làm nguồn duy nhất trong **Configure → Instructions**. Instructions được quản lý riêng và không upload vào Knowledge. Upload đúng 11 file Knowledge `00`–`10` trong bộ Foundation hiện hành.
