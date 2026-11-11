# Rà soát LNH-SRS-001 V1.1 và gói giao diện 5 phương án V1.0

Bản rà soát này phục vụ mã nguồn LeNhip 0.1.0 (bản tham chiếu). Ngày rà: 11/11/2026.

| Nguồn | Tệp | SHA-256 |
|---|---|---|
| Đặc tả kỹ thuật LeNhip V1.1 (LeDB) | `docs/source/LeNhip_Dac_Ta_Ky_Thuat_LeDB_V1_1.docx` | `51783c43a4ea55e9b685e548cf0ade386042b3d826048a2f1eeb8d65ae9d3501` |
| Gói giao diện 5 phương án V1.0 | `docs/source/LeNhip_UI_5_Phuong_An_V1_0.zip` | `588c0dfe7fb26281f71c757bc2416477b16cc18865c06f1582bf301f9f3f2ec5` |

Hai tệp nguồn được giữ nguyên byte. `npm run check` kiểm lại mã băm của chúng.

## 1. Kết luận

- Đặc tả V1.1 đủ chặt để lập trình phần hợp đồng: máy trạng thái, permit, idempotency, sổ thực thi và khôi phục, đối soát UNKNOWN, ba hành trình.
- Có 13 chỗ vênh hoặc thiếu định nghĩa (LNH-F01 đến LNH-F13). Bản tham chiếu đã chốt cách làm cho cả 13 (LNH-T01 đến LNH-T13). Các cách làm này cần Tech Lead ghi nhận ở G0.
- Gói giao diện giữ được 5 phương án, bố cục và khả năng tiếp cận cơ bản. Tuy vậy nó đi tắt qua mọi hợp đồng an toàn: lưu lịch và đèn ngay trên trình duyệt, không có bước xem lại có hạn, không có UNKNOWN (LNH-F14 đến LNH-F19). Bản 0.1.0 nối giao diện vào API và giữ nguyên hình thức.
- Chữ LeLe trong gói dùng phông Inter. Bản 0.1.0 thay bằng chữ LeLe đã chốt (LNH-T14).
- Phần pháp lý (Luật 91/2025, NĐ 356, Luật 134, danh mục y tế) **không** được rà ở đây; CLO giữ phần này. Mã chỉ cài các hạn và luồng mà đặc tả nêu.
- Chưa có thiết bị, lịch Microsoft 365, IAM hay hạ tầng thật nào được kết nối. Chưa ca T01–T22 nào chạy trên đích.

## 2. Phát hiện

