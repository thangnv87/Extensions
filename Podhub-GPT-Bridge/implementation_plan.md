# Kế hoạch thêm nút Save Etsy vào Podhub-GPTs

## Mục tiêu
Khi người dùng mở một listing Etsy, extension Podhub-GPTs sẽ hiện nút Save trên vùng ảnh. Người dùng chọn ảnh đang xem, extension lấy ảnh + title + description + listing ID, cho chọn/thêm tag ngay trong UI, lưu sản phẩm vào database Etsy Spy để hiện cùng các sản phẩm khác, đồng thời đẩy vào queue `/api/ext-queue/jobs`. Sau đó phần ChatGPT extension hiện tại sẽ tự xử lý job như bình thường.

## Tham khảo từ Etsy Spy
- Phát hiện trang chi tiết bằng đường dẫn `/listing/{id}`.
- Lấy `listingId` từ URL hoặc `input[name="listing_id"]`.
- Lấy title từ `h1.wt-text-body-03` hoặc `h1`.
- Lấy ảnh đang active trong carousel, ưu tiên ảnh đang hiển thị, sau đó fallback ảnh đầu tiên.
- Chuyển URL ảnh Etsy về bản lớn bằng cách thay `il_...` thành `il_fullxfull`.

## Thay đổi dự kiến
1. Cập nhật `manifest.json`
   - Thêm quyền chạy content script trên `https://www.etsy.com/*`.
   - Thêm host permission cho `https://*.etsystatic.com/*` nếu cần truy cập ảnh Etsy.
   - Tăng version extension.

2. Cập nhật `chatgpt.js`
   - Tách nhánh khởi tạo theo domain:
     - Trên ChatGPT: giữ nguyên toàn bộ panel và runner hiện tại.
     - Trên Etsy: chỉ chạy logic nút Save Etsy, không dựng panel ChatGPT.
   - Thêm helper lấy listing ID, title, description, ảnh active/high-res.
   - Thêm nút `Save PodHub` trên vùng ảnh listing Etsy.
   - Khi bấm Save, mở popup nhỏ cho chọn tag và thêm tag mới.
   - Không tạo mới hoặc thêm `Đã gửi lên GPTs` như tag người dùng.
   - Khi save thành công vào queue GPTs, ghi marker trạng thái để Spy UI hiện badge có sẵn `Đã gửi lên GPTs`.
   - Lưu danh sách tag người dùng đã tạo trong `localStorage` để lần sau chọn lại nhanh.
   - Khi xác nhận Save, gửi vào Etsy Spy database qua `/api/local-spy/etsy/save`:
     ```json
     {
       "id": "listingId",
       "asin": "listingId",
       "title": "listing title",
       "image": "image-url",
       "type": "T-Shirt",
       "niche": "Đã gửi lên GPTs",
       "tags": {
         "listingTags": [],
         "images": ["image-url"],
         "description": "listing description",
         "podhubTags": ["tag phụ do người dùng chọn"],
         "sentToGpts": true
       }
     }
     ```
   - Đồng thời gửi queue GPTs qua `/api/ext-queue/jobs`:
     ```json
     {
       "source": "etsy-spy",
       "images": [
         {
           "url": "image-url",
           "title": "listing title",
           "assetId": "listingId",
           "etsyListingId": "listingId",
           "sourceUrl": "listing url"
         }
       ]
     }
     ```
   - Dùng token đã lưu trong `localStorage.phb_jwt_token` nếu có; nếu chưa có token thì báo rõ cần lưu token trước.
   - Hiển thị trạng thái trên nút: checking/saving/saved/error.

3. Cập nhật Etsy Spy UI nếu cần
   - `EtsySpyApp` hiện đã load từ `/api/local-spy/etsy`, nên sản phẩm lưu mới sẽ tự xuất hiện sau khi refresh/load lại.
   - Cập nhật logic `mergedSyncStatus` để ngoài `localStorage spy_persisted_gpt_sent_etsy`, còn đọc marker từ DB (`tags.sentToGpts` hoặc tương đương) và set `sentToGpts: true`.
   - Badge `Đã gửi lên GPTs` vẫn dùng UI có sẵn trong `EtsySpyDataGrid`, không tạo nhãn/tag mới.
   - Nếu cần hiển thị tag phụ do người dùng chọn, đọc từ `tags.podhubTags` và hiển thị riêng, không trộn với badge trạng thái GPTs.
   - Giữ tương thích helper hiện có đang đọc `tags.images`.

4. Kiểm tra
   - Soát cú pháp JavaScript.
   - Kiểm tra manifest hợp lệ.
   - Nếu có thể, test nhanh bằng trang Etsy mẫu/local browser để xác nhận nút xuất hiện, popup tag hoạt động, payload lưu DB + queue đúng format.

## Không làm trong đợt này
- Không sửa `server.ts`.
- Không tạo migration database nếu có thể lưu description/tag mở rộng trong cột `tags` JSON hiện có.
- Không sửa flow ChatGPT xử lý queue hiện tại.
