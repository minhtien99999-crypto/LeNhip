# LeNhip — quy tắc làm việc

Bản tham chiếu 1.0.1 theo LNH-SRS-002 V2.0 (gói hợp đồng LNH-SRS-001 V1.1 vẫn áp cho API đã phát hành), bản thiết kế `docs/THIET_KE_V1_0_0.md` và bản rà soát `docs/RA_SOAT_LENHIP_V2_0.md`. Bản đồ repo nằm ở `README.md`. Mã LNH-F/T/Q/D của SRS V1.1 (F01–F19, T01–T19, Q01–Q07, D01–D12) định nghĩa ở `docs/RA_SOAT_LENHIP_V1_1.md`; mã của 1.0.0 (từ F20, T20, Q08, D13) ở `docs/THIET_KE_V1_0_0.md`; mã của 1.0.1 (từ F30, T60, Q16, D21) ở `docs/RA_SOAT_LENHIP_V2_0.md`. Route mới của SRS V2.0 nằm dưới `/v2/`; mô-đun mới có cờ tắt khi chưa đặt. Mỗi mã chỉ định nghĩa ở một tài liệu.

## Quy tắc chung

- Trả lời đúng điều được hỏi trước. Không biết thì nói không biết.
- Làm đủ rồi mới báo xong: chạy mục Kiểm tra, và báo cả phần chưa kiểm hoặc chưa làm.
- Viết tiếng Việt, tệp UTF-8. Script Python mở tệp với `encoding="utf-8"`. Chữ giao diện không viết trong mã: nó nằm ở catalog tiếng Việt (`web/shared/i18n-vi*.js`, bản gốc) và được dịch ở catalog của từng ngôn ngữ; quy tắc đặt khóa và hướng dẫn dịch ở đầu `web/shared/i18n.js`.
- Commit theo dạng `type(scope): mô tả` bằng tiếng Anh, mỗi commit một việc. Chỉ commit và push khi người dùng yêu cầu.
- Không in, log hay commit secret, token hay khóa riêng. Khóa permit nằm trong thư mục dữ liệu (bị gitignore), môi trường thật dùng KMS.

## Không được làm

- Không sửa tệp trong `docs/source/`. Mọi tệp ở đó phải khớp mã băm trong `contracts/traceability.json`.
- Không đưa số liệu sức khỏe, nhãn sức khỏe hay lý do của gợi ý vào API hay sổ. Schema tác vụ luôn `additionalProperties=false`.
- Không thêm route, bảng hay trường nào về thiết bị theo dõi ở máy chủ. Không đồng bộ dữ liệu sức khỏe giữa các máy. Dữ liệu nhập từ tệp xuất chỉ nằm trong bộ nhớ của trang: không ghi localStorage, sessionStorage, IndexedDB, cookie hay Cache API (LNH-T52 đến LNH-T55).
- Không để máy chủ thấy bản rõ của tin nhắn, khóa nội dung hay khóa riêng; không lưu tên máy hay user agent. LeLe không có đường nào tới nội dung tin nhắn (LNH-T31, LNH-T36).
- Không đọc hay lưu ngôn ngữ của người dùng ở máy chủ; không đưa văn bản đã dịch vào payload hay digest (LNH-T23, LNH-T26). Sửa một văn bản đồng ý thì đổi phiên bản ở `web/shared/consent-text.js` rồi chạy `node scripts/make-consent-texts.ts`.
- Không gửi câu gõ cho LeLe ra khỏi thiết bị khi quy tắc cục bộ chưa nhận ra lệnh, hoặc khi có từ sức khỏe hay dữ liệu cá nhân của bất kỳ ngôn ngữ nào (LNH-T24). Sửa bảng từ thì thêm câu mẫu vào `tests/lele-i18n.test.ts` và đổi `LELE_RULES_VERSION`.
- Không bật mô-đun mới theo mặc định: cờ `messaging`, `social`, `trackers` tắt khi chưa đặt rõ (LNH-F27). Không nói một thao tác đã xảy ra khi chưa có bằng chứng (chia sẻ ra ngoài: «LeNhip không biết bạn đã đăng hay chưa»).
- Không thêm SDK, widget, phông, logo hay yêu cầu mạng của bên thứ ba vào trang; CSP không đổi.
- Không thêm đường nào đổi lịch hoặc thiết bị mà bỏ qua plan → xác nhận → permit → receiver → bằng chứng. Không tự gửi lại sau kết quả mơ hồ. Không tự chuyển UNKNOWN thành FAILED.
- Không thêm cạnh trạng thái chỉ trong mã. Mọi cạnh nằm ở `contracts/state_transitions.csv`; thêm cạnh phải ghi mã LNH-T trong bản rà soát.
- Không sửa migration đã phát hành (0001 trong `src/server/store.ts`, từ 0002 trong `src/server/migrations/`; đều có kiểm mã băm). Cần đổi thì thêm migration mới.
- Không đổi kết quả fixture LNH-SLEEP-1 mà giữ nguyên `algorithm_version`.
- Không bật nhà cung cấp mô hình ngoài khi chưa có VendorProfile được duyệt.
- Không dùng tên người thật trong dữ liệu mẫu.

