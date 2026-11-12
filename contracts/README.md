# Hợp đồng dùng chung

Máy chủ, app iOS và app Android dùng chung các tệp trong thư mục này. Một tệp đổi thì mọi bên phải chạy lại kiểm thử của mình.

| Tệp | Nội dung | Ai dùng |
|---|---|---|
| `openapi.json` | API /v1 (OpenAPI 3.1), phần lõi. Máy chủ kiểm thân yêu cầu trực tiếp bằng các schema của hợp đồng đã ghép (xem «Mảnh OpenAPI của mô-đun»). | Client sinh mã, máy chủ, QA |
| `openapi/<mô-đun>.json` | Mảnh OpenAPI của một mô-đun thêm ở V1.0.0: thao tác và schema của riêng nó. Hôm nay chưa có mảnh nào. | Client sinh mã, máy chủ, QA |
| `state_transitions.csv` | Bảng chuyển trạng thái đầy đủ: trạng thái nguồn, sự kiện, actor, trạng thái đích, guard, hạn. Máy chủ đọc tệp này khi chạy. Một tệp, nhiều máy (xem «Các máy trạng thái»). | Máy chủ, QA (T07) |
| `fixtures/sleep/S01–S16.json` | Golden fixture LNH-SLEEP-1. Mỗi tệp có đầu vào, kết quả đầy đủ (`expected`) và phép kiểm lấy từ chữ của SRS (`checks`). App phải cho kết quả trùng từng trường. | iOS, Android (T03) |
| `fixtures/jcs-vectors.json` | Vector RFC 8785 và digest SHA-256 base64url, gồm cả payload lịch và đèn. Đầu vào là JSON thô để giữ cách viết số. | iOS, Android, máy chủ (T14) |
| `traceability.json` | Trạng thái của 33 REQ và 22 ca T, tệp mã và tệp kiểm thử tương ứng, mã băm tài liệu nguồn, và các hàng ngoài SRS của V1.0.0 (`additions`). | Tech Lead, QA |

`npm run check` (`scripts/check-contracts.ts`) kiểm mọi điều dưới đây. Mã `LNH-…` nhắc trong `src/`, `web/` hay `contracts/` phải có
hàng định nghĩa `| LNH-Xnn |` trong `docs/RA_SOAT_LENHIP_V1_1.md` hoặc `docs/THIET_KE_V1_0_0.md`, và chỉ ở một nơi.

## Mảnh OpenAPI của mô-đun

Hợp đồng API là `openapi.json` ghép với mọi tệp `openapi/<mô-đun>.json` (theo thứ tự tên tệp). Máy chủ và phép kiểm route ↔ OpenAPI
đều dùng bản đã ghép; `node scripts/check-contracts.ts --bundle` in bản đã ghép thành một tài liệu cho bên sinh client.

- Một mảnh chỉ có `paths` và `components` (`schemas`, `parameters`, `responses`), viết `$ref` như trong tài liệu đã ghép
  (`#/components/schemas/…`, `#/components/parameters/Workspace`).
- Mảnh chỉ được thêm. Trùng một đường dẫn, schema, tham số hay response đã có (ở lõi hoặc ở mảnh khác) thì máy chủ không chạy.
  Khóa JSON trùng trong một tệp cũng là lỗi.
- Quy tắc của lõi áp dụng nguyên: đường dẫn nằm dưới `/v1/`; mỗi thao tác có tham số `Workspace`; mỗi POST có `IdempotencyKey` và
  thân là `$ref` tới một schema có tên; schema đối tượng cấp cao nhất có `additionalProperties: false`; mục của một đường dẫn chỉ
  chứa thao tác (không `parameters`, `summary` hay `description` ở cấp đường dẫn).
- Sửa thứ đã có vẫn làm trong `openapi.json`: thêm giá trị vào enum của lõi, thêm một loại tác vụ vào `PlanInput`, `ActionPayload`,
  `Plan.kind`, `Action.kind`, `Action.outcome`.

Từ vựng dùng chung phải khớp mã, cả hai chiều:

| Trong OpenAPI | Trong mã |
|---|---|
| `Me.modules`, `FlagUpdate.module` | `MODULE_NAMES` (`src/server/control.ts`): `calendar`, `home`, `robot`, `lele`, và `messaging`, `social`, `trackers` (ba mục sau tắt cho tới khi đặt rõ là bật, LNH-F27) |
| `ConsentCreate.purpose_id`, tham số `purpose_id` của `/v1/consents/{purpose_id}/withdraw` | `PURPOSES` (`src/server/authority.ts`); riêng `ConsentCreate` có thêm `health_local`, máy chủ luôn trả 422 |
| `Me.grants[].scope` | `GRANT_SCOPES` (`src/server/authority.ts`) |
| Ánh xạ của `PlanInput` và `ActionPayload`, `Plan.kind`, `Action.kind` | ba loại của lõi và các loại do mô-đun khai (`ServerModule.kinds`) |