| Mã | Mục SRS | Phát hiện | Xử lý |
|---|---|---|---|
| LNH-F01 | 19 so với 22 | Mục 22 bước 2 kết thúc CONFLICT khi lịch bận *trước khi* tạo event, nhưng bảng chuyển trạng thái chỉ có CONFLICT từ ACKED hoặc UNKNOWN. | LNH-T01 |
| LNH-F02 | 13 so với 20 | Mục 13 khóa tác vụ tương đương ngay khi UNKNOWN, mục 20 chỉ khóa từ mốc 1 giờ. Ngoài ra "tương đương" chưa được định nghĩa. | LNH-T02 |
| LNH-F03 | 15, 19 | Bảng có cạnh PENDING/deny và PENDING/cancel nhưng API mục 15 không có endpoint cho chúng. | LNH-T03 |
| LNH-F04 | 14 | authz_version chưa rõ phạm vi. Nếu đếm chung cho cả workspace, một người bị thu hồi quyền sẽ làm mọi approval của người khác trở thành stale. | LNH-T04 |
| LNH-F05 | 16 | "Khóa 16–128 ký tự, tối thiểu 128 bit" mâu thuẫn: 16 ký tự ASCII in được không đủ 128 bit, UUIDv4 cũng chỉ có 122 bit. | LNH-T05 |
| LNH-F06 | 15, 16 | IDEMPOTENCY_EXPIRED không có mã HTTP trong bảng lỗi. Duyệt quá hạn phải vừa trả 410 vừa ghi EXPIRED, nhưng đặc tả chưa nói giao dịch xử lý thế nào. | LNH-T06 |
| LNH-F07 | 07 (S01) | S01 cần 7,5 giờ, tức đoạn thức phải *trừ* khỏi đoạn ngủ chồng lên nó. Quy tắc 3 chỉ nói "không gồm khoảng thức". | LNH-T07 |
| LNH-F08 | 06, 07 | HealthDay.sleep_seconds là phiên chính hay tổng cả giấc phụ chưa rõ; coverage_days đặt trên từng ngày cũng chưa rõ nghĩa. | LNH-T08 |
| LNH-F09 | 07 | Chưa quy định: episode kết thúc đúng nửa đêm thuộc ngày nào; episode quá 24 giờ có tính không; cách làm tròn giây và trung bình. Hai OS sẽ lệch nhau. | LNH-T09 |
| LNH-F10 | 07 | Ngưỡng "tối thiểu 4/7 ngày" chỉ nói cho giấc ngủ; bước chân chưa rõ. | LNH-T10 |
| LNH-F11 | 14, 17 | target_binding_version chỉ định nghĩa cho thiết bị, nhưng permit bắt buộc có trường này với mọi đích. | LNH-T11 |
| LNH-F12 | 20 | Operator "ghi cấp bằng chứng" nhưng bốn cấp bằng chứng không có cấp nào cho xác nhận thủ công. | LNH-T12 |
| LNH-F13 | 21 | Bước 3 nhập action thành UNKNOWN, nhưng bảng trạng thái không có cạnh từ PENDING hoặc AUTHORIZED (trạng thái trong DB đã restore) sang UNKNOWN. | LNH-T13 |
| LNH-F14 | Gói giao diện | Chữ "LeLe" trên quả cầu, nút "Hỏi LeLe" và tiêu đề trò chuyện dùng phông Inter, chưa theo chữ LeLe đã chốt. | LNH-T14 |
| LNH-F15 | 13, 14 so với gói | Gói lưu lịch và đổi đèn ngay trong localStorage. Không có plan, digest, hạn 120 giây, UNKNOWN; đèn đổi không cần xác nhận. | LNH-T16 |
| LNH-F16 | 15 so với gói | Gói hiện tiêu đề cuộc họp ("Họp dự án") trong khi availability theo đặc tả không trả tiêu đề. Ngày "11/11" và giờ bận viết cứng. | LNH-T16 |
| LNH-F17 | 13 so với gói | Cỡ chữ tối đa 130 % trong khi ACC01 yêu cầu 200 %. Giảm chuyển động chỉ bật tay, không lấy mặc định từ hệ điều hành. | LNH-T16 |
| LNH-F18 | 06, 07 so với gói | Màn hình sức khỏe dùng số viết cứng ("5 ngày có dữ liệu", "7 giờ 30 phút"), không qua thuật toán, không tách hôm nay. | LNH-T16 |
| LNH-F19 | 09, 15 | "Export/xóa cần xác thực lại phù hợp" nhưng không có độ tuổi tối đa của lần xác thực. | LNH-T15 |

## 3. Tinh chỉnh đã cài trong mã