## Kiểm tra

```bash
npm ci
npm run typecheck && npm test && npm run check
npm run e2e        # khi đổi giao diện; cần Playwright. Chạy mọi tệp scripts/e2e*.mjs
```

## Thêm mô-đun (V1.0.0)

Thiết kế: `docs/THIET_KE_V1_0_0.md`. Một tính năng mới là tệp mới cộng vài dòng đăng ký; không sửa các tệp lõi.

### Thêm một tính năng phía máy chủ (V1.0.0)

Một tính năng = **tệp mới** + **vài dòng dưới mốc của riêng nó**. Không sửa `api.ts`, `app.ts`, `authority.ts`, `plans.ts`, `privacy.ts`, `recovery.ts`, `errors.ts`, `store.ts`, `tests/helpers.ts`, `tests/modules.test.ts`, `scripts/check-contracts.ts`. Mỗi track chỉ chèn dòng **ngay dưới dòng mốc của mình**; chèn chỗ khác là hai nhánh sẽ xung đột khi gộp.

#### 1. Mô-đun

- Tạo `src/server/<ten>.ts`, export `export const <ten>: ServerModule = { name: "<ten>", ... }` (kiểu ở `src/server/modules.ts`).
- Đăng ký ở cuối `src/server/modules.ts`, hai dòng:
  - dưới `// ── nhắn tin và «Thiết bị của tôi»: dòng import đặt ngay dưới dòng này ──` (hoặc mốc `mạng xã hội`): `import { messaging } from "./messaging.ts";`
  - trong mảng `MODULES`, dưới mốc `... một dòng đặt ngay dưới dòng này ──` của mình: `messaging,`
- Thiết bị theo dõi **không có** mô-đun máy chủ (LNH-T53), chỉ có cờ `trackers`. Mô-đun khác: thêm một cặp mốc mới ở cuối.
- **Quy tắc import** (kiểm ở `tests/modules.test.ts`): tệp mô-đun chỉ `import type` từ `modules.ts`, `api.ts`, `app.ts`. Hàm chạy thật lấy từ `authority.ts`, `store.ts`, `context.ts`, `recovery.ts`, `machine.ts`, `core/*`.
- Trạng thái trong bộ nhớ theo từng app (token, bộ đếm): `const STATE = new WeakMap<Ctx, ...>()` trong tệp mô-đun. Không dùng biến toàn cục: mỗi kiểm thử và mỗi lần khởi động lại là một app mới.

#### 2. Các hook của `ServerModule`

| Hook | Hợp đồng |
|---|---|
| `routes?: Route[]` | Cùng dạng và cùng đường xử lý với route lõi: so khớp → xác thực → `X-LeNhip-Workspace` → giới hạn tốc độ (một xô chung theo người dùng) → POST: schema, idempotency → handler. Đường dẫn dưới `/v1/`; tham số `{ten}` chỉ khớp `[A-Za-z0-9_-]{1,128}`; route lõi so khớp trước, rồi theo thứ tự `MODULES`. POST bắt buộc có `schema` (tên trong OpenAPI; thân rỗng dùng `"Empty"` + `optionalBody`) và `readable`. Handler có `await` phải đặt `async: true` (khi đó chạy ngoài giao dịch). Handler không đặt được header; chỉ `ApiError` có `headers`. |
| `devRoutes?: DevRoute[]` | `{ path: "/dev/...", handler(d, query) }`, chỉ GET, chỉ khi chạy `LENHIP_DEV`, không token, không vào OpenAPI. Trả `{ status: 200, body }` hoặc `{ status: 302, location }` với `location` cùng gốc (bắt đầu bằng một dấu `/`). Dùng cho trang ủy quyền của nhà cung cấp `mock` (LNH-T42). |
| `errors?: Record<string,string>` | Mã lỗi mới → câu tiếng Việt. Không sửa `MESSAGES`. Trùng mã với nội dung khác thì app không dựng được. |
| `seed?(ctx)` | Chạy ở **mỗi** lần khởi động có seed (dev và kiểm thử), sau seed của lõi: tự kiểm đã có chưa. Quyền `messaging.use` / `social.post` cho tài khoản thử phải chèn ở đây (không API nào tạo quyền). |
| `onTick?(ctx, now)` | Cuối mỗi vòng `app.tick()`, `now` từ đồng hồ tiêm được. Lỗi của một mô-đun không chặn lõi hay mô-đun khác, nhưng vẫn được ném ra. Kiểm thử gọi `await h.app.tick()`. |
| `privacy.exportFor(ctx, ws, user)` | Phần của mô-đun trong tệp xuất, nằm ở `modules.<name>`. Không token, không khóa, không nội dung của người khác. |
| `privacy.deleteFor(ctx, ws, user, at)` | Chạy trong giao dịch của DELETE, trước tombstone `member_deleted`. |
| `privacy.onConsentWithdrawn(ctx, ws, user, purpose, at)` | Khi một đồng ý mất hiệu lực: rút qua route, đổi GRANTED → DECLINED, hoặc bị RESTRICT/WITHDRAW rút. Không gọi khi DELETE. |
| `privacy.onRestrict(ctx, ws, user, at)` | Sau các `onConsentWithdrawn` của cùng yêu cầu RESTRICT/WITHDRAW. |
| `revocations?: Record<loại, (ctx, entry) => boolean>` | Nạp lại sổ thu hồi sau restore, trả `true` nếu có đổi. Khai cho loại dòng của mình và, nếu cần, cho loại của lõi (`grant_revoked`, `consent_withdrawn`, `binding_changed`, `member_deleted`; chạy sau phần lõi). Phải lặp lại an toàn và **không ghi thêm** vào sổ thu hồi. |
| `kinds?: KindSpec[]` | Loại tác vụ mới, xem mục 6. |

