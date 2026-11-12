# LeNhip

LeNhip là ứng dụng trợ lý cá nhân của LeDB. Ba mô-đun theo đặc tả:

- **Sức khỏe**: tóm tắt bước chân và giấc ngủ, tính trên thiết bị.
- **Lịch**: dành khung giờ riêng trong lịch Microsoft 365 công việc.
- **Ngôi nhà**: bật/tắt đèn đã đăng ký tại site.

Bản 1.0.0 thêm, theo yêu cầu của chủ sản phẩm ngày 11/11/2026:

- **Tin nhắn**: nhắn tin 1:1 giữa người dùng, mã hóa đầu cuối.
- **Kết nối**: chia sẻ lên mạng xã hội từ thiết bị, «Thiết bị của tôi», thiết bị theo dõi cá nhân.
- 13 ngôn ngữ giao diện, logo và icon mới, cài được như một ứng dụng trên điện thoại, máy tính bảng và máy tính.

LeLe là engine đề xuất dùng chung; LeASO cung cấp IAM.

Repo này là **bản tham chiếu 1.0.1** theo *Đặc tả kỹ thuật LeNhip* LNH-SRS-002 V2.0 (12/11/2026) và LNH-SRS-001 V1.1 (11/11/2026,
gói hợp đồng vẫn áp cho API đã phát hành), gói giao diện 5 phương án V1.0, bản thiết kế `docs/THIET_KE_V1_0_0.md` và bản rà soát
`docs/RA_SOAT_LENHIP_V2_0.md`. **1.0.1 là số phiên bản của mã tham chiếu, không phải bản phát hành:**

- chưa có app iOS/Android;
- chưa kết nối thiết bị, lịch Microsoft 365, IAM hay nền tảng mạng xã hội thật;
- chưa cổng G0–G3 nào đóng, chưa ca nghiệm thu T01–T22 nào chạy trên đích;
- Tin nhắn, Kết nối và máy tính nằm ngoài SRS V1.1 và cần phụ lục SRS V1.2 (LNH-F20); ba cờ `messaging`, `social`, `trackers` mặc định tắt.

## Có gì mới ở 1.0.1 (theo Đặc tả V2.0)

Mọi phần dưới đây là mã tham chiếu dưới namespace `/v2/` (V2.0 mục 12), mỗi phần có cờ riêng **tắt khi chưa đặt**; chế độ dev bật
sẵn. Năm phong cách Quỹ đạo, Không gian đêm, Nhịp an, Dòng thời gian, Titanium áp cho mọi màn hình mới.

| Phần | Đã có | Giả lập hoặc chưa có |
|---|---|---|
| Bản tóm tắt buổi sáng (G1‑H) | Thẻ đầu «Hôm nay» dựng trên thiết bị: giấc ngủ, bước chân, lịch hôm nay, tin chưa đọc, bản nháp, Hộp tổng hợp, Le‑NodeHome; phân biệt có dữ liệu, thiếu dữ liệu, nguồn chưa sẵn sàng, quyền đã rút; chạy khi mất mạng. | App iOS/Android chưa có. |
| Đồng bộ bản nháp, phiên thiết bị (G1‑S, cờ `sync`) | `/v2/sync/drafts` với revision và 409 khi sửa trên bản cũ (X01); hàng đợi ngoại tuyến; `/v2/devices` liệt kê và thu hồi phiên; phiên bị thu hồi thấy màn hình trung tính (X02). | Token đăng nhập chưa gắn với phiên, nên thu hồi chỉ chặn được `/v2`. Không có app đồng hồ. |
| Hộp tổng hợp (G1‑I, cờ `inbox`) | Nhập nội dung chọn chia sẻ hoặc dán; danh sách theo cursor; Lưu, Để sau, Xong, Tạo việc cá nhân, Soạn phản hồi (chỉ tạo bản nháp); mục mất quyền nguồn biến mất (X03); tiêu đề thư chỉ là dữ liệu (X04); nhận chia sẻ từ hệ điều hành khi cài như ứng dụng. | Nguồn Outlook `Mail.ReadBasic` là **giả lập**; chưa có Microsoft Graph thật. |
| Le‑NodeHome và HaaS (G1‑E/Home, cờ `home_hub`) | Đăng ký gói và vòng đời REQUESTED → SURVEYED → ACCEPTED → INSTALLED → ACTIVE, SUSPENDED, TERMINATED, RETURNED; sự kiện tối thiểu từ hub, chống trùng, sự kiện trễ (X05); đổi hub chặn binding cũ (X07); quyền xem tạm thời cho LeLS. | Hub, camera, danh tính hub và việc hiện trường của LeLS là **giả lập**; không có hình, video hay xem clip từ xa. Giá thử chỉ là giả định. |
| Le‑NodeHealth phép đo (G1‑P, cờ `measurements`) | Phép đo huyết áp theo hợp đồng N20‑MEAS; gán người đo theo xác nhận; mơ hồ thì cách ly (X08); chống trùng hai kênh; chia sẻ có hạn và thu hồi (X09); nhật ký và xu hướng; bộ phân tích Bluetooth 0x2A35. | Adapter và máy đo là **giả lập**; chưa tích hợp OMRON hay Withings; không chẩn đoán, không cảnh báo y tế. Dữ liệu thật cần CLO và chuyên gia y tế duyệt. |
| Cổng mô phỏng Le‑ORION (cờ `sim`) | `/v2/sim/runs` chỉ cho danh tính lab; biên nhận SIMULATED; biên nhận lab bị từ chối ở đích khác (X10). | Robot thật thuộc đề án riêng của LeHR (G3). |

