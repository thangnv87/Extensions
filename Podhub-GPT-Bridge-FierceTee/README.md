# FierceTee Team Bridge

Bản extension riêng cho team FierceTee.

## Kiến trúc key

- Team API Key (`phb_team_live_...`) chỉ lưu trên backend FierceTee và dùng cho Partner API.
- Mỗi nhân viên nhận một Extension License Key (`phb_ext_live_...`).
- Extension kích hoạt key nhân viên tại `tools.podhub.space`, sau đó nhận token ngắn hạn để truy cập `api.fiercetee.com`.
- Bản này từ chối license không thuộc team FierceTee hoặc routing không trỏ về `https://api.fiercetee.com`.

## Cấp key nhân viên

Dùng trang Admin → Team API & Routing để quản lý team, hoặc backend FierceTee gọi Partner API đã mô tả trong `docs/fiercetee-partner-api.md` của kho `podhub-tools`.

Không nhúng Team API Key vào mã nguồn, file ZIP hoặc giao diện extension.

## Build

```powershell
npm ci
npm run build
```

Nạp thư mục `release` vào Chrome để kiểm thử. Chỉ phân phối bản `release` đã obfuscate.