Các hook `privacy` chạy đồng bộ trong giao dịch của lõi: không `await`; hook ném lỗi thì cả thao tác bị hủy (người dùng nhận 500). Việc gọi ra ngoài để sau (`onTick`).

Hàm dùng chung đã có:

- `requireModuleGate(ctx, ws, user, { module, scope, purpose })` (`authority.ts`): cổng thành viên 404 → cờ 503 `MODULE_DISABLED` → quyền 403 → đồng ý 403 `CONSENT_REQUIRED`. Gọi ở đầu mỗi handler thay cho `requireMember`.
- `isActiveMember(ctx, ws, user)`: dùng cho `readable: (c) => isActiveMember(c.d.ctx, c.ws, c.p.sub)`.
- `journalRevocation(ctx, type, at, data)` (`recovery.ts`): ghi một dòng vào sổ thu hồi; từ chối loại chưa có bên nạp lại.
- `c.p.auth_time` để đòi xác thực lại (`401 REAUTH_REQUIRED` khi quá `ctx.config.reauthMaxAgeS`).

#### 3. OpenAPI

- Thao tác và schema mới: tệp mảnh `contracts/openapi/<ten>.json`, chỉ có `paths` và `components` (`schemas`, `parameters`, `responses`), `$ref` viết như trong tài liệu đã ghép. Mảnh chỉ được thêm; trùng khóa với lõi hoặc mảnh khác thì máy chủ không chạy.
- Mỗi thao tác có tham số `Workspace`; mỗi POST có `IdempotencyKey` và thân `$ref` tới schema có tên; schema đối tượng cấp cao nhất có `additionalProperties: false`.
- Sửa thứ đã có (enum của lõi, schema `Error`, `LeLeResult`) vẫn làm trong `contracts/openapi.json`.
- `node scripts/check-contracts.ts --bundle` in bản đã ghép.

#### 4. Migration

- Tệp mới `src/server/migrations/0003_messaging.ts` (nhắn tin và «Thiết bị của tôi») hoặc `0004_social.ts` (mạng xã hội): `export const m0003: Migration = { id: "0003_messaging", sha256: "<hex>", sql: `...` };` (`import type { Migration } from "../store.ts"`).
- Đăng ký ở `src/server/migrations/index.ts`: dòng import dưới mốc `// ── 0003 nhắn tin: dòng import ...` và `m0003,` dưới mốc trong `LATER_MIGRATIONS` (tương tự cho 0004).
- `sha256` là sha256 hex của đúng chuỗi `sql`. Cách lấy: để tạm chuỗi rỗng, chạy `npm test`, thông báo lỗi in mã băm đúng.
- 0001 và 0002 đã phát hành, không sửa. 0003 và 0004 chỉ dựa vào lược đồ tới hết 0002, không dựa vào nhau. Số từ 0005: thêm mốc mới ở cuối.

#### 5. Cờ, quyền, mục đích

- Cờ `messaging`, `social`, `trackers` tắt khi chưa đặt rõ `true`; `ctx.control.moduleOn("messaging")`. Dữ liệu mẫu của dev và harness kiểm thử bật sẵn; muốn thử lúc tắt thì `POST /v1/ops/flags`.
- Đã có sẵn trong sổ và hợp đồng: quyền `messaging.use`, `social.post`; mục đích `messaging`, `social_post`. `/v1/me` trả `modules` đủ bảy khóa.
- Thêm một quyền, mục đích hay cờ khác cần đồng thời: migration dựng lại CHECK, danh sách trong `authority.ts` / `control.ts`, enum trong `openapi.json`. `npm run check` đối chiếu cả hai chiều.