Đối chiếu đầy đủ từng mục của V2.0, các ca X01–X12 và câu hỏi cần quyết: `docs/RA_SOAT_LENHIP_V2_0.md`.

## Có gì ở 1.0.0

| Yêu cầu | Đã có trong mã | Giới hạn phải biết |
|---|---|---|
| 1. Logo và icon | Chữ LeNhip L01 «Quỹ đạo» và icon I01 «Tim quỹ đạo» từ gói nhận diện. Icon ứng dụng luôn là I01; chữ LeNhip đổi theo phong cách (L01–L05) để đọc được trên nền tối. | Không dùng logo của bên thứ ba. Icon hình tim không kèm tuyên bố về sức khỏe tim mạch. |
| 2. Ngôn ngữ | 13 ngôn ngữ: Việt (gốc), Anh, Pháp, Trung giản thể, Hàn, Nhật, Tây Ban Nha, Bồ Đào Nha (Brazil), Ý; đề xuất thêm: Trung phồn thể, Indonesia, Nga, Đức. Máy chủ không biết ngôn ngữ của người dùng. Bộ lọc của LeLe chặn câu về sức khỏe ở cả 13 ngôn ngữ. | **Mọi bản ngoài tiếng Việt là bản dịch máy, chưa người bản ngữ rà soát**; giao diện ghi rõ điều đó. Văn bản đồng ý của từng ngôn ngữ chưa được CLO duyệt. |
| 3. Mạng xã hội | Chia sẻ từ thiết bị: bảng chia sẻ của hệ điều hành, liên kết trực tiếp tới Threads, X, Telegram, LINE, Bluesky, sao chép, email. Danh mục 34 nền tảng kèm cách tiếp cận và mức bằng chứng. | **Chưa liên kết tài khoản và chưa đăng qua API** (mới có thiết kế, LNH-T42 đến LNH-T44): LeDB chưa đăng ký ứng dụng với nền tảng nào. Chưa mở được tài liệu chính thức của các nền tảng trong lúc làm; 29 nền tảng còn lại ở trạng thái chưa bật. |
| 4. Nhắn tin | Hội thoại 1:1 trong cùng workspace, mời và chấp nhận trước khi nhắn, chặn, báo cáo không kèm nội dung. Mã hóa đầu cuối `LNH-MSG-1`; máy chủ chỉ giữ bản mã, tối đa 30 ngày. Hộp gửi không tự gửi lại. | Chỉ văn bản; chưa có nhóm, tệp đính kèm, thông báo đẩy. Thiết bị mới không có lịch sử cũ. Phân loại pháp lý của dịch vụ nhắn tin chưa có (LNH-Q12). |
| 5. Máy tính, máy tính bảng, thiết bị theo dõi | Cài được như ứng dụng (manifest, icon); bố cục cho điện thoại, máy tính bảng, máy tính xách tay, máy tính để bàn. «Thiết bị của tôi»: tối đa 5 máy mỗi người, gỡ được từ xa. Nhịp tim và pin trực tiếp qua Bluetooth chuẩn; nhập tệp xuất Apple Health, Samsung Health, Garmin, phân tích ngay trên thiết bị. | Chưa có service worker: cần mạng. Bluetooth chỉ chạy trên Chrome, Edge, Samsung Internet. Không nền tảng hay hãng nào được gọi qua cloud. **Dữ liệu sức khỏe không đồng bộ giữa các máy**; dữ liệu nhập từ tệp chỉ nằm trong bộ nhớ của trang đang mở. |

## Cấu trúc

