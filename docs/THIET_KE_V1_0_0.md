# Thiết kế LeNhip V1.0.0

Ngày 11/11/2026. Tài liệu này chốt thiết kế cho năm yêu cầu của chủ sản phẩm đối với bản 1.0.0 và ghi rõ phần nào
là thật, phần nào là giả lập, phần nào chưa kiểm được. Bản rà soát SRS V1.1 vẫn ở `docs/RA_SOAT_LENHIP_V1_1.md`;
các mã `LNH-…` mới (từ F20, T20, Q08, D13) định nghĩa ở đây.

## 1. Kết luận

- **1.0.0 là số phiên bản của mã tham chiếu, không phải bản phát hành.** Chưa cổng G0–G3 nào đóng, chưa ca T01–T22 nào
  chạy trên môi trường đích, chưa có app iOS/Android, chưa nhà cung cấp nào được duyệt.
- Yêu cầu 1 (logo, icon) không mâu thuẫn SRS. Yêu cầu 2 (ngôn ngữ) nằm ngoài phạm vi «hỗ trợ tiếng Việt» của §04 nhưng
  không bị cấm. Yêu cầu 3, 4, 5 là mô-đun và loại máy mới: **cần SRS V1.2** (LNH-F20). Vì vậy mỗi phần mới có cờ riêng,
  **mặc định tắt**; chỉ dữ liệu mẫu ở chế độ dev bật sẵn.
- «Tất cả mạng xã hội» và «tất cả thiết bị theo dõi» không làm thật được từ một bản web tham chiếu (LNH-F21, LNH-F22).
  Bản này dựng khung, danh mục có ghi mức bằng chứng, đường dùng được ngay không cần thỏa thuận, và bộ giả lập cho phần
  cần đăng ký. Không chỗ nào giả vờ đã kết nối.
- Chín nguyên tắc của 0.1.0 giữ nguyên: dữ liệu sức khỏe không rời thiết bị; thay đổi ra ngoài đi kế hoạch → xem lại →
  đồng ý trong 120 giây → giấy phép → receiver → bằng chứng; UNKNOWN không tự thành FAILED, không tự gửi lại POST;
  mọi POST có Idempotency-Key; LeLe chỉ đề xuất; không phụ thuộc runtime.

## 2. Phát hiện khi rà yêu cầu

| Mã | Mức | Nội dung |
|---|---|---|
| LNH-F20 | Cao | SRS V1.1 cố định một app, ba mô-đun (Sức khỏe, Lịch, Nhà), iOS và Android. Mạng xã hội, Nhắn tin là mô-đun mới; web, máy tính, máy tính bảng là loại máy mới. §29: «một cổng mở không tự mở cổng khác». Cần phụ lục SRS V1.2 và cổng riêng. |
| LNH-F21 | Cao | Không nền tảng lớn nào cho bên thứ ba đăng bài hay nhắn tin giữa người dùng mà không đăng ký ứng dụng; đa số cần khóa giữ ở máy chủ và thẩm định. Facebook không còn API đăng lên trang cá nhân. LeDB chưa có ứng dụng nào đăng ký. |
| LNH-F22 | Cao | HealthKit và Health Connect không có API mạng; cloud của hãng cần client đăng ký và thẩm định. Qua Bluetooth chuẩn, vòng đeo chỉ phát nhịp tim trực tiếp, không phát bước chân hay giấc ngủ. Web Bluetooth chỉ có trên Chromium, không có trên Safari, Firefox và mọi trình duyệt iOS. |
| LNH-F23 | Cao | §05, §06, §11: dữ liệu sức khỏe ở trên điện thoại, không ghi máy chủ, tắt sao lưu đám mây và chuyển app. Hiện dữ liệu sức khỏe trên máy tính hay đồng bộ giữa các máy đều trái các mục này. |
| LNH-F24 | Cao | Lỗi có sẵn ở 0.1.0: bộ lọc sức khỏe của LeLe chỉ bắt từ khóa tiếng Việt dựng sẵn. Câu tiếng Việt tổ hợp (NFD), tiếng Anh, Pháp, Nhật về sức khỏe đã tới `/v1/lele/proposals` trong phép thử trình duyệt. Dịch ứng dụng mà không sửa thì câu «Câu hỏi về sức khỏe không rời thiết bị» là sai. |
| LNH-F25 | Trung bình | Chữ L01 màu `#12394A` có tương phản 1,30 trên nền Không gian đêm và 1,06 trên Titanium: không đọc được. Gói logo ghi L02 và L05 dùng chữ sáng cho nền tối. |
| LNH-F26 | Trung bình | Mạng của phiên làm việc chặn trang tài liệu chính thức của các nền tảng. Danh mục dựa trên tóm tắt tìm kiếm; mỗi mục ghi mức bằng chứng. Chỉ đường chia sẻ có mức «tài liệu chính thức qua tìm kiếm» mới bật. |
| LNH-F27 | Trung bình | Ở 0.1.0 một cờ mô-đun thiếu được đọc là bật (`control.ts`). Mô-đun mới phải tắt khi chưa đặt rõ. |
| LNH-F28 | Trung bình | Văn bản đồng ý được băm vào biên nhận; mỗi bản dịch là một văn bản khác, cần phiên bản và mã băm riêng, và CLO duyệt từng ngôn ngữ (§08). |
| LNH-F29 | Thấp | Icon hình tim và khẩu hiệu là tài liệu tiếp thị theo memo MED01 (§10, T20): không kèm tuyên bố về tim mạch hay chẩn đoán. §30 chỉ nói về sáng chế, chưa nói về nhãn hiệu. |

