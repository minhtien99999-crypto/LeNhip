# Rà soát LNH-SRS-002 V2.0 và bản tham chiếu 1.0.1

Ngày 12/11/2026. Đối chiếu *Đặc tả kỹ thuật LeNhip* V2.0 (`docs/source/LeNhip_Dac_Ta_Ky_Thuat_LeDB_V2_0.docx`, LNH‑SRS‑002) với
mã 1.0.0, ghi phần đã có, phần 1.0.1 tích hợp thêm và phần còn lại. Mã `LNH-…` ở đây tiếp nối hai tài liệu trước: phát hiện từ
LNH-F30, quyết định từ LNH-T60, câu hỏi từ LNH-Q16, việc từ LNH-D21. Bản rà soát V1.1 ở `docs/RA_SOAT_LENHIP_V1_1.md`, thiết kế
1.0.0 ở `docs/THIET_KE_V1_0_0.md`.

## 1. Kết luận

- V2.0 **thay định hướng và phạm vi phát hành** của V1.1 nhưng giữ gói hợp đồng V1.1 (OpenAPI, permit, bảng trạng thái, fixture,
  T01–T22) cho các API đã có. Mã 1.0.0 giữ nguyên hợp đồng đó; 1.0.1 thêm các phần của V2.0 dưới namespace `/v2/` theo đúng §12.
- Đầu ra bắt buộc của beta 12 tuần là **Bản tóm tắt buổi sáng** trên iOS/Android (G1‑H). 1.0.0 chưa có thẻ tóm tắt riêng; 1.0.1 thêm
  thẻ này trên web, dựng hoàn toàn trên thiết bị. App iOS/Android vẫn chưa có (LNH-D01, LNH-D02).
- 1.0.1 cài **mã tham chiếu** cho mọi phần mở rộng của V2.0: Hộp tổng hợp, đồng bộ bản nháp và phiên thiết bị, Le‑NodeHome và gói
  thuê HaaS, Le‑NodeHealth phép đo, cổng mô phỏng Le‑ORION. Mỗi phần có cờ riêng **tắt khi chưa đặt**; nguồn Microsoft 365, hub,
  máy đo, danh tính adapter và phòng lab đều **giả lập** và được ghi rõ trên giao diện.
- Không cổng nào đóng; ca X01–X12 và T01–T22 đều **chưa chạy trên đích**. Kiểm thử trong repo là bằng chứng cho mã tham chiếu,
  không thay biên bản thử nghiệm (V2.0 «Trạng thái bằng chứng»).

## 2. Phát hiện

