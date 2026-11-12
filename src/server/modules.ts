// Sổ đăng ký mô-đun của máy chủ (V1.0.0). Một tính năng mới phía máy chủ = MỘT TỆP MỚI export một ServerModule + HAI DÒNG ở
// cuối tệp này (một dòng import, một dòng trong mảng MODULES), đặt ngay dưới dòng mốc của mô-đun đó. Lõi gọi các hook dưới đây
// tại đúng chỗ nó vẫn xử lý việc tương ứng; mô-đun không sửa api.ts, app.ts, authority.ts, privacy.ts, recovery.ts hay errors.ts.
//
// Quy tắc import (kiểm ở tests/modules.test.ts): tệp này nạp các tệp mô-đun, nên tệp mô-đun chỉ được `import type` từ modules.ts,
// api.ts và app.ts. Hàm chạy thật lấy từ authority.ts, store.ts, context.ts, recovery.ts, machine.ts, core/*.
//
// Bất biến lõi vẫn áp dụng cho mọi mô-đun: mọi POST có Idempotency-Key, schema thân có tên và đóng (additionalProperties=false),
// có `readable`; handler tự gọi requireMember; không số liệu sức khỏe; không đường nào đổi thứ gì ngoài LeNhip mà bỏ qua chuỗi
// kế hoạch → đồng ý → giấy phép → receiver → bằng chứng (muốn có chuỗi đó thì khai `kinds`).
import type { ApiDeps, Route } from "./api.ts";
import type { GrantScope, Purpose } from "./authority.ts";
import type { Ctx } from "./context.ts";
import type { ModuleName } from "./control.ts";
import type { JournalEntry } from "./journal.ts";
import type { ActionRow } from "./machine.ts";
import type { DispatchAdapter } from "./receiver.ts";

/** Đầu vào của POST /v1/plans cho một loại tác vụ do mô-đun khai, đã qua schema <X>Input trong OpenAPI. */
export interface KindInput {
  kind: string;
  schema_version: 1;
  workspace_ref: string;
  args: Record<string, unknown>;
}

/** Kết quả chuẩn hóa một plan: payload là nội dung duy nhất được băm và hiển thị để người dùng xác nhận. */
export interface Resolved {
  payload: Record<string, unknown>;
  target_ref: string;
  site_id: string | null;
  /** Một tác vụ UNKNOWN khóa mọi plan mới cùng resource_key (LNH-T02): chọn khóa đúng phạm vi cần khóa. */
  resource_key: string;
  window: [string, string] | null;
  binding: number;
}

/**
 * Một loại tác vụ mới đi trọn chuỗi kế hoạch → đồng ý 120 giây → giấy phép → receiver → bằng chứng. Khai một lần ở đây là đủ:
 * lõi đưa adapter vào cả ba bảng của app.ts (reconciler, receiver, issuer), kiểm cờ, quyền, đồng ý, chính sách xuất và binding.
 * Phần hợp đồng vẫn phải thêm tay: <X>Input và <X>Payload trong OpenAPI, ánh xạ trong PlanInput và ActionPayload, enum kind/outcome.
 */
export interface KindSpec {
  kind: string;
  /** Quyền cần có (grants.scope); tài nguyên của quyền luôn là null với loại do mô-đun khai. */
  scope: GrantScope;
  /** Mục đích đồng ý phải còn hiệu lực; null nếu loại này không cần đồng ý riêng. */
  purpose: Purpose | null;
  /** Cờ mô-đun gác loại này (kill switch). */
  module: ModuleName;
  /**
   * "authority": issuer và gốc tin cậy chính. "sim": issuer và gốc tin cậy mô phỏng, dành cho đích giả lập; adapter khi đó chỉ
   * được trả bằng chứng hạng SIMULATED (LNH-T19, LNH-T44).
   */
  trust: "authority" | "sim";
  /**
   * Mục của loại này trong chính sách xuất của workspace (SRS mục 14): các trường của payload rời khỏi LeNhip và điều bên nhận
   * suy ra được. Lõi ghép với `purpose` ở trên, đưa vào workspace mới và thêm vào workspace còn thiếu khi khởi động.
   */
  exportPolicy: { fields: string[]; residual_inference: string };
  /** Dựng payload đã chuẩn hóa. Chạy trong giao dịch của createPlan; ném ApiError khi đích không dùng được. Không await. */
  resolve(ctx: Ctx, ws: string, actor: string, input: KindInput): Resolved;
  /** Binding hiện hành của đích; null khi đích không còn dùng được (plan chưa claim thành stale). */
  binding(ctx: Ctx, row: Pick<ActionRow, "workspace_id" | "actor" | "target_ref" | "site_id">): number | null;
  /**
   * Dựng adapter, gọi một lần mỗi lần dựng app. `world` là thế giới bên ngoài giả lập (như lịch và đèn giả lập): kiểm thử giữ nó
   * qua các lần khởi động lại. Trạng thái trong bộ nhớ của riêng app (token…) để trong adapter hoặc một WeakMap theo ctx.
   */
  adapter(ctx: Ctx, world: Map<string, unknown>): DispatchAdapter;
  /** Outcome ghi khi vận hành viên nộp bằng chứng tay MATCH / CONFLICT; mặc định APPLIED / NO_EFFECT. */
  outcomes?: { match: string; conflict: string };
}