## 3. Quyết định thiết kế

### 3.1 Nhận diện (yêu cầu 1)

| Mã | Quyết định |
|---|---|
| LNH-T20 | Nhận diện chính là **L01 «Quỹ đạo» + I01 «Tim quỹ đạo»**, đúng hai hình chủ sản phẩm gửi và đề xuất trong gói logo. Icon ứng dụng (favicon, màn hình chính, manifest) luôn là I01. Chữ LeNhip trong giao diện đi theo phong cách đang chọn để luôn đọc được: Quỹ đạo L01, Không gian đêm L02, Nhịp an L03, Dòng thời gian L04, Titanium L05. Logo là SVG trong trang, có tên truy cập «LeNhip». Gói logo lưu nguyên ở `docs/source/`, có sha256 trong `contracts/traceability.json`. Không dùng logo của bên thứ ba. |

### 3.2 Ngôn ngữ (yêu cầu 2)

| Mã | Quyết định |
|---|---|
| LNH-T21 | 13 ngôn ngữ. Chín theo yêu cầu: `vi` (gốc), `en`, `fr`, `zh-Hans`, `ko`, `ja`, `es`, `pt-BR`, `it`. Bốn đề xuất thêm, đã cài: `zh-Hant`, `id`, `ru`, `de`. Mọi bản không phải tiếng Việt là **bản dịch máy, chưa người bản ngữ rà soát**; giao diện ghi rõ điều đó và bản tiếng Việt là bản gốc. Để sau, khi có người rà soát: Ả Rập (cần bố cục phải-sang-trái), Thái, Hindi, Mã Lai. |
| LNH-T22 | Runtime `web/shared/i18n.js`, không thư viện. Một thông điệp là chuỗi có `{tên}`, hoặc một đối tượng nhánh số nhiều chọn theo `n` bằng `Intl.PluralRules` của ngôn ngữ catalog. Catalog là mô-đun `web/shared/i18n-<tag>.js` và các phần `i18n-<tag>-<phần>.js` (`msg`, `social`, `dev`), nạp qua bảng `import()` cố định. `t()` trả văn bản thuần; không HTML trong bản dịch. |
| LNH-T23 | Máy chủ không biết ngôn ngữ của người dùng. Lỗi và câu trả lời của LeLe có thêm mã (`detail_code`, `limit`, `answer_code`); thiết bị dựng câu từ mã. `message` tiếng Việt giữ cho client cũ. Không gửi header hay trường ngôn ngữ. |
| LNH-T24 | LeLe: một bảng từ `web/shared/lele-lexicon.js` cho cả 13 ngôn ngữ, dùng chung cho thiết bị và máy chủ. Chuẩn hóa NFC, chữ thường. **Đóng khi không chắc:** thiết bị chỉ gửi khi quy tắc cục bộ nhận ra lệnh đèn hoặc lịch và không có từ sức khỏe hay dữ liệu cá nhân của bất kỳ ngôn ngữ nào; máy chủ kiểm lại. Sửa LNH-F24. |
| LNH-T25 | Văn bản đồng ý theo ngôn ngữ: `text_version` có hậu tố `.<tag>` cho bản dịch; `contracts/consent-texts.json` ghim mã băm của từng văn bản; test chặn sửa văn bản mà không đổi phiên bản. |
| LNH-T26 | Tiêu đề sự kiện lịch vẫn là «Thời gian cá nhân» ở mọi ngôn ngữ: nó nằm trong payload và phép đọc lại. Không văn bản đã dịch nào vào payload hay digest. |
| LNH-T27 | Giờ luôn 24 giờ `HH:MM`. Số, ngày, thứ qua `Intl`. Thời lượng dựng từ `NumberFormat` đơn vị và `ListFormat` (Node 22 chưa có `Intl.DurationFormat`). |
| LNH-T28 | `<html lang dir translate="no">`: không để trình duyệt gửi trang có số liệu sức khỏe cho dịch vụ dịch. Không tải phông; mỗi hệ chữ dùng phông hệ thống. CSS mới dùng thuộc tính logic để sau này thêm ngôn ngữ phải-sang-trái. Ngân sách chiều dài: nhãn 2 lần, đoạn văn 1,5 lần tiếng Việt, ở cỡ chữ 200 %. |
| LNH-T29 | Ngôn ngữ lưu theo thiết bị (`locale` trong thiết lập giao diện), mặc định `auto` theo trình duyệt (`zh-TW` → `zh-Hant`, không bao giờ ra giản thể). Không khớp ngôn ngữ nào thì dùng tiếng Anh. Không đổi ngôn ngữ khi một kế hoạch đang chờ đồng ý. |