| Mã | Mức | Nội dung |
|---|---|---|
| LNH-F30 | Cao | Phạm vi beta của V2.0 là tóm tắt buổi sáng, tiếng Việt, iOS/Android; nhắn tin nhóm, web đa thiết bị, Home, Health đi sau beta theo cổng riêng. 1.0.0 đã có nhắn tin 1:1, chia sẻ mạng xã hội, 13 ngôn ngữ và thiết bị theo dõi: chúng vẫn tắt theo cờ, nhưng V2.0 không xếp chúng vào cổng nào (LNH-Q16). |
| LNH-F31 | Cao | V2.0 §08 và §11 cho phép **bản ghi phép đo** của Le‑NodeHealth nằm ở máy chủ, tách miền, có grant chia sẻ. Điều này khác quy tắc «sức khỏe không rời thiết bị» của V1.1 và 1.0.0, vốn áp cho HealthSource. 1.0.1 giữ HealthSource trên thiết bị và chỉ cài phép đo sau cờ, đồng ý, quyền riêng, với dữ liệu tổng hợp. Dùng dữ liệu thật cần CLO và chuyên gia y tế duyệt (G1‑P). |
| LNH-F32 | Cao | Hộp tổng hợp nhận tiêu đề email và nội dung chia sẻ là dữ liệu không tin cậy (§04, X04). Bất kỳ đường nào cho LeLe đọc chúng đều mở rủi ro chèn lệnh. 1.0.1 không cho LeLe đọc Hộp tổng hợp; mọi hành động từ một mục chỉ tạo bản nháp, không gửi gì ra ngoài. |
| LNH-F33 | Trung bình | V2.0 §12 ghim 422 cho lỗi schema hoặc dữ liệu, trong khi hợp đồng V1.1 và máy chủ trả 400 `SCHEMA_INVALID`. V2.0 cũng nói OpenAPI V1.1 vẫn là hợp đồng thực thi cho endpoint đã phát hành. 1.0.1 giữ 400 cho mọi route để một client không phải xử lý hai mã; cần quyết khi pin OpenAPI V2 (LNH-Q17). |
| LNH-F34 | Trung bình | V2.0 có hai khái niệm «thiết bị» của người dùng: phiên đăng nhập trên từng máy (`/v2/devices`, §03, X02) và điểm nhận tin có khóa mã hóa của nhắn tin (1.0.0, LNH-T30). Chúng chưa gộp. 1.0.1 cài phiên riêng; gộp hay giữ hai danh sách là câu hỏi LNH-Q18. |
| LNH-F35 | Trung bình | V2.0 không định nghĩa schema bản nháp. 1.0.1 chọn ba mục đích: giữ khung giờ, phản hồi từ Hộp tổng hợp, việc cá nhân; mỗi loại có schema đóng, không chứa số liệu sức khỏe. |
| LNH-F36 | Trung bình | V2.0 §06 yêu cầu hub tự khởi tạo kết nối ra ngoài và có danh tính riêng; §08 yêu cầu adapter phép đo được duyệt; §09 yêu cầu danh tính lab. Repo không có PKI, mTLS hay kho bí mật: 1.0.1 dùng danh tính giả lập chỉ ở chế độ dev và ghi rõ. |
| LNH-F37 | Thấp | Con số kinh tế của HaaS (§07) là giả định; giao diện chỉ hiển thị chúng kèm nhãn «giả định, không phải báo giá». |
| LNH-F38 | Thấp | §10 (máy chủ AI, GPU, FAT) là hạ tầng, không có mã trong repo. Yêu cầu liên quan tới mã là X11: khi AI dừng, tóm tắt cục bộ và các chức năng đọc, nháp vẫn chạy. LeLe của repo chỉ dùng quy tắc cục bộ nên đã thỏa điều này. |
| LNH-F39 | Thấp | V2.0 không nói về chia sẻ ra mạng xã hội hay ngôn ngữ ngoài tiếng Việt. Hai phần này của 1.0.0 nằm ngoài cả V1.1 lẫn V2.0 (LNH-F20). |

## 3. Đối chiếu từng mục của V2.0