#### 6. Loại tác vụ mới (`social.post`)

Khai một `KindSpec` trong `kinds`: `kind`, `scope`, `purpose`, `module`, `trust` (`"sim"` cho đích giả lập), `exportPolicy: { fields, residual_inference }`, `resolve(ctx, ws, actor, input)`, `binding(ctx, row)`, `adapter(ctx, world)`, tùy chọn `outcomes`.

- Lõi tự đưa adapter vào cả ba bảng (reconciler, receiver, issuer), kiểm cờ, quyền, đồng ý, binding, và thêm mục chính sách xuất vào mọi workspace khi khởi động (plan chưa claim của workspace đó bị vô hiệu một lần).
- `trust: "sim"`: issuer và gốc tin cậy mô phỏng; adapter chỉ được trả bằng chứng hạng `SIMULATED`, hạng khác bị chặn.
- `world` giữ bên ngoài giả lập qua khởi động lại (`h.app.world`); token để trong bộ nhớ theo app.
- `execute` chỉ chạy một lần, không gì gửi lại; `readback` không trả `NO_EFFECT` khi tác vụ đang `ACKED`.
- Phần phải sửa tay trong `contracts/openapi.json` (chỉ track này sửa): thêm vào `PlanInput.oneOf` + `mapping`, `ActionPayload.oneOf` + `mapping`, enum `Plan.kind`, `Action.kind`, `Action.outcome`. Schema `<X>Input`, `<X>Payload` đặt trong mảnh.

#### 7. Máy trạng thái khác

- Thêm hàng vào cuối `contracts/state_transitions.csv`, trạng thái có tiền tố riêng (`THREAD_...`), cột `ref` dẫn mã LNH-T (ví dụ `LNH-T33`).
- Nạp: `const find = indexTransitions(transitionsFor("THREAD_"))`; `find(from, event, actor)?.to` (`machine.ts`).
- Mọi sự kiện trong CSV phải xuất hiện trong `src/` dưới dạng chuỗi `"ten"`; không viết `event: "..."` trong `src/` nếu đó không phải sự kiện của CSV.
- Máy tác vụ giữ đúng 33 cạnh (`tests/machine.test.ts`).

#### 8. Truy vết và mã LNH

- Hàng ngoài SRS đặt trong `contracts/traceability.json` → `additions.<nhóm>` (`shell`, `i18n`, `messaging`, `social`, `trackers`), chèn giữa `"<nhóm>": [` và `],` của nhóm mình.
- Một hàng có đúng các khóa `id` (`V1-<MÃ><nn>`), `title`, `decisions` (mã `LNH-Tnn`), `status`, `code`, `tests`, và `remaining` khi `status` khác `CODE_REFERENCE`. `requirements` giữ đúng 33 REQ.
- Mã `LNH-...` mới phải có hàng `| LNH-Xnn |` trong `docs/THIET_KE_V1_0_0.md` hoặc `docs/RA_SOAT_LENHIP_V1_1.md`, chỉ một nơi. Hai track không lấy cùng một số.

#### 9. Kiểm thử

- Viết ở tệp riêng `tests/<ten>*.test.ts`; hàm trợ giúp riêng để ở tệp riêng.
- `harness()` dùng `MODULES` đã đăng ký; `harness({ modules: [...] })` thay bằng mô-đun khác. Mẫu đủ mọi hook: `tests/modules.test.ts`.
- Trước khi commit: `npm run verify`.

### Khung giao diện V1.0.0 (web)

Hợp đồng đầy đủ nằm ở đầu `web/views/index.js` (màn hình và `ctx`) và `web/views/connect.js` (phần của Kết nối). Mô-đun tính năng **không import và không sửa `web/app.js`, `web/styles.css`, `web/index.html`, `web/views/index.js`, `web/views/connect.js`**.

#### Tệp của từng nhánh

| Nhánh | Tệp được sửa | Catalog | Kiểm trình duyệt |
|---|---|---|---|
| Nhắn tin | `web/views/messages.js`, `web/views/messages.css`, `web/views/connect-endpoints.js`, `web/views/connect-endpoints.css` | `web/shared/i18n-<file>-msg.js`, khóa `msg.*` | `scripts/e2e-messages.mjs` (tạo mới) |
| Mạng xã hội | `web/views/connect-social.js`, `web/views/connect-social.css` | `web/shared/i18n-<file>-social.js`, khóa `social.*` | `scripts/e2e-social.mjs` (tạo mới) |
| Thiết bị theo dõi | `web/views/connect-trackers.js`, `web/views/connect-trackers.css` | `web/shared/i18n-<file>-dev.js`, khóa `dev.*` | `scripts/e2e-trackers.mjs` (tạo mới) |
| Ngôn ngữ | `web/app.js`, `web/index.html`, `web/views/core.js`, `web/shared/i18n-<file>.js` (phần lõi), ô chọn ngôn ngữ | khóa lõi, không dùng tiền tố `msg.`, `social.`, `dev.` | `scripts/e2e-i18n.mjs` (tạo mới) |