### 3.3 Mạng xã hội (yêu cầu 3)

| Mã | Quyết định |
|---|---|
| LNH-T40 | Ranh giới của «tất cả nền tảng»: (a) bảng chia sẻ của hệ điều hành (Web Share API) tới mọi ứng dụng máy đó có; (b) danh mục 34 nền tảng trong `web/shared/social-registry.js`, mỗi mục có khả năng và mức bằng chứng; (c) liên kết chia sẻ trực tiếp chỉ bật cho nền tảng có định dạng được xác nhận: Threads, X, Telegram, LINE, Bluesky; (d) sao chép và email. Các mục còn lại nằm trong danh mục ở trạng thái chưa xác nhận hoặc cần đăng ký. |
| LNH-T41 | Chia sẻ ra diễn ra trên thiết bị, không gọi máy chủ, không lưu lịch sử. Thẻ chia sẻ chỉ gồm ghi chú người dùng tự gõ (tối đa 280 ký tự) và liên kết LeNhip nếu có địa chỉ công khai. Không có ô chọn dữ liệu sức khỏe, lịch hay nhà. Sau khi mở cửa sổ nền tảng: «LeNhip không biết bạn đã đăng hay chưa». |
| LNH-T42 | Liên kết tài khoản: OAuth 2.0 mã ủy quyền + PKCE S256, chuyển hướng cả trang, `state` dùng một lần gắn với người bắt đầu. **Chỉ có nhà cung cấp giả lập `mock`**; `SOCIAL_VENDOR_PROFILES` rỗng nên không nền tảng thật nào liên kết được. Token chỉ ở bộ nhớ adapter, không vào sổ, log, phản hồi hay trình duyệt. |
| LNH-T43 | Đăng qua API là loại hành động `social.post`, đi trọn chuỗi kế hoạch → đồng ý → giấy phép → receiver → bằng chứng. Chỉ đăng **thẻ theo mã** (`card_code`), không văn bản tự do: không chữ nào của người dùng vào máy chủ. ACK 10 giây, UNKNOWN sau 30 giây; đọc lại theo mã bài; không bao giờ tự gửi lại. |
| LNH-T44 | Nhà cung cấp giả lập dùng issuer và gốc tin cậy `sim`; bằng chứng hạng `SIMULATED`, nhãn «mô phỏng» (mở rộng LNH-T19). |
| LNH-T45 | Cổng: cờ `social` (tắt khi chưa đặt), mục đích đồng ý `social_post`, quyền `social.post`. Gỡ liên kết xóa token trước rồi gọi thu hồi một lần; báo đúng nền tảng đã xác nhận hay chưa. Không SDK, widget, pixel hay logo của nền tảng; CSP không đổi. Không đăng nhập bằng mạng xã hội. LeLe không soạn bài. |