| Mục V2.0 | Đã có ở 1.0.0 | 1.0.1 thêm | Còn lại |
|---|---|---|---|
| 01 Phạm vi, cổng | Cờ theo mô-đun, kill switch | Năm cờ mới tắt khi chưa đặt: `inbox`, `sync`, `home_hub`, `measurements`, `sim` | Biên bản từng cổng; cờ theo tenant, nhóm thử, loại thiết bị (LNH-D21) |
| 02 Hai trợ lý | LeLe chỉ đề xuất, quy tắc cục bộ, bộ lọc 13 ngôn ngữ | LeLe không đọc Hộp tổng hợp, camera, phép đo | LeLe–LeASO và hạ tầng mô hình (§10) |
| 03 Đa thiết bị, tóm tắt | Web responsive bốn cỡ, năm phong cách, PWA | Bản tóm tắt buổi sáng; bản nháp có revision và 409; hàng đợi ngoại tuyến; phiên thiết bị và thu hồi | App iOS/Android, đồng hồ, VoiceOver/TalkBack |
| 04 Hộp tổng hợp | — | Nhập nội dung chọn chia sẻ, danh sách theo cursor, Lưu, Để sau, Tạo việc cá nhân, Soạn phản hồi; nguồn Outlook `Mail.ReadBasic` **giả lập** | Microsoft Graph thật, Share Extension iOS và share target Android, LeASO và các nguồn khác |
| 05 Xác nhận, thực thi | Đủ chuỗi V1.1 (plan, 120 giây, permit, receiver, barrier, đối soát) | Không đổi | Như V1.1 |
| 06 Le‑NodeHome | — | Sự kiện tối thiểu từ hub với danh tính hub, chống trùng theo hub, camera, epoch, event_id; sự kiện trễ; quyền xem tạm thời có hạn | Hub thật, camera, clip từ xa (chỉ sau nghiệm thu) |
| 07 HaaS | — | Đăng ký và vòng đời REQUESTED → … → ACTIVE, SUSPENDED, TERMINATED, RETURNED; đổi hub tăng `binding_version` | Quy trình LeLS thật, hợp đồng và giá |
| 08 Le‑NodeHealth | Bluetooth nhịp tim, nhập tệp xuất (chỉ trên thiết bị) | Phép đo huyết áp theo hợp đồng N20‑MEAS, gán người đo theo xác nhận, cách ly khi mơ hồ, chống trùng, grant chia sẻ; bộ phân tích Bluetooth 0x2A35 | OMRON, Withings, adapter được duyệt, thẩm định y tế |
| 09 Le‑ORION | Loại tác vụ `robot.simulate` qua chuỗi plan | `/v2/sim/runs` chỉ cho danh tính lab, biên nhận SIMULATED, chặn phát lại sang đích ngoài lab | Robot thật (G3, LeHR) |
| 10 Hạ tầng | — | — | BOM, FAT, GPU (LNH-D24) |
| 11 Dữ liệu, khôi phục | Sổ thu hồi, khôi phục 5 bước, xóa và xuất | Hook riêng tư và thu hồi cho mô-đun mới; dọn theo hạn | Ma trận lưu giữ G0 (LNH-Q20) |
| 12 API mở rộng | Hợp đồng V1.1 | Route `/v2` đề xuất của §12 trong mảnh OpenAPI theo mô-đun | Pin OpenAPI V2 (LNH-Q17) |
| 13 Đo lường | Số đo KPI tối thiểu | — | Telemetry, cohort, D7/D28 |
| 14 Ca X01–X12 | — | Kiểm thử tham chiếu cho X01–X10 và một phần X11, X12 (mục 6) | Chạy trên đích |
| 15 Lộ trình, ngân sách | — | — | Quyết định của CEO LeDB |

## 4. Quyết định cài trong 1.0.1