/**
 * Đường chỉ có ở chế độ dev (LENHIP_DEV), cạnh /dev/token: GET, không cần token, không nằm trong OpenAPI. Dành cho bên giả lập
 * cần một trang chuyển hướng (ví dụ nhà cung cấp `mock` của LNH-T42). Không bao giờ được phục vụ khi chạy với IAM thật.
 */
export interface DevRoute {
  /** Đường dẫn chính xác, bắt đầu bằng /dev/. */
  path: string;
  /** Trả JSON, hoặc chuyển hướng tới một đường dẫn cùng gốc (bắt đầu bằng một dấu "/"). */
  handler(d: ApiDeps, query: URLSearchParams): { status: 200; body: unknown } | { status: 302; location: string };
}

/** Nạp lại một dòng của sổ thu hồi sau khi restore. Trả true nếu có thay đổi. Không được ghi thêm vào sổ thu hồi. */
export type RevocationReplay = (ctx: Ctx, entry: JournalEntry) => boolean;

export interface ServerModule {
  /** Tên ngắn, duy nhất, chữ thường (ví dụ "messaging"); là khóa của phần mô-đun trong tệp xuất dữ liệu. */
  name: string;

  /** Route /v1 của mô-đun, cùng dạng và cùng đường xử lý với route lõi (xác thực, workspace, giới hạn tốc độ, schema, idempotency). */
  routes?: Route[];
  devRoutes?: DevRoute[];

  /** Mã lỗi mới → câu tiếng Việt mặc định. Thay cho việc sửa bảng MESSAGES trong src/core/errors.ts. */
  errors?: Record<string, string>;

  /** Loại tác vụ mới (xem KindSpec). */
  kinds?: KindSpec[];

  /**
   * Dữ liệu mẫu cho chế độ dev và kiểm thử. Chạy ở MỖI lần khởi động có seed, sau dữ liệu mẫu của lõi: phải tự kiểm đã có chưa
   * (seedDemo của lõi chỉ chạy một lần, thư mục dữ liệu cũ vẫn cần hàng mới). Không tên người thật.
   */
  seed?(ctx: Ctx): void;

  /** Việc định kỳ (dọn dữ liệu hết hạn…), chạy cuối mỗi vòng tick của app. `now` lấy từ đồng hồ tiêm được; không dùng Date.now(). */
  onTick?(ctx: Ctx, now: number): void | Promise<void>;

  /** Quyền của chủ thể dữ liệu (SRS mục 09). Các hook chạy đồng bộ trong giao dịch của thao tác lõi: không await, lỗi làm hỏng cả thao tác. */
  privacy?: {
    /** Phần dữ liệu phía máy chủ của một người trong tệp xuất, đặt tại `modules.<name>`. Không token, không khóa, không nội dung của người khác. */
    exportFor?(ctx: Ctx, ws: string, user: string): unknown;
    /** Xóa dữ liệu phía máy chủ của một người (yêu cầu DELETE). Lõi ghi tombstone member_deleted ngay sau đó. */
    deleteFor?(ctx: Ctx, ws: string, user: string, at: string): void;
    /** Một đồng ý vừa mất hiệu lực: rút lại, đổi sang từ chối, hoặc bị rút bởi RESTRICT/WITHDRAW. Không gọi khi DELETE (đã có deleteFor). */
    onConsentWithdrawn?(ctx: Ctx, ws: string, user: string, purpose: Purpose, at: string): void;
    /** Yêu cầu RESTRICT/WITHDRAW đã ghi nhận: dừng xử lý mới cho người đó. Gọi sau các onConsentWithdrawn của cùng yêu cầu. */
    onRestrict?(ctx: Ctx, ws: string, user: string, at: string): void;
  };

  /**
   * Nạp lại sổ thu hồi sau restore (SRS mục 21 bước 2), theo loại dòng. Dùng cho loại dòng của riêng mô-đun (ghi bằng
   * journalRevocation trong recovery.ts) và, nếu cần, để phản ứng thêm với loại của lõi: grant_revoked, consent_withdrawn,
   * binding_changed, member_deleted (chạy sau phần của lõi). Phải lặp lại an toàn.
   */
  revocations?: Record<string, RevocationReplay>;
}