- Tệp mới trong `web/shared/` hoặc `web/views/` phải có tên chữ thường, số, gạch nối. Máy chủ chỉ phục vụ `shared/[a-z0-9-]+.js`, `views/[a-z0-9-]+.(js|css)`, `icons/[a-z0-9-]+.png`.
- Các tệp giữ chỗ hiện chỉ in một câu «chưa có trong bản dựng này» bằng khóa `shell.*`. Thay toàn bộ nội dung tệp, giữ nguyên `id`, `order`, `visible`.

#### Màn hình (`export default` của một tệp trong `web/views/`)

```js
// Đơn giản: vẽ lại mỗi lần ứng dụng render; HTML không đổi thì DOM được giữ nguyên
{ id, order, nav, visible(ctx), render(ctx) /* -> chuỗi HTML */, bind?(ctx, mainEl) }
// Có trạng thái: mount một lần; render nền chỉ gọi update, KHÔNG dựng lại DOM; đổi tài khoản thì mount lại
{ id, order, nav, visible(ctx), mount(ctx, hostEl), update?(ctx), unmount?() }
```

Trường chung:

- `id`: `[a-z][a-z0-9-]*`, cũng là địa chỉ `#id` và giá trị `data-nav`.
- `order`: 10 Hôm nay, 20 Sức khỏe, 30 Công việc, 40 Ngôi nhà, 50 Tin nhắn, 60 Kết nối.
- `nav`: `{ label(ctx) -> văn bản, icon: tên glyph, bar: boolean, hint?(ctx) -> văn bản, badge?(ctx) -> null | { text, label } }`.
  - `bar: true`: có trên thanh dưới của điện thoại. Tối đa 5 mục, `buildViews` ném lỗi nếu quá.
  - `bar: false`: chỉ ở thanh bên từ 701 px và là một dòng trong hộp Tài khoản.
- `visible(ctx) -> boolean`: mô-đun mới đọc cờ kiểu `ctx.modules.messaging === true`.
- `wide?: true`: dùng hết bề ngang nội dung và ẩn cột chọn phong cách (`body[data-layout=wide]`).
- `context?: "personal" | "work"`, `contextSwitch?: true`: chỉ bốn màn hình gốc dùng.
- `background?(ctx)`: chạy một lần khi màn hình hiển thị với tài khoản đang đăng nhập, kể cả khi người dùng ở màn hình khác (huy hiệu tin mới). Dừng khi mô-đun tắt hoặc đổi tài khoản.
- `plans?: { "<kind>": { title(ctx, preview) -> văn bản, summary(ctx, preview) -> HTML } }`: loại kế hoạch mới đi qua `ctx.propose`.

#### `ctx`