| Mã | Quyết định |
|---|---|
| LNH-T60 | Mọi route mới của V2.0 nằm dưới `/v2/` như §12, đi cùng đường xác thực, workspace, giới hạn tốc độ, Idempotency-Key và schema đóng như `/v1/`. Workspace và chủ thể luôn lấy từ phiên. |
| LNH-T61 | Năm mô-đun mới có cờ riêng, **tắt khi chưa đặt** (như LNH-F27); chỉ dữ liệu mẫu của chế độ dev bật sẵn. Từ vựng mới của Authority vào migration 0005: mục đích `inbox_mail`, `home_hub`, `measurements`; quyền `inbox.connect`, `home.hub`, `measurements.record`, `sim.run`. |
| LNH-T62 | Bản tóm tắt buổi sáng dựng trên thiết bị từ dữ liệu thiết bị đã có, chạy được khi mất mạng hay AI dừng (X11), phân biệt có dữ liệu, thiếu dữ liệu, nguồn chưa sẵn sàng, quyền đã rút; không số liệu sức khỏe nào rời thiết bị. |
| LNH-T63 | Bản nháp đồng bộ theo revision; ghi đè âm thầm bị cấm: sửa trên bản cũ nhận 409 kèm bản mới nhất để người dùng chọn (X01). Hàng đợi ngoại tuyến chỉ chứa thao tác sửa nháp; xác nhận tác vụ thật vẫn cần phiên trực tuyến. |
| LNH-T64 | Phiên thiết bị: mỗi máy đăng ký phiên riêng, chỉ lưu loại máy người dùng chọn; thu hồi một phiên chặn mọi yêu cầu `/v2` của phiên đó và màn hình chỉ báo trung tính, không hiện nội dung (X02). |
| LNH-T65 | Hộp tổng hợp chỉ giữ phần người dùng chọn và trường `Mail.ReadBasic` cho phép (tiêu đề, người gửi, thời điểm, liên kết đã kiểm); mục mất quyền nguồn thì biến khỏi danh sách (X03); tiêu đề và nội dung chia sẻ chỉ là dữ liệu (X04). «Tạo việc cá nhân» và «Soạn phản hồi» chỉ tạo bản nháp. |
| LNH-T66 | Le‑NodeHome: hub gửi sự kiện tối thiểu bằng danh tính hub, không ảnh, video, âm thanh, khuôn mặt hay danh tính người; chống trùng theo hub, camera, epoch, event_id (X05); đổi hub tăng `binding_version` và chặn binding cũ (X07); quyền truy cập tính từ trạng thái ở máy chủ. Xem clip từ xa chưa cài. |
| LNH-T67 | Le‑NodeHealth: phép đo chỉ vào qua adapter được duyệt; gán người đo theo xác nhận của chính người đó; mơ hồ thì cách ly, không suy đoán (X08); grant chia sẻ có mục đích, phạm vi, hạn, thu hồi, và grant cũ không mở dữ liệu mới (X09). Chỉ hiển thị nhật ký và xu hướng; không chẩn đoán, không cảnh báo y tế tự động. |
| LNH-T68 | Cổng mô phỏng: chỉ danh tính lab gọi được; biên nhận luôn SIMULATED và không nâng mức xác minh của sự kiện vật lý; biên nhận lab bị từ chối ở mọi đích ngoài lab (X10). |
| LNH-T69 | Năm phong cách Quỹ đạo, Không gian đêm, Nhịp an, Dòng thời gian, Titanium là cấu hình hiển thị (§03): mọi màn hình mới dùng token của theme và cùng hợp đồng quyền, trạng thái. |

## 5. Câu hỏi cần quyết

| Mã | Câu hỏi | Người quyết |
|---|---|---|
| LNH-Q16 | Nhắn tin 1:1, chia sẻ mạng xã hội, thiết bị theo dõi và 12 ngôn ngữ ngoài tiếng Việt của 1.0.0 thuộc cổng nào của V2.0, hay giữ tắt tới sau beta? | Product Owner, CEO LeDB |
| LNH-Q17 | OpenAPI V2: lỗi schema là 422 (V2.0 §12) hay 400 như V1.1? Một mã cho cả hai namespace hay khác nhau? | Tech Lead |
| LNH-Q18 | Gộp phiên thiết bị (`/v2/devices`) với điểm nhận tin của nhắn tin thành một danh sách, hay giữ hai? | Tech Lead, Product Owner |
| LNH-Q19 | Vai LeLS trong IAM của LeNhip (khảo sát, lắp, vận hành hub) là vai riêng hay vai vận hành hiện có? Ai cấp? | CEO LeDB, LeLS |
| LNH-Q20 | Ma trận lưu giữ cho mục Hộp tổng hợp, sự kiện Home, phép đo, bản nháp, phiên (V2.0 §11 nói là quyết định G0). | CLO |
| LNH-Q21 | Được lưu phép đo huyết áp ở máy chủ trong pilot G1‑P không, với mục đích và thông điệp nào? | CLO, chuyên gia y tế |

## 6. Ca kiểm thử X01–X12

Mọi ca đều **chưa chạy trên đích**. Cột «Kiểm thử tham chiếu» là kiểm thử trong repo, chạy với dữ liệu tổng hợp và thành phần giả lập.