| Mã | Nội dung | Ở đâu |
|---|---|---|
| LNH-T01 | Thêm cạnh `DISPATCHING / precheck_conflict → CONFLICT` (VERIFIER). Khi đó outcome BUSY_BEFORE_CREATE, event_created=false, dispatch_state NOT_SENT. Việc kiểm bận nằm sau claim, trước barrier. | `contracts/state_transitions.csv`, `src/server/receiver.ts`, `src/adapters/calendar.ts` |
| LNH-T02 | Khóa tác vụ tương đương ngay khi vào UNKNOWN (409 RESOURCE_LOCKED). Tương đương nghĩa là: cùng thiết bị, hoặc cùng tài khoản lịch với khung giờ giao nhau. Mốc 1 giờ dùng cho escalate và thông báo người dùng. | `src/server/plans.ts`, `src/server/reconciler.ts` |
| LNH-T03 | Thêm `POST /v1/plans/{id}/deny` và `/cancel`. Hủy sau khi duyệt đi qua `/v1/actions/{id}/cancel`. | `contracts/openapi.json`, `src/server/api.ts` |
| LNH-T04 | authz_version tính theo từng thành viên, tăng khi đổi quyền, đồng ý, xóa hoặc hạn chế. Thay đổi chính sách chung của workspace đi qua export_policy_digest. | `src/server/authority.ts` |
| LNH-T05 | Idempotency-Key gồm 22–128 ký tự `[A-Za-z0-9_-]`. Client tạo 32 byte ngẫu nhiên. | `contracts/openapi.json`, `src/server/idempotency.ts`, `web/api.js` |
| LNH-T06 | IDEMPOTENCY_EXPIRED trả 410 kèm resource_id. Lỗi mang thay đổi trạng thái hợp lệ (APPROVAL_EXPIRED, PLAN_STALE kèm invalidate) vẫn COMMIT trước khi trả lỗi. | `src/server/idempotency.ts`, `src/core/errors.ts`, `src/server/store.ts` |
| LNH-T07 | Đoạn awake của cùng nguồn được trừ khỏi phần hợp asleep; inBed bỏ qua. | `web/shared/sleep.js` |
| LNH-T08 | sleep_seconds là giấc chính; các episode (chính, phụ, lỗi) liệt kê riêng. coverage_days là số ngày có quan sát trong 7 ngày đã kết thúc của chuỗi. Thêm trường `complete` để tách hôm nay. | `web/shared/sleep.js`, fixture S04, S13 |
| LNH-T09 | Ngày của episode là ngày local chứa thời điểm kết thúc. Episode dài hơn 24 giờ thành ERROR, không tính, ngày đó ghi DATA_ERROR. Thời gian tính bằng mili giây nguyên; giây lấy floor; trung bình làm tròn nửa lên. | `web/shared/sleep.js`, fixture S11, S16 |
| LNH-T10 | Trung bình bước chân cũng cần ít nhất 4/7 ngày có quan sát. | fixture S14 |
| LNH-T11 | target_binding_version của lịch là binding_version của liên kết tài khoản (tăng khi liên kết lại hoặc đổi scope); robot mô phỏng dùng 1. | `src/server/authority.ts`, `src/server/plans.ts` |
| LNH-T12 | Bằng chứng của operator phải dùng một cấp có sẵn (không được SIMULATED) và ghi danh tính operator trong dữ liệu bằng chứng. Operator không đẩy được tác vụ khỏi DISPATCHING. | `src/server/api.ts` |
| LNH-T13 | Thêm cạnh `PENDING_APPROVAL/AUTHORIZED / recovery_import → UNKNOWN`. Action nhập từ barrier mang cờ imported, không bao giờ được cấp quyền I/O. | `contracts/state_transitions.csv`, `src/server/recovery.ts` |
| LNH-T14 | Chữ LeLe dùng hình đã chốt ở LeASO–LHLC Web 1.0.7: cùng dữ liệu đường vẽ theo ảnh "Le", màu hổ phách `#faaf4d`. Trên quả cầu dùng bản hai màu (Le hổ phách `#ffb54e`, Le xanh `#57dfff`) đặt trên nền tối, như ảnh đăng nhập V1.0. Trình đọc màn hình đọc "LeLe". | `web/shared/lele-mark.js`, `web/styles.css` |
| LNH-T15 | EXPORT và DELETE cần auth_time trong 5 phút; quá hạn trả 401 REAUTH_REQUIRED. | `src/server/privacy.ts` |
| LNH-T16 | Nối giao diện vào API, gồm: plan → xem lại (kiểm digest bằng JCS ở client) → đếm ngược 120 giây → xác nhận → theo dõi theo bằng chứng; màn hình "Chưa xác minh kết quả"; thẻ trạng thái đèn tách khỏi kết quả tác vụ; lịch chỉ hiện "Bận"; ngày giờ theo đồng hồ và múi; cỡ chữ 150/200 %; mặc định theo prefers-reduced-motion; thông báo đầu tiên với các ô để trống; sức khỏe tính bằng LNH-SLEEP-1 trên dữ liệu tổng hợp. | `web/` |
| LNH-T17 | Không đọc được trạng thái trước I/O thì kết thúc FAILED (NOT_SENT), không chuyển UNKNOWN, vì chắc chắn chưa phát. | `src/server/receiver.ts` |
| LNH-T18 | Đã claim nhưng không có bản ghi barrier: theo bất biến "barrier trước mọi I/O", đây là bằng chứng chưa phát, nên FAILED với lý do NO_BARRIER_NO_IO. Dòng barrier ghi dở được coi là có thể đã phát. | `src/server/reconciler.ts`, `src/server/journal.ts` |
| LNH-T19 | Receiver nhận theo họ audience (`lenhip:site:<site>`, `lenhip:calendar-adapter`). Robot mô phỏng có trust root và issuer riêng. | `src/server/receiver.ts`, `src/server/app.ts` |

## 4. Câu hỏi cần quyết

