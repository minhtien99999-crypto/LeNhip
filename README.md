# LeNhip

LeNhip là ứng dụng trợ lý cá nhân của LeDB, gồm ba mô-đun:

- **Sức khỏe**: tóm tắt bước chân và giấc ngủ, tính trên điện thoại.
- **Lịch**: dành khung giờ riêng trong lịch Microsoft 365 công việc.
- **Ngôi nhà**: bật/tắt đèn đã đăng ký tại site.

LeLe là engine đề xuất dùng chung; LeASO cung cấp IAM.

Repo này là **bản tham chiếu 0.1.0** theo *Đặc tả kỹ thuật LeNhip* LNH-SRS-001 V1.1 (11/11/2026) và gói giao diện 5 phương án V1.0. Đây chưa phải app phát hành:

- chưa có app iOS/Android;
- chưa kết nối thiết bị, lịch Microsoft 365 hay IAM thật;
- chưa ca nghiệm thu nào chạy trên đích.

## Có gì trong bản 0.1.0

| Phần | Nội dung |
|---|---|
| `contracts/` | Hợp đồng dùng chung cho máy chủ, iOS và Android: OpenAPI 3.1 (`openapi.json`), bảng chuyển trạng thái (`state_transitions.csv`), fixture LNH-SLEEP-1 S01–S16, vector JCS RFC 8785, ma trận truy vết REQ/TEST (`traceability.json`). |
| `web/shared/` | Mã chạy được cả trên trình duyệt lẫn Node: LNH-SLEEP-1, JCS, múi giờ IANA, chữ LeLe đã chốt, dữ liệu sức khỏe tổng hợp. |
| `src/server/` | Máy chủ tham chiếu. Chi tiết ở bảng dưới. |
| `src/adapters/` | Adapter lịch (Microsoft Graph giả lập), gateway site (Home Assistant/Matter giả lập), robot mô phỏng. |
| `web/` | Giao diện web responsive 5 phương án PA01–PA05, nối API, chữ LeLe theo hình đã chốt. |
| `tests/` | Kiểm thử node:test cho phần chạy được không cần thiết bị của T02, T03, T05–T15, T17, T19. |
| `docs/RA_SOAT_LENHIP_V1_1.md` | Bản rà soát: phát hiện LNH-F, tinh chỉnh LNH-T, câu hỏi LNH-Q, việc còn lại LNH-D. |
| `docs/source/` | Đặc tả V1.1 và gói giao diện V1.0, giữ nguyên byte. |

Các thành phần của `src/server/`:

| Thành phần | Nội dung |
|---|---|
| Authority | Thành viên, quyền, đồng ý, chính sách xuất, binding, snapshot phiên bản |
| Plan và phê duyệt | Hạn duyệt 120 giây |
| Máy trạng thái | Theo sự kiện, đọc bảng từ CSV |
| Idempotency | Giữ phát lại 90 ngày |
| Permit LNH-PERMIT-1 | JWS ES256, kiểm tại receiver ở điểm ra I/O |
| Barrier và control store | Barrier độc lập ghi trước I/O; control store giữ recovery_epoch |
| Đối soát | Reconciler và SLA của UNKNOWN |
| Khôi phục | Quy trình 5 bước |
| Khác | Quyền chủ thể dữ liệu, Model Gateway của LeLe, API /v1 |

## Chạy thử

Cần Node 22.18 trở lên (chạy TypeScript trực tiếp, `node:sqlite`). Không cần build.

```bash
npm ci
npm run dev        # http://127.0.0.1:8787 — issuer phát triển, ba tài khoản thử, lịch và đèn giả lập
```

- Bản chạy thử chỉ nghe trên localhost.
- Lần đầu mở sẽ có *Thông báo đầu tiên* với bốn mục đích, mặc định để trống.
- Nút avatar đổi giữa các tài khoản thử: Thử nghiệm A, Thử nghiệm B, Vận hành LeDB.

Chạy với IAM thật:

```bash
LENHIP_OIDC_ISSUER=… LENHIP_OIDC_AUDIENCE=lenhip-api LENHIP_OIDC_JWKS_FILE=jwks.json npm start
```

Bản này chưa có adapter Graph và Matter thật (LNH-D07), nên lịch và đèn vẫn đi qua adapter giả lập.

## Kiểm tra

```bash
npm run typecheck   # tsc --noEmit, gồm cả mã JS dùng chung (checkJs)
npm test            # hành trình, máy trạng thái, plan, permit, idempotency, đối soát, khôi phục, API, giấc ngủ, JCS
npm run check       # OpenAPI ↔ route, bảng trạng thái ↔ mã, fixture, truy vết, mã băm tài liệu nguồn
npm run e2e         # trình duyệt thật (cần Playwright có sẵn): đồng ý, lịch, đèn, sức khỏe, LeLe, 5 phương án, chữ 200 %
```

`npm run fixtures` sinh lại fixture. Chỉ chạy khi đổi fixture có chủ đích; đổi thuật toán thì phải đổi `algorithm_version`.

## Nguyên tắc của bản tham chiếu

- **Sức khỏe không rời điện thoại.** Máy chủ từ chối mọi trường nguồn sức khỏe (`additionalProperties=false`) và từ chối đồng ý `health_local`.
- **Không có thao tác giả.** Lịch và đèn chỉ đổi qua chuỗi: plan → xem lại nội dung đã chuẩn hóa → xác nhận trong 120 giây → permit → receiver → bằng chứng. Kết quả hiển thị theo bằng chứng.
- **Thời gian trôi qua không phải bằng chứng.** UNKNOWN không bao giờ tự thành FAILED; không có POST nào được tự gửi lại.
- **LeLe chỉ đề xuất.** Mọi đề xuất đi qua cùng bước xem lại và xác nhận. Chưa có mô hình AI nào được duyệt, nên LeLe dùng quy tắc cục bộ.
- **Không có dữ liệu người thật trong repo.** Tài khoản, site và đèn đều là dữ liệu tổng hợp.

## Chữ LeLe

Chữ LeLe dùng hình đã chốt ở LeASO–LHLC Web 1.0.7: chữ "Le" vẽ theo ảnh mẫu, không phải phông.

- Nút *Hỏi LeLe*, tiêu đề trò chuyện và nhãn trên hero dùng màu hổ phách.
- Trên quả cầu dùng bản hai màu (Le hổ phách, Le xanh) trên nền tối, như ảnh đăng nhập V1.0.

Mã ở `web/shared/lele-mark.js`.

## Việc còn lại trước beta

Danh sách đầy đủ ở `docs/RA_SOAT_LENHIP_V1_1.md` mục 5 (LNH-D01 đến LNH-D12) và `contracts/traceability.json`. Các việc chính:

- App iOS/Android.
- PostgreSQL synchronous replication.
- Kho barrier độc lập.
- KMS và mTLS.
- Adapter Graph và Matter thật.
- Hồ sơ pháp lý G0.
- Chạy T01–T22 trên đích.