### 3.4 Nhắn tin (yêu cầu 4)

| Mã | Quyết định |
|---|---|
| LNH-T30 | «Thiết bị của tôi»: mỗi trình duyệt đã đăng nhập đăng ký một điểm cuối (`/v1/messages/endpoints`) với loại máy do người dùng chọn (điện thoại, máy tính bảng, máy tính xách tay, máy tính để bàn, khác) và khóa công khai. Tối đa 5. Đăng ký cần đăng nhập mới trong 300 giây. Máy chủ không lưu tên máy hay user agent. Gỡ một máy xóa các phong bì đang chờ của nó. Tên «device» của SRS vẫn chỉ đèn tại site. |
| LNH-T31 | Mã hóa đầu cuối `LNH-MSG-1` bằng WebCrypto: nội dung JCS đệm bội số 256 byte, AES-256-GCM; khóa nội dung niêm phong cho từng điểm cuối bằng HPKE chế độ xác thực (DHKEM P-256, HKDF-SHA256, AES-256-GCM). Khóa riêng không xuất được, lưu IndexedDB. Máy chủ chỉ giữ bản mã. Giới hạn nói rõ: máy chủ phát mã nguồn web nên E2EE chặn việc đọc, không chặn người vận hành sửa mã. |
| LNH-T32 | Máy chủ là hộp thư, không phải kho: phong bì bị xóa khi thiết bị nhận xác nhận đã lưu, muộn nhất 30 ngày. Lịch sử nằm trên từng thiết bị (30 ngày). Thiết bị mới chỉ thấy tin gửi sau khi nó được thêm. |
| LNH-T33 | Hội thoại 1:1 giữa hai thành viên cùng workspace, chỉ văn bản tối đa 2.000 ký tự. Phải mời và được chấp nhận trước khi có tin; lời mời không kèm chữ. Chặn, bỏ chặn, báo cáo không kèm nội dung. Trạng thái hội thoại là 10 cạnh `THREAD_*` trong `contracts/state_transitions.csv`. |
| LNH-T34 | Gửi tin không phải một kế hoạch: không có gì ngoài LeNhip thay đổi nên chuỗi giấy phép không áp dụng. Vẫn có Idempotency-Key, `client_ref` duy nhất, và hộp gửi trên thiết bị không tự gửi lại: sau khi mất phản hồi tin ở trạng thái «Chưa rõ đã gửi hay chưa» cho tới khi có bằng chứng hoặc người dùng bấm thử lại với đúng các byte cũ. |
| LNH-T35 | Đồng bộ bằng GET thường (thăm dò 3 giây khi mở hội thoại, 15 giây khi không, dừng khi ẩn tab). Không SSE, không Web Push. Thông báo chỉ là huy hiệu và «Bạn có tin nhắn mới», không tên, không nội dung. Biên nhận theo bằng chứng: máy chủ đã nhận, đã tới thiết bị; «đã xem» chỉ khi người đọc bật chia sẻ. |
| LNH-T36 | Cổng: cờ `messaging` (tắt khi chưa đặt), mục đích đồng ý `messaging`, quyền `messaging.use`. LeLe không có đường nào tới nội dung tin nhắn. Không nút chia sẻ sức khỏe, không tạo kế hoạch từ tin nhắn. Không nhóm, tệp đính kèm, thoại ở bản này. |

### 3.5 Máy tính, máy tính bảng và thiết bị theo dõi (yêu cầu 5)