| Trường | Chữ ký và ý nghĩa |
|---|---|
| `ctx.me` | phản hồi `GET /v1/me` hoặc `null` |
| `ctx.modules` | cờ của `me.modules`, đóng băng; `{}` khi chưa có `me` |
| `ctx.state` | `{ online, view, context, zone, settings, actions, site, lamps, availability }`, đóng băng. `lamps` là đèn tại site. Không có dữ liệu sức khỏe |
| `ctx.zone()` / `ctx.now()` | múi IANA phân tích của người dùng / mili giây theo đồng hồ máy chủ |
| `ctx.api` | `api.get(path)`, `api.post(path, body?, { key? })`. Mọi POST có Idempotency-Key; gửi lại đúng nội dung cũ thì truyền lại `{ key }` đã tạo cùng bản nháp. `api.ws` là workspace, `api.login(sub)` chỉ có ở chế độ dev |
| `ctx.t(key, params?)` | văn bản thuần. Số trong `params` được định dạng theo ngôn ngữ; thông điệp số nhiều cần `n` là số; thiếu tham số thì ném lỗi |
| `ctx.tSafe(key, params?)` | như `t` nhưng đã thoát ký tự, ghép thẳng vào HTML |
| `ctx.locale()` | tag đang chọn |
| `ctx.formatNumber(n, options?)`, `ctx.formatDate(value, options?)`, `ctx.formatWeekday(value, style?, timeZone?)` | `value`: `Date`, mili giây, chuỗi ISO có độ lệch, hoặc ngày theo lịch `"YYYY-MM-DD"` |
| `ctx.formatTime24(value, timeZone?)` | luôn `"HH:MM"`; truyền `ctx.zone()` |
| `ctx.formatDuration(phút, { unit?, list? }?)` | mặc định «7 giờ 30 phút» / «7 hr 30 min» |
| `ctx.formatList(items, options?)` | `Intl.ListFormat` |
| `ctx.safe(value)` | thoát `& < > " '` |
| `ctx.icon(name)` | SVG 24 px. Glyph mới: messages, link, share, send, phone, tablet, laptop, desktop, watch, bluetooth, file, globe, bell, search, trash, block, flag, key, copy, mail, refresh, close, people. Cần glyph khác thì viết `<svg viewBox="0 0 24 24" aria-hidden="true">…</svg>` ngay trong tệp của mình |
| `ctx.toast(văn bản)` | thông báo nổi |
| `ctx.openDialog(tiêu đề, html, { onClose? })` | mở hộp thao tác dùng chung, trả phần tử thân hộp để gắn sự kiện. Tiêu đề là văn bản thuần. `onClose` gọi đúng một lần khi hộp đóng hoặc nội dung bị thay |
| `ctx.closeDialog()` | đóng hộp |
| `ctx.rerender()` | vẽ lại ứng dụng |
| `ctx.refresh()` | `Promise`: nạp lại `/v1/me`, lịch, đèn, tác vụ rồi vẽ lại |
| `ctx.navigate(id, { focus? }?)` | `boolean`; `false` nếu màn hình không hiện với tài khoản này |
| `ctx.propose(input, nhãn)` | `POST /v1/plans` rồi mở bước xem lại và đồng ý 120 giây dùng chung. Không có đường tắt nào khác |
| `ctx.actionCard(action, compact?)` | HTML thẻ tác vụ theo bằng chứng |
| `ctx.every(ms, fn, { immediate? }?)` | `ms` ≥ 250; trả hàm dừng. Tạm dừng khi ẩn tab, hiện lại thì gọi ngay một lần rồi chạy tiếp, dừng hẳn khi rời màn hình. Lần gọi trước chưa xong thì bỏ nhịp kế tiếp |
| `ctx.onLeave(fn)` | dọn dẹp khi rời màn hình, hoặc trước khi phần hay màn hình đơn giản bị vẽ lại |
| `ctx.signal` | `AbortSignal` bị hủy cùng lúc: `el.addEventListener("click", fn, { signal: ctx.signal })` |
| `ctx.fork()` | `{ ctx, end() }`, phạm vi con; chỉ `connect.js` cần |

`every`, `onLeave`, `fork`, `signal` chỉ có trong `mount`, `bind`, `render` và `background`. `ctx` truyền cho `visible`, `nav.*`, `plans.*` là bản chỉ đọc; gọi `every` ở đó sẽ ném lỗi.

#### Phần của màn hình Kết nối (`connect-*.js`)

```js
{ id, order, visible(ctx), render(ctx) /* -> HTML, gồm cả <h2> */, bind?(ctx, el), update?(ctx, el), plans? }
```

- Khung bọc mỗi phần trong `<section class="card connect-section" data-section="<id>">`.
- Phần **không có** `update`: mỗi lần render nền khung gọi lại `render`. Chỉ khi HTML khác lần trước mới thay DOM và gọi lại `bind`; phạm vi cũ được dọn trước.
- Phần **có** `update`: `render` và `bind` một lần, render nền chỉ gọi `update(ctx, el)`. Dùng cho phần có ô nhập.
- Trong `bind`, gắn sự kiện vào phần tử con của `el` hoặc dùng `{ signal: ctx.signal }`.

#### Đăng ký một dòng (chỉ khi thêm thứ CHƯA có tệp sẵn)

- Màn hình mới: `import x from "./x.js";` và thêm `x` vào mảng trong `buildViews()` của `web/views/index.js`.
- Phần mới của Kết nối: `import` và thêm vào `SECTIONS` trong `web/views/connect.js`.
- Tệp CSS mới: thêm `<link rel="stylesheet" href="./views/<tên>.css">` vào `web/index.html`.
- Ngôn ngữ: tạo `web/shared/i18n-<file>.js` và ba tệp phần. Bảng nạp `web/shared/i18n-loaders.js` đã có sẵn đủ 13 × 4 mục.

#### Chuỗi và catalog