| Phần | Nội dung |
|---|---|
| `contracts/` | Hợp đồng dùng chung cho máy chủ, iOS và Android: OpenAPI 3.1 (`openapi.json` và mảnh theo mô-đun trong `openapi/`), bảng chuyển trạng thái (`state_transitions.csv`: 33 cạnh của máy tác vụ, 10 cạnh `THREAD_*` của hội thoại), fixture LNH-SLEEP-1 S01–S16, vector JCS, fixture `LNH-MSG-1`, fixture tệp xuất tổng hợp, sổ ghim văn bản đồng ý (`consent-texts.json`), ma trận truy vết (`traceability.json`). |
| `web/shared/` | Mã chạy được cả trên trình duyệt lẫn Node: LNH-SLEEP-1, JCS, múi giờ, runtime ngôn ngữ (`i18n.js`) và catalog (`i18n-<ngôn ngữ>[-msg\|-social\|-dev].js`), bảng từ của LeLe (`lele-lexicon.js`, `lele-lex-<ngôn ngữ>.js`), mật mã và hộp gửi của nhắn tin (`msg-*.js`), danh mục mạng xã hội và thẻ chia sẻ, danh mục thiết bị theo dõi, bộ phân tích Bluetooth và tệp xuất, chữ LeNhip (`brand.js`), chữ LeLe. |
| `web/views/` | Sổ đăng ký màn hình (`index.js`) và các màn hình mới: Tin nhắn, Kết nối với ba phần (mạng xã hội, thiết bị của tôi, thiết bị theo dõi). |
| `web/` | Giao diện web 5 phong cách, nối API; `manifest.json` và `icons/` cho bản cài đặt. |
| `src/server/` | Máy chủ tham chiếu (bảng dưới). `modules.ts` là sổ đăng ký mô-đun; `messaging.ts` là mô-đun nhắn tin; `migrations/` chứa migration từ 0002. |
| `src/adapters/` | Adapter lịch (Microsoft Graph giả lập), gateway site (Home Assistant/Matter giả lập), robot mô phỏng. |
| `tests/` | Kiểm thử node:test. |
| `scripts/` | Kiểm hợp đồng, sinh fixture, sinh sổ ghim văn bản đồng ý, kiểm trình duyệt (`e2e*.mjs`). |
| `docs/` | `RA_SOAT_LENHIP_V2_0.md` (rà soát Đặc tả V2.0: phát hiện từ LNH-F30, quyết định từ LNH-T60, câu hỏi từ LNH-Q16, việc từ LNH-D21, ca X01–X12), `BAN_DICH_V1_0_0.md` (tình trạng 12 bản dịch và các điểm cần người bản ngữ rà soát), `THIET_KE_V1_0_0.md` (thiết kế 1.0.0: phát hiện LNH-F20 trở đi, quyết định LNH-T20 trở đi, câu hỏi LNH-Q08 trở đi, việc LNH-D13 trở đi), `RA_SOAT_LENHIP_V1_1.md` (rà soát SRS V1.1), `source/` (đặc tả V1.1 và V2.0, gói giao diện, gói logo; giữ nguyên byte). |

Các thành phần của `src/server/`:

| Thành phần | Nội dung |
|---|---|
| Authority | Thành viên, quyền, đồng ý, chính sách xuất, binding, snapshot phiên bản |
| Plan và phê duyệt | Hạn duyệt 120 giây |
| Máy trạng thái | Theo sự kiện, đọc bảng từ CSV; mỗi máy một tiền tố trạng thái |
| Idempotency | Giữ phát lại 90 ngày (30 ngày với `/v1/messages/*`) |
| Permit LNH-PERMIT-1 | JWS ES256, kiểm tại receiver ở điểm ra I/O |
| Barrier và control store | Barrier độc lập ghi trước I/O; control store giữ recovery_epoch và cờ mô-đun |
| Đối soát | Reconciler và SLA của UNKNOWN |
| Khôi phục | Quy trình 5 bước, nạp lại sổ thu hồi của lõi và của mô-đun |
| Nhắn tin | Hộp thư bản mã, thiết bị, hội thoại, biên nhận, báo cáo, dọn sau 30 ngày |
| Khác | Quyền chủ thể dữ liệu, Model Gateway của LeLe với bộ lọc 13 ngôn ngữ, API /v1 |

## Chạy thử

Cần Node 22.18 trở lên (chạy TypeScript trực tiếp, `node:sqlite`). Không cần build.

```bash
npm ci
npm run dev        # http://127.0.0.1:8787 — issuer phát triển, ba tài khoản thử, lịch và đèn giả lập
```