## Các máy trạng thái

`state_transitions.csv` chứa mọi máy trạng thái của hợp đồng. Mỗi hàng thuộc đúng một máy, theo trạng thái ở cột `from`:

- **Máy tác vụ** (SRS mục 18–19): `from` là một trong 12 trạng thái tác vụ. Máy này có đúng 33 cạnh; thêm hay bớt một cạnh cần mã
  LNH-T và phải sửa con số trong `tests/machine.test.ts`.
- **Máy khác**: mỗi máy một tiền tố trạng thái dạng `CHỮ_HOA_`, ví dụ `THREAD_` cho hội thoại (LNH-T33). Tiền tố không được trùng
  đầu tên một trạng thái tác vụ (`PENDING_` không dùng được). `from` và `to` của một hàng cùng tiền tố. Cột `ref` của các hàng này
  phải dẫn mã LNH-T đã quyết định chúng. Actor là chuỗi `CHỮ_HOA` của riêng máy đó.

Máy chủ nạp máy tác vụ vào `TRANSITIONS`; mô-đun nạp máy của mình bằng `transitionsFor("THREAD_")` và tra cạnh bằng
`indexTransitions(...)` (`src/server/machine.ts`). Không có cạnh nào chỉ nằm trong mã. Mọi sự kiện trong tệp, của máy nào cũng vậy,
phải có mã phát sinh trong `src/`, và mọi `event: "tên"` trong `src/` phải là một sự kiện của tệp.

## Truy vết

- `requirements`: đúng 33 REQ của SRS V1.1, không thêm hàng khác.
- `tests`: các ca T của SRS; mọi ca giữ `on_target: "NOT_EXECUTED"` cho tới khi có báo cáo chạy trên môi trường đích.
- `sources`: mã băm sha256 của từng tệp trong `docs/source/`; thiếu một tệp hay lệch một byte đều bị báo.
- `additions`: hàng **ngoài SRS** của V1.0.0, cho phần chủ sản phẩm yêu cầu thêm mà SRS V1.1 chưa có (LNH-F20). Chúng không phải
  REQ, không có ca nghiệm thu trong SRS và không thay phụ lục SRS V1.2.

`additions` là một đối tượng, mỗi khóa là một nhóm (`shell`, `i18n`, `messaging`, `social`, `trackers`), giá trị là danh sách hàng.
Mỗi nhóm viết trên các dòng riêng để hai nhánh thêm hàng vào hai nhóm khác nhau không sửa cùng một dòng. Một hàng có đúng các khóa:

| Khóa | Bắt buộc | Nội dung |
|---|---|---|
| `id` | có | `V1-<MÃ><nn>`, ví dụ `V1-MSG01`, `V1-SOC02`, `V1-I18N01`; duy nhất trong cả tệp |
| `title` | có | Một câu nói hàng này là gì |
| `decisions` | có | Ít nhất một mã `LNH-Tnn` của `docs/THIET_KE_V1_0_0.md` mà hàng này thực hiện |
| `status` | có | Như REQ: `CODE_REFERENCE`, `PARTIAL`, `NATIVE_APP`, `INFRA`, `G0_DECISION` |
| `code`, `tests` | có | Danh sách đường dẫn tệp có thật (có thể rỗng); `CODE_REFERENCE` cần ít nhất một tệp mỗi loại |
| `remaining` | khi `status` khác `CODE_REFERENCE` | Phần còn lại, kể cả phần giả lập và phần chưa kiểm được |

Ví dụ:

```json
{ "id": "V1-MSG01", "title": "Đăng ký «Thiết bị của tôi», tối đa 5 máy", "decisions": ["LNH-T30"], "status": "CODE_REFERENCE",
  "code": ["src/server/messaging.ts"], "tests": ["tests/messaging.test.ts"] }
```

Quy ước của LNH-SLEEP-1 đã chốt trong bản tham chiếu (chi tiết ở `docs/RA_SOAT_LENHIP_V1_1.md`, LNH-T07 đến LNH-T10):

- Thời gian tính bằng mili giây nguyên.
- Đoạn awake của cùng nguồn được trừ khỏi đoạn ngủ.
- Episode thuộc ngày local chứa thời điểm kết thúc.
- Episode dài quá 24 giờ là lỗi dữ liệu.
- sleep_seconds là giấc chính.
- Giây lấy floor; trung bình làm tròn nửa lên.
- Cần ít nhất 4/7 ngày có quan sát mới tính trung bình, cho cả giấc ngủ lẫn bước chân.
