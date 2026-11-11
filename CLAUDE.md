# LeNhip — quy tắc làm việc

Bản tham chiếu 0.1.0 theo LNH-SRS-001 V1.1. Bản đồ repo nằm ở `README.md`; rà soát và các mã LNH-F/T/Q/D nằm ở `docs/RA_SOAT_LENHIP_V1_1.md`.

## Quy tắc chung

- Trả lời đúng điều được hỏi trước. Không biết thì nói không biết.
- Làm đủ rồi mới báo xong: chạy mục Kiểm tra, và báo cả phần chưa kiểm hoặc chưa làm.
- Viết tiếng Việt, tệp UTF-8. Script Python mở tệp với `encoding="utf-8"`.
- Commit theo dạng `type(scope): mô tả` bằng tiếng Anh, mỗi commit một việc. Chỉ commit và push khi người dùng yêu cầu.
- Không in, log hay commit secret, token hay khóa riêng. Khóa permit nằm trong thư mục dữ liệu (bị gitignore), môi trường thật dùng KMS.

## Không được làm

- Không sửa tệp trong `docs/source/`. Hai tệp này phải khớp mã băm trong `contracts/traceability.json`.
- Không đưa số liệu sức khỏe, nhãn sức khỏe hay lý do của gợi ý vào API hay sổ. Schema tác vụ luôn `additionalProperties=false`.
- Không thêm đường nào đổi lịch hoặc thiết bị mà bỏ qua plan → xác nhận → permit → receiver → bằng chứng. Không tự gửi lại sau kết quả mơ hồ. Không tự chuyển UNKNOWN thành FAILED.
- Không thêm cạnh trạng thái chỉ trong mã. Mọi cạnh nằm ở `contracts/state_transitions.csv`; thêm cạnh phải ghi mã LNH-T trong bản rà soát.
- Không sửa migration đã phát hành (`src/server/store.ts`, có kiểm mã băm). Cần đổi thì thêm migration mới.
- Không đổi kết quả fixture LNH-SLEEP-1 mà giữ nguyên `algorithm_version`.
- Không bật nhà cung cấp mô hình ngoài khi chưa có VendorProfile được duyệt.
- Không dùng tên người thật trong dữ liệu mẫu.

## Kiểm tra

```bash
npm ci
npm run typecheck && npm test && npm run check
npm run e2e        # khi đổi giao diện; cần Playwright
```