- Bản chạy thử chỉ nghe trên localhost và bật sẵn tám cờ opt-in: `messaging`, `social`, `trackers` của 1.0.0 và `inbox`, `sync`, `home_hub`, `measurements`, `sim` của 1.0.1. Ngoài chế độ dev các cờ này tắt cho tới khi vận hành viên bật bằng `POST /v1/ops/flags`.
- Lần đầu mở có *Thông báo đầu tiên* với bốn mục đích, mặc định để trống. Tin nhắn hỏi đồng ý riêng khi mở lần đầu.
- Nút avatar đổi giữa các tài khoản thử: Thử nghiệm A, Thử nghiệm B, Vận hành LeDB. Để thử nhắn tin, mở hai trình duyệt (hoặc một cửa sổ ẩn danh) với hai tài khoản.
- Ngôn ngữ chọn ở *Cá nhân hóa*; mặc định theo trình duyệt, không khớp ngôn ngữ nào thì dùng tiếng Anh.

Chạy với IAM thật:

```bash
LENHIP_OIDC_ISSUER=… LENHIP_OIDC_AUDIENCE=lenhip-api LENHIP_OIDC_JWKS_FILE=jwks.json npm start
```

Bản này chưa có adapter Graph và Matter thật (LNH-D07), nên lịch và đèn vẫn đi qua adapter giả lập.

## Kiểm tra

```bash
npm run typecheck   # tsc --noEmit, gồm cả mã JS dùng chung (checkJs)
npm test            # máy chủ, hợp đồng, giấc ngủ, ngôn ngữ, bộ lọc LeLe, mật mã và hộp thư nhắn tin, Bluetooth, tệp xuất, chia sẻ
npm run check       # OpenAPI ↔ route, bảng trạng thái ↔ mã, fixture, truy vết, mã băm tài liệu nguồn, mã LNH có định nghĩa
npm run e2e         # trình duyệt thật (Playwright có sẵn): hành trình chính, ngôn ngữ, khung giao diện, mạng xã hội, nhắn tin, thiết bị theo dõi
```

- `npm run fixtures` sinh lại fixture giấc ngủ. Chỉ chạy khi đổi fixture có chủ đích; đổi thuật toán thì phải đổi `algorithm_version`.
- `node scripts/make-consent-texts.ts` sinh lại sổ ghim văn bản đồng ý sau khi đổi phiên bản một văn bản.
- Kiểm riêng một ngôn ngữ: `LENHIP_I18N_ONLY=<tag> node --test tests/i18n.test.ts tests/i18n-runtime.test.ts tests/lele-i18n.test.ts`.

## Nguyên tắc của bản tham chiếu

- **Sức khỏe không rời thiết bị.** Máy chủ từ chối mọi trường nguồn sức khỏe (`additionalProperties=false`) và từ chối đồng ý `health_local`. Máy chủ không có route, bảng hay trường nào về thiết bị theo dõi. Dữ liệu sức khỏe không đồng bộ giữa các máy của cùng một người.
- **Không có thao tác giả.** Lịch và đèn chỉ đổi qua chuỗi: plan → xem lại nội dung đã chuẩn hóa → xác nhận trong 120 giây → permit → receiver → bằng chứng. Kết quả hiển thị theo bằng chứng. Sau khi mở cửa sổ chia sẻ của một nền tảng, LeNhip nói rõ là không biết người dùng đã đăng hay chưa.
- **Thời gian trôi qua không phải bằng chứng.** UNKNOWN không bao giờ tự thành FAILED; không POST nào được tự gửi lại, kể cả tin nhắn: tin mất phản hồi ở trạng thái «Chưa rõ đã gửi hay chưa» cho tới khi có bằng chứng hoặc người dùng bấm thử lại với đúng các byte cũ.
- **Máy chủ không đọc được tin nhắn.** Nội dung được mã hóa trên thiết bị cho từng thiết bị nhận; máy chủ chỉ giữ bản mã và xóa khi thiết bị nhận xác nhận đã lưu. Giới hạn: máy chủ phát mã nguồn web, nên mã hóa đầu cuối chặn việc đọc, không chặn người vận hành sửa mã.
- **LeLe chỉ đề xuất** và không có đường nào tới nội dung tin nhắn. Câu gõ cho LeLe chỉ rời thiết bị khi quy tắc cục bộ nhận ra lệnh đèn hoặc lịch và không có từ về sức khỏe hay dữ liệu cá nhân của bất kỳ ngôn ngữ nào; máy chủ kiểm lại. Chưa có mô hình AI nào được duyệt.
- **Máy chủ không biết ngôn ngữ của người dùng.** Lỗi và câu trả lời đi bằng mã; thiết bị dựng câu. Không văn bản đã dịch nào vào payload hay digest.
- **Không có dữ liệu người thật trong repo.** Tài khoản, site, đèn và tệp xuất mẫu đều là dữ liệu tổng hợp.