| Ca | Kiểm thử tham chiếu |
|---|---|
| X01 | `tests/sync.test.ts`, `scripts/e2e-sync.mjs` |
| X02 | `tests/sync.test.ts`, `scripts/e2e-sync.mjs` |
| X03 | `tests/inbox.test.ts`, `scripts/e2e-inbox.mjs` |
| X04 | `tests/inbox.test.ts`, `scripts/e2e-inbox.mjs` |
| X05 | `tests/homehub.test.ts` |
| X06 | Một phần: quyền xem tạm thời và hạn dùng (`tests/homehub.test.ts`); xem clip từ xa chưa cài |
| X07 | `tests/homehub.test.ts` |
| X08 | `tests/measurements.test.ts` |
| X09 | `tests/measurements.test.ts` |
| X10 | `tests/sim.test.ts` |
| X11 | Một phần: tóm tắt và nháp chạy khi máy chủ không trả lời (`scripts/e2e-sync.mjs`); tải GPU không có trong repo |
| X12 | Một phần: khôi phục 5 bước và sổ thu hồi của 1.0.0 (`tests/recovery.test.ts`); chưa diễn tập trên đích |

## 7. Việc còn lại

| Mã | Việc |
|---|---|
| LNH-D21 | Cờ theo tenant, nhóm thử, loại thiết bị và chức năng như V2.0 §01; biên bản mở từng cổng. |
| LNH-D22 | Microsoft Graph thật cho Hộp tổng hợp (`Mail.ReadBasic`, tenant thử, kho bí mật cho token), Share Extension iOS và share target Android. |
| LNH-D23 | Hub Le‑NodeHome thật: danh tính, kết nối ra ngoài có xác thực, cập nhật có chữ ký; nghiệm thu từng SKU camera với LeLS. |
| LNH-D24 | Hạ tầng hai LeLe theo §10: BOM, FAT, đo TTFT và tốc độ sinh, phương án một GPU. |
| LNH-D25 | Adapter phép đo được duyệt (OMRON HEM‑7361T hoặc Withings) sau thử lab, hồ sơ lưu hành và quyền API. |
| LNH-D26 | Pin OpenAPI và schema V2, đưa ca X01–X12 vào biên bản thử trên đích. |

## 8. Chỗ lệch đã biết của bản 1.0.1

| Chỗ lệch | Lý do và việc tiếp theo |
|---|---|
| Thu hồi một phiên thiết bị chỉ chặn các route `/v2`, chưa chặn route `/v1` của lõi. | Token đăng nhập của bản chạy thử dùng chung cho mọi thẻ của một trình duyệt và chưa gắn với phiên. Cần IAM cấp token theo phiên (LNH-Q18). |
| Phiên thiết bị đọc từ tham số truy vấn `device` cùng header `X-LeNhip-Device`. | `Call` của router chưa mang header; thiết bị gửi cả hai. |
| Vận hành LeLS của Le‑NodeHome dùng vai `SITE_OPERATOR` có sẵn. | Lõi chưa có vai riêng của LeLS (LNH-Q19). Người vận hành không làm bước nào trên đăng ký của chính mình. |
| Bản cách ly phép đo giữ giá trị tối đa 30 ngày rồi hết hạn và xóa giá trị; chỉ ứng viên thấy siêu dữ liệu. | V2.0 chưa có ma trận lưu giữ (LNH-Q20); con số 30 ngày là giả định của bản tham chiếu. |
| Phép đo huyết áp lưu ở máy chủ khi cờ `measurements`, đồng ý và quyền đều bật. | Ngoại lệ duy nhất cho LNH-T52, chỉ với dữ liệu tổng hợp; dữ liệu thật chờ LNH-Q21. |
| Bản dịch các phần mới của 1.0.1 (11 ngôn ngữ ngoài tiếng Việt và tiếng Anh) là bản dịch máy. | Điểm cần người bản ngữ rà soát: `docs/BAN_DICH_V1_0_0.md` mục «Phần mới của 1.0.1». |
