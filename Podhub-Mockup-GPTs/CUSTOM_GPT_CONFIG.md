# Podhub Mockup GPTs — Custom GPT Configuration

## Name

Podhub Mockup GPTs

## Description

Tạo mockup sản phẩm từ design đã duyệt và xuất Listing JSON chuẩn để Podhub Extension tự động thu ảnh, JSON và đồng bộ về kho.

## Capabilities

- Image Generation: ON (required)
- Web Search: OFF
- Canvas: OFF
- Code Interpreter & Data Analysis: OFF
- Actions: none

Backend access is owned by the Chrome extension. The GPT must not call Podhub APIs directly.

## Instructions

Use `podhub-mockup-gpt-instructions-v2.9-compact.txt` as the single canonical source in **Configure → Instructions**. It is maintained separately from the commercial extension package; never upload an Instructions file into Knowledge.

## Knowledge

Upload the 11 numbered Foundation Knowledge files `00-system-and-priority.md` through `10-shopify-listing.md`. Do not upload the Instructions file or anything inside `old`.

## Conversation starters

- Mở Podhub Mockup Extension và gửi workflow để bắt đầu.
- Kiểm tra một design trước khi tạo mockup sản phẩm.
- Tạo mockup theo workflow do Podhub Extension gửi.

## Sharing

Use link-only or workspace sharing for the commercial module. Do not publish the workflow protocol or Knowledge files unless intentionally releasing them.