## Nhắn tin

Cổng: cờ `messaging`, quyền `messaging.use`, đồng ý `messaging`. 16 thao tác dưới `/v1/messages/*` và `GET /v1/ops/messages/reports` cho quản trị viên workspace.

| Giới hạn | Giá trị |
|---|---|
| Thiết bị mỗi người | 5; đăng ký cần đăng nhập mới trong 300 giây |
| Lời mời đang mở | 10 |
| Gửi | 30 tin một phút, 500 tin một ngày; mỗi tin tối đa 2.000 ký tự |
| Báo cáo | 20 một ngày, không kèm nội dung |
| Lưu giữ | Máy chủ: tới khi thiết bị nhận xác nhận, muộn nhất 30 ngày. Thiết bị: 30 ngày |
| Thử lại một tin chưa rõ | Trong 7 ngày, với đúng các byte cũ |
| Thăm dò | 3 giây khi mở hội thoại, 15 giây khi không, dừng khi ẩn tab, lùi tới 60 giây sau lỗi 429 |

## Chữ LeNhip và chữ LeLe

- Chữ LeNhip và icon lấy nguyên từ gói `docs/source/LeNhip_05_Logo_05_Icon.zip`; `tests/brand.test.ts` so từng nét và màu với gói và kiểm tương phản tối thiểu 3:1 trên từng phong cách. Mã ở `web/shared/brand.js`, icon ở `web/icon.svg` và `web/icons/`.
- Chữ LeLe dùng hình đã chốt ở LeASO–LHLC Web 1.0.7: chữ "Le" vẽ theo ảnh mẫu, không phải phông. Mã ở `web/shared/lele-mark.js`.

## Thật, giả lập, chưa kiểm

| | |
|---|---|
| **Thật, có kiểm thử** | Logo và icon; runtime ngôn ngữ và 13 catalog (kiểm cấu trúc); bộ lọc LeLe đa ngôn ngữ; chia sẻ từ thiết bị và trình dựng liên kết; mật mã `LNH-MSG-1` theo vector công bố; hộp thư, hội thoại, hộp gửi; đăng ký thiết bị; bộ phân tích Bluetooth và tệp xuất; bố cục bốn cỡ màn hình trên Chromium. |
| **Giả lập** | Người dùng và «thiết bị» trong kiểm thử (tài khoản dev, nhiều ngữ cảnh trình duyệt trên một máy); Bluetooth trong kiểm trình duyệt (đối tượng thay thế `navigator.bluetooth`); tệp xuất mẫu; dữ liệu sức khỏe tổng hợp; Graph, Matter, IAM như ở 0.1.0. |
| **Bản nháp** | Mọi bản dịch ngoài tiếng Việt và bảng từ của LeLe: dịch máy, chưa ai rà soát, chưa CLO hay chuyên gia y tế duyệt. |
| **Chưa kiểm được ở đây** | Mọi nền tảng mạng xã hội thật; thiết bị Bluetooth thật; tệp xuất thật của hãng; Safari, Firefox, iOS, Android; trình đọc màn hình; cài đặt PWA thật; phân loại pháp lý; ca T01–T22 trên đích. |

## Việc còn lại trước beta

Danh sách đầy đủ ở `docs/RA_SOAT_LENHIP_V1_1.md` mục 5 (LNH-D01 đến LNH-D12), `docs/THIET_KE_V1_0_0.md` mục 4 và 5 (LNH-Q08 đến LNH-Q15, LNH-D13 đến LNH-D20) và `contracts/traceability.json`. Các việc chính:

- Phụ lục SRS V1.2 cho Tin nhắn, Kết nối và loại máy web; quyết định pháp lý về nhắn tin và mã hóa đầu cuối.
- Người bản ngữ rà soát 12 bản dịch; CLO duyệt văn bản đồng ý từng ngôn ngữ.
- Liên kết tài khoản và đăng qua API với nền tảng mạng xã hội (cần đăng ký ứng dụng).
- App iOS/Android với HealthSource; thỏa thuận với hãng thiết bị theo dõi.
- PostgreSQL synchronous replication, kho barrier độc lập, KMS và mTLS, adapter Graph và Matter thật.
- Hồ sơ pháp lý G0 và chạy T01–T22 trên đích.