| Mã | Quyết định |
|---|---|
| LNH-T50 | Ứng dụng cài được (PWA): `manifest.json` với icon I01 192 và 512 px, `display: standalone`. Chưa có service worker: màn hình quyết định không được hiện trạng thái cũ khi mất mạng; ứng dụng cần mạng. |
| LNH-T51 | Bố cục theo bốn cỡ: điện thoại ≤ 700 px, máy tính bảng 701–1180, máy tính xách tay 1181–1499, máy tính để bàn ≥ 1500. Thanh bên cuộn được, nhãn thanh dưới xuống dòng, chữ 200 % không tràn. Điều hướng: Hôm nay, Sức khỏe, Công việc, Ngôi nhà, Tin nhắn; mục «Kết nối» (mạng xã hội, thiết bị của tôi, thiết bị theo dõi) ở thanh bên và trong hộp tài khoản trên điện thoại. |
| LNH-T52 | Dữ liệu sức khỏe ở lại trên thiết bị đã đọc hoặc nhập nó. **Không đồng bộ sức khỏe giữa các máy**, kể cả dạng mã hóa: việc đó cần sửa §05, §06, §11 và thẩm định y tế, pháp lý (LNH-Q11). |
| LNH-T53 | Danh mục thiết bị theo dõi `web/shared/tracker-registry.js` chỉ ở trên thiết bị: hệ sinh thái, đường kết nối khả dĩ (kho sức khỏe của hệ điều hành qua app native, Bluetooth chuẩn, tệp xuất, cloud của hãng), điều kiện và mức bằng chứng. Máy chủ không có API nào về thiết bị theo dõi, không nhận nhãn, mã hay tên thiết bị. Cờ `trackers` tắt khi chưa đặt. |
| LNH-T54 | Bluetooth chuẩn (Web Bluetooth, chỉ Chromium): đọc trực tiếp nhịp tim (0x180D) và pin (0x180F) khi trang đang mở, sau khi người dùng tự chọn thiết bị. Chỉ hiển thị, không lưu, không gửi. Ghi rõ «không phải thiết bị y tế, không dùng để chẩn đoán». Đây là loại dữ liệu ngoài HealthSource v1 (LNH-Q11). |
| LNH-T55 | Nhập tệp xuất của chính người dùng, phân tích trên thiết bị: Apple Health `export.xml` (bước chân, giấc ngủ), Samsung Health CSV bước chân, Garmin JSON giấc ngủ. Kết quả vào đúng dạng dữ liệu của LNH-SLEEP-1; nguồn chỉ có tổng theo giai đoạn mà không có khoảng thời gian thì ra `DURATION_UNKNOWN`, không tự suy thời lượng. Một nguồn giấc ngủ, 7 ngày gần nhất, không gộp nguồn. Dữ liệu đã nhập **chỉ nằm trong bộ nhớ của trang đang mở** (SRS §11: «Samples chỉ trong RAM»): không ghi xuống đĩa của trình duyệt, tải lại hay đóng trang là hết, muốn xem lại thì nhập lại tệp. |
| LNH-T56 | App native vẫn là đường chính tới HealthKit và Health Connect (LNH-D01, LNH-D02). Cloud của hãng (Garmin, Fitbit/Google, Oura, WHOOP, Polar, Withings…) nằm trong danh mục ở trạng thái «cần thỏa thuận», không có mã gọi. |

## 4. Câu hỏi cần quyết

| Mã | Câu hỏi | Người quyết |
|---|---|---|
| LNH-Q08 | Bốn ngôn ngữ đề xuất (Trung phồn thể, Indonesia, Nga, Đức) có giữ không? Ai rà soát từng ngôn ngữ, văn bản đồng ý và câu về sức khỏe? Bản dịch chưa rà soát có được cho người dùng thử thấy không? | Product Owner, CLO |
| LNH-Q09 | Chấp nhận ranh giới LNH-T40 không? Nền tảng thật đầu tiên là gì, đăng ký ứng dụng dưới pháp nhân nào? Liên kết chia sẻ có cần hồ sơ nhà cung cấp cho từng nền tảng không? | CEO LeDB, CLO |
| LNH-Q10 | Chấp nhận mã hóa đầu cuối với cái giá của nó: thiết bị mới không có lịch sử, không kiểm duyệt nội dung, mất máy là mất lịch sử? Nếu không được phép, khuyến nghị là chưa mở nhắn tin thay vì lưu chữ đọc được. | CEO LeDB, CLO |
| LNH-Q11 | Có cho dữ liệu sức khỏe hiện trên máy tính, máy tính bảng không; có cho đọc loại dữ liệu ngoài bước chân và giấc ngủ (nhịp tim trực tiếp) không; có cho bản web giữ dữ liệu đã nhập trên máy tối đa 30 ngày như bộ nhớ đệm tổng hợp của app không? Cần HealthSource v2 và thẩm định y tế, AI. | CLO, chuyên gia y tế |
| LNH-Q12 | Phân loại pháp lý của nhắn tin: thông báo dịch vụ OTT, ranh giới «mạng xã hội», nghĩa vụ an ninh mạng, giấy phép mật mã dân sự cho E2EE, người dưới 16 tuổi. Phiên này không mở được văn bản gốc; các số điều khoản chưa được xác minh. | CLO |
| LNH-Q13 | Địa chỉ công khai của LeNhip để gắn vào thẻ chia sẻ là gì? Hiện chưa có. | Product Owner |
| LNH-Q14 | Ngôn ngữ theo thiết bị (đang cài) hay theo tài khoản? Khi không khớp ngôn ngữ nào: tiếng Anh (đang cài) hay tiếng Việt? | Product Owner |
| LNH-Q15 | Nhắn tin nhóm, tệp đính kèm, lưu quá 30 ngày có cần không? Ai là quản trị viên xử lý báo cáo? | Product Owner |