| Mã | Câu hỏi | Người quyết |
|---|---|---|
| LNH-Q01 | Pháp nhân cung cấp LeNhip, vai bên kiểm soát và bên xử lý, danh mục nhà cung cấp (Microsoft 365, APNs/FCM, hỗ trợ). | CLO, đầu mối bảo vệ dữ liệu |
| LNH-Q02 | IAM nào cấp token OIDC cho LeNhip? LeASO–LHLC hiện chưa là OIDC provider. | Tech Lead LeDB |
| LNH-Q03 | Nhà cung cấp mô hình cho LeLe (VendorProfile: vùng, retention, không huấn luyện, DPA). Trước khi có, LeLe dùng quy tắc cục bộ. | CLO, Tech Lead |
| LNH-Q04 | Cơ sở giữ tối thiểu khi xóa: action đã kết thúc trong 90 ngày (dạng digest), action chưa rõ kết quả, biên nhận đồng ý. | CLO |
| LNH-Q05 | Hạn "ngày" trong mục 09 là ngày lịch hay ngày làm việc? Lịch nghỉ lễ nào áp dụng? Bản tham chiếu: tiếp nhận 2 ngày làm việc (thứ Hai–thứ Sáu, chưa có ngày lễ), các hạn khác tính theo ngày lịch. | CLO |
| LNH-Q06 | Hủy khối lịch do LeNhip tạo (mục 22 bước 6) là một loại tác vụ mới (`calendar.unblock`). Đưa vào G1-C hay để sau? | Product Owner |
| LNH-Q07 | "Giờ phục vụ beta" cho mốc 15 phút nhận ticket là những giờ nào? | Product Owner |

## 5. Việc còn lại

| Mã | Việc |
|---|---|
| LNH-D01 | App iOS (SwiftUI): HealthSource trên HealthKit; port LNH-SLEEP-1 và JCS; chạy đủ S01–S16 và vector JCS. |
| LNH-D02 | App Android (Kotlin Compose): HealthSource trên Health Connect, kiểm personal profile; port và chạy cùng fixture. |
| LNH-D03 | Đăng nhập OIDC code + PKCE với IAM được chọn (LNH-Q02), xoay JWKS. |
| LNH-D04 | Sổ thực thi trên PostgreSQL synchronous replication hai miền lỗi; đóng phát khi thiếu standby. `src/server/store.ts` giữ đúng bảng và bất biến để chuyển. |
| LNH-D05 | Kho barrier và sổ thu hồi độc lập với DB và chu trình backup, có ACL, retention và chống sửa (object lock). |
| LNH-D06 | KMS cho khóa permit; mTLS thật giữa worker và receiver (x5t#S256 lấy từ chứng chỉ peer); runbook xoay khóa. Tách Authority, worker và receiver thành các dịch vụ riêng. |
| LNH-D07 | Adapter Microsoft Graph thật (delegated Calendars.ReadWrite, consent của tenant, vault giữ refresh token). Gateway Home Assistant Green và Matter với đèn Nanoleaf; kiểm VID/PID/chứng nhận ở G0. |
| LNH-D08 | OpenTelemetry với allowlist thuộc tính, xuất metrics, cảnh báo, on-call. |
| LNH-D09 | Nội dung thông báo và đồng ý do CLO duyệt, hồ sơ tác động, bản đồ luồng dữ liệu. |
| LNH-D10 | Chạy T01–T22 trên đích, lưu bằng chứng QA. |
| LNH-D11 | `calendar.unblock`, độ sáng (capability P1). |
| LNH-D12 | Công cụ cohort dogfood và beta, KPI có mẫu số, telemetry opt-in. |

## 6. Mã đã cài so với đặc tả

`contracts/traceability.json` ghi trạng thái của 33 REQ và 22 ca T, cùng tệp mã và tệp kiểm thử tương ứng. Tóm tắt:

- **Có mã và kiểm thử trên bản tham chiếu:** H03, X01, REC01, POL01, API01, TX01, PER01, ST01.
- **Có một phần:**
  - ARC01, OBS01, H02, PRIV01, PRIV02, AI01, RET01, DR01, SEC01, UX01, ACC01, CAL01, EDGE01, MG01, KPI01, REL01.
  - Phần còn lại của mỗi REQ ghi trong tệp truy vết.
- **Cần app native:** MOB01, H01.
- **Quyết định hoặc hồ sơ ở G0:** OWN01, LEG01, INC01, MED01, PIL01, PLAN01, IP01.