/** Kiểm sổ đăng ký một lần khi dựng app: trùng tên, trùng route, trùng loại tác vụ là lỗi lập trình, không để tới lúc chạy. */
export function validateModules(modules: readonly ServerModule[], core: { routes: readonly Route[]; kinds: readonly string[] }) {
  const names = new Set<string>();
  const routes = new Set(core.routes.map((r) => `${r.method} ${r.path}`));
  const kinds = new Set(core.kinds);
  const dev = new Set(["/dev/users", "/dev/token"]);
  for (const m of modules) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(m.name)) throw new Error(`tên mô-đun không hợp lệ: ${m.name}`);
    if (names.has(m.name)) throw new Error(`mô-đun ${m.name} đăng ký hai lần`);
    names.add(m.name);
    for (const r of m.routes ?? []) {
      const k = `${r.method} ${r.path}`;
      if (!/^\/v[12]\//.test(r.path)) throw new Error(`mô-đun ${m.name}: route ${k} phải nằm dưới /v1/ hoặc /v2/`);
      if (routes.has(k)) throw new Error(`mô-đun ${m.name}: route ${k} đã có`);
      if (r.method === "POST" && (!r.schema || !r.readable)) throw new Error(`mô-đun ${m.name}: ${k} thiếu schema hoặc readable`);
      routes.add(k);
    }
    for (const r of m.devRoutes ?? []) {
      if (!/^\/dev\/[a-z0-9/_-]{1,80}$/.test(r.path) || dev.has(r.path)) throw new Error(`mô-đun ${m.name}: đường dev ${r.path} không hợp lệ hoặc đã có`);
      dev.add(r.path);
    }
    for (const k of m.kinds ?? []) {
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(k.kind)) throw new Error(`mô-đun ${m.name}: tên loại tác vụ không hợp lệ: ${k.kind}`);
      if (kinds.has(k.kind)) throw new Error(`mô-đun ${m.name}: loại tác vụ ${k.kind} đã có`);
      kinds.add(k.kind);
    }
  }
}

// Mỗi mô-đun có mốc riêng để các nhánh làm song song không sửa cùng một dòng. Thêm mô-đun khác: thêm một cặp mốc mới ở cuối.
// Thiết bị theo dõi không có mô-đun máy chủ (LNH-T53: máy chủ không có API nào về thiết bị theo dõi); nó chỉ có cờ `trackers`.
// ── nhắn tin và «Thiết bị của tôi»: dòng import đặt ngay dưới dòng này ──
import { messaging } from "./messaging.ts";
// ── mạng xã hội: dòng import đặt ngay dưới dòng này ──
// ── V1.0.1 đồng bộ bản nháp và phiên thiết bị: dòng import đặt ngay dưới dòng này ──
import { sync } from "./sync.ts";
// ── V1.0.1 Hộp tổng hợp: dòng import đặt ngay dưới dòng này ──
import { inbox } from "./inbox.ts";
// ── V1.0.1 Le‑NodeHome và HaaS: dòng import đặt ngay dưới dòng này ──
import { homehub } from "./homehub.ts";
// ── V1.0.1 Le‑NodeHealth phép đo: dòng import đặt ngay dưới dòng này ──
import { measurements } from "./measurements.ts";
// ── V1.0.1 cổng mô phỏng Le‑ORION: dòng import đặt ngay dưới dòng này ──
import { sim } from "./sim.ts";

/** Thứ tự trong mảng là thứ tự so khớp route (route lõi luôn trước) và thứ tự gọi hook. */
export const MODULES: ServerModule[] = [
  // ── nhắn tin và «Thiết bị của tôi»: một dòng đặt ngay dưới dòng này ──
  messaging,
  // ── mạng xã hội: một dòng đặt ngay dưới dòng này ──
  // ── V1.0.1 đồng bộ bản nháp và phiên thiết bị: một dòng đặt ngay dưới dòng này ──
  sync,
  // ── V1.0.1 Hộp tổng hợp: một dòng đặt ngay dưới dòng này ──
  inbox,
  // ── V1.0.1 Le‑NodeHome và HaaS: một dòng đặt ngay dưới dòng này ──
  homehub,
  // ── V1.0.1 Le‑NodeHealth phép đo: một dòng đặt ngay dưới dòng này ──
  measurements,
  // ── V1.0.1 cổng mô phỏng Le‑ORION: một dòng đặt ngay dưới dòng này ──
  sim,
];