## 5. Việc còn lại

| Mã | Việc |
|---|---|
| LNH-D13 | Người bản ngữ rà soát 12 bản dịch; chuyên gia rà câu về sức khỏe; chạy T18 (chữ 200 %) và T20 theo từng ngôn ngữ. |
| LNH-D14 | CLO duyệt văn bản đồng ý từng ngôn ngữ và hai mục đích mới (`messaging`, `social_post`). |
| LNH-D15 | Đăng ký ứng dụng với nền tảng thật, kho bí mật cho token, hồ sơ nhà cung cấp; đọc trực tiếp tài liệu chính thức để bật các liên kết chia sẻ còn lại. |
| LNH-D16 | HealthSource v2 trên app native; thỏa thuận với hãng thiết bị; kiểm tệp xuất thật của Apple, Samsung, Garmin, Fitbit, Oura. |
| LNH-D17 | Phụ lục SRS V1.2: mô-đun Kết nối và Nhắn tin, loại máy web, bảng lưu giữ, mô hình đe dọa, ca nghiệm thu mới. |
| LNH-D18 | Service worker, chế độ ngoại tuyến và thông báo đẩy (cần nhà cung cấp và hồ sơ chuyển dữ liệu). |
| LNH-D19 | Kiểm trên Safari, Firefox, iOS, Android, trình đọc màn hình, bộ gõ CJK; hiện chỉ kiểm bằng Chromium. |
| LNH-D20 | Bảo mật sâu hơn cho nhắn tin: bí mật chuyển tiếp, ký chéo khóa, lịch sử cho thiết bị mới; kho khóa phần cứng trên app native. |

## 6. Thật, giả lập, chưa kiểm

| | |
|---|---|
| **Thật, có test** | Logo và icon; runtime ngôn ngữ, 13 catalog, định dạng số nhiều và ngày giờ; bộ lọc LeLe đa ngôn ngữ; chia sẻ ra từ thiết bị và trình dựng liên kết; PKCE và vòng liên kết; chuỗi `social.post`; mật mã `LNH-MSG-1` theo vector công bố; hộp thư, hội thoại, hộp gửi; đăng ký thiết bị; bộ phân tích Bluetooth và tệp xuất theo vector; bố cục bốn cỡ màn hình trên Chromium. |
| **Giả lập** | Nhà cung cấp mạng xã hội (`mock`, bằng chứng `SIMULATED`); người dùng và «thiết bị» trong test (tài khoản dev, nhiều ngữ cảnh trình duyệt trên một máy); dữ liệu sức khỏe tổng hợp; Graph, Matter, IAM như ở 0.1.0. |
| **Bản nháp** | Mọi bản dịch ngoài tiếng Việt và bảng từ của LeLe: dịch máy, chưa ai rà soát, chưa CLO hay chuyên gia y tế duyệt. |
| **Chưa kiểm được ở đây** | Mọi nền tảng mạng xã hội thật; thiết bị Bluetooth thật; tệp xuất thật của hãng; Safari, Firefox, iOS, Android; trình đọc màn hình; phân loại pháp lý; ca T01–T22 trên môi trường đích. |