- Mỗi tệp đúng dạng `export default ` + JSON chặt + `;` + xuống dòng. Tệp rỗng là `export default {};`.
- Khóa phẳng có dấu chấm, khớp `^[a-z][a-z0-9]*(\.[A-Za-z0-9_]+)+$`.
- Tiền tố theo tệp: `msg.*` trong `-msg.js`, `social.*` trong `-social.js`, `dev.*` trong `-dev.js`. Phần lõi không dùng ba tiền tố đó.
- Giá trị là chuỗi có `{tên}`, hoặc đối tượng nhánh số nhiều theo loại CLDR của chính ngôn ngữ đó, luôn có `other`: `{ "one": "{n} tin", "other": "{n} tin" }`. Không HTML, không cú pháp lồng, không khoảng trắng đầu hoặc cuối.
- Tiếng Việt là bản gốc: thêm khóa vào `i18n-vi*.js` trước. `tests/i18n-runtime.test.ts` yêu cầu tiếng Anh có đúng tập khóa của tiếng Việt, và ngôn ngữ khác không có khóa lạ.
- Thiếu khóa thì lùi về tiếng Việt, rồi trả lại chính khóa và cảnh báo một lần.
- Nhánh ngôn ngữ đổi ngôn ngữ bằng `settings().locale` (`"auto"` hoặc tag) rồi gọi `syncLocale()` trong `app.js`. Hàm này hoãn khi màn hình xem lại đang đếm ngược.

#### Kiểm trình duyệt (`scripts/e2e-<tên>.mjs`)

```js
import { run } from "./e2e-lib.mjs";
await run("tên", async (t) => {
  const { page } = await t.open({ modules: { messaging: true } });
  await t.dismissNotice(page);
  await page.click("#desktop-nav button[data-nav=messages]");
  t.ok((await page.textContent("main")).includes("…"), "mô tả phép kiểm");
});
```

- `npm run e2e` chạy `scripts/e2e.mjs` rồi mọi `scripts/e2e-*.mjs` khác, trừ `e2e-lib.mjs`. Không cần sửa `package.json`.
- Chạy một tệp: `npm run e2e -- messages`, hoặc `node scripts/e2e-messages.mjs [thư-mục-ảnh]`. Lưu ảnh cả bộ: `npm run e2e -- --shots=<thư-mục>`.
- `t.open({ viewport, modules, locale, reducedMotion, collectErrors, path, wait })` trả `{ context, page }`. Mặc định 1440×900, `vi-VN`, giờ Việt Nam, `deviceScaleFactor: 1`, tài khoản `dev_a`, chờ `body[data-ready=true]`.
- `modules` thêm cờ vào phản hồi `/v1/me` bằng chặn route.
- Hàm có sẵn trên `t`: `ok`, `shot(page, tên, cảTrang?)`, `ready`, `acceptNotice(page, purposes?)`, `dismissNotice`, `signIn(page, "dev_b")`, `chooseSettings(page, { theme, fontSize })`, `applySettings(page, settings)`, `overflowX(page)`, `navSpill(page)`, `withModules(context, modules)`, `base`, `browser`, `errors`.
- Hai người dùng: mở hai `t.open()` rồi `t.signIn(page2, "dev_b")`.
- Mọi lỗi JavaScript và `console.error` làm hỏng lượt kiểm, trừ trang mở với `collectErrors: false`.
- Máy chủ giới hạn 5 yêu cầu/giây mỗi tài khoản (dồn tối đa 40). Trong vòng lặp dài, đổi màn hình bằng `location.hash` và đổi phong cách bằng `t.chooseSettings`, đừng nạp lại trang.
- Khung giờ lịch đặt vào ngày mai (`selectOption("#block-day", { index: 1 })`): máy chủ từ chối giờ đã qua.

#### CSS

- Viết trong `web/views/<tệp của mình>.css`. Đặt bộ chọn dưới `body[data-view=<id>]`, `.connect-section[data-section=<id>]`, hoặc lớp có tiền tố riêng (`msg-`, `social-`, `endpoint-`, `tracker-`).
- Màu chỉ lấy từ token của phong cách: `--bg --surface --surface-soft --text --muted --line --accent --accent-ink --gold --shadow`, và `--lele*` cho chữ LeLe. Không viết mã màu cứng cho chữ và nền, để cả năm phong cách cùng chạy.
- Thuộc tính logic: `inline-size`, `block-size`, `margin-inline`, `padding-block`, `inset-inline-end`, `text-align:start`. Không dùng `left`, `right`, `margin-left`…
- Bốn cỡ: điện thoại `max-width:700px`, máy tính bảng `701–1180`, máy tính xách tay `1181–1499`, máy tính để bàn `min-width:1500px`. Lớp `.large-text` (cỡ chữ từ 150 %) dùng bố cục điện thoại ở mọi bề ngang, nên luật hai cột phải viết `body:not(.large-text) …`.
- Vùng bấm tối thiểu 44 px. Không tải phông. `body` đã có `overflow-wrap:anywhere`; nhãn ngắn không được ngắt giữa từ thì đặt `overflow-wrap:break-word`.
- Lớp dùng lại được: `card`, `view-card`, `button primary|secondary|quiet|small|full`, `text-button`, `tiny-pill`, `status-chip ok|warn|busy|muted`, `fine-print`, `empty-state`, `field`, `section-heading`, `heading-row`, `event-row`, `event-copy`, `privacy-note`, `chat-list`, `chat-message` (chỉ dùng làm lớp, không dùng id của LeLe).
- Inline SVG nhận luật `svg` chung (22 px, có nét, không tô). Hình vẽ riêng cần lớp gỡ luật đó, như `svg.brand-wordmark` và `svg.lele-mark`.

#### Tên đã có nghĩa, không dùng lại

- Thuộc tính: `data-nav` (dùng để điều hướng: `<button data-nav="connect">`), `data-action`, `data-context`, `data-login`, `data-device`, `data-theme-choice`, `data-draft-theme`, `data-check-action`, `data-cancel-action`.
- id: `chat-form`, `chat-list`, `block-form`, `consent-form`, `countdown`, `action-body`, `action-title`, `main`.
- `devices`, `data-device`, `/v1/devices` là đèn tại site. Máy của người dùng gọi là «điểm nhận tin» (endpoint), vòng đeo gọi là «thiết bị theo dõi» (tracker).

### Ngôn ngữ

- 13 ngôn ngữ ở `LOCALES` (`web/shared/i18n.js`). Mỗi ngôn ngữ có bốn catalog: `i18n-<file>.js` (lõi) và ba phần `-msg` (Tin nhắn, Thiết bị của tôi), `-social` (mạng xã hội), `-dev` (thiết bị theo dõi); `<file>` là tag viết thường. Tiếng Việt là bản gốc; mọi bản khác có `draft: true` (dịch máy, chưa rà soát) cho tới khi người bản ngữ rà xong (LNH-D13).
- Quy tắc đặt khóa và hướng dẫn cho người dịch: phần đầu `web/shared/i18n.js`. Dạng tệp bảng từ của LeLe và danh sách kiểm cho người rà soát: phần đầu `web/shared/lele-lexicon.js`.
- Thêm một chuỗi: thêm khóa vào catalog tiếng Việt của đúng phần, rồi vào **mọi** catalog khác cùng phần (kiểm thử đòi đủ khóa, đủ tham số, đủ nhánh số nhiều theo CLDR). Không ghép câu từ nhiều khóa; không viết chữ giao diện trong mã.
- Mô-đun lấy mọi thứ qua `ctx`, ngoài các hàm đã nêu ở mục khung giao diện còn có: `tSafe` (chuỗi đã thoát ký tự), `rich(key, slots, params?)` (chèn HTML tin cậy vào chỗ tham số), `bdi(tên)`, `errorText(lỗi)` (câu theo mã lỗi), `codeLabel(lớp, mã)` (nhãn của `state`, `outcome`, `reason`, `grade`), `draft()` (ngôn ngữ đang hiện là bản nháp), `consentText(purpose_id, tiền_tố?)`, `consentReceipt(purpose_id, tiền_tố?)`, `formatWeekdayCompact`, `formatDurationParts`.
- Văn bản đồng ý: thân ở khóa `<tiền tố>consent.<purpose_id>.body`; phiên bản ở `CONSENT_TEXT_VERSIONS` (`web/shared/consent-text.js`); sổ ghim `contracts/consent-texts.json` sinh bằng `node scripts/make-consent-texts.ts`. Mô-đun ghi đồng ý bằng `ctx.consentReceipt()`, không tự băm.
- Kiểm riêng một ngôn ngữ: `LENHIP_I18N_ONLY=<tag> node --test tests/i18n.test.ts tests/i18n-runtime.test.ts tests/lele-i18n.test.ts`.

### Dữ liệu sức khỏe trên thiết bị

`web/shared/health-input.js` là điểm nối duy nhất giữa màn hình Sức khỏe và nguồn dữ liệu trên thiết bị (LNH-T52, LNH-T55):

- `registerHealthProvider(fn)`: `fn({ sub, nowMs, zone, revision })` trả `null` hoặc `{ input, provenance }`; `input` đúng dạng đầu vào của
  `computeHealthDays()` trong `web/shared/sleep.js`, `provenance = { kind: "import", label, detail? }` với `label`, `detail` là văn bản đã dịch.
  Đăng ký lúc nạp mô-đun. Không nguồn nào có dữ liệu thì ứng dụng dùng dữ liệu tổng hợp.
- `notifyHealthInputChanged()`: gọi sau khi nhập hoặc xóa; ứng dụng tính lại và vẽ lại, không gọi máy chủ.
- Không hàm nào ở đây gọi mạng. Máy chủ không biết thiết bị đang dùng nguồn nào.
