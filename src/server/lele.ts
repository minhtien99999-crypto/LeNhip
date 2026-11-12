// LeLe trong LeNhip (SRS mục 04, 10, 24; MG01, AI01). LeLe chỉ sinh IntentProposal hoặc nội dung; người dùng xác nhận qua plan,
// worker mới là chủ thể thực thi. Model Gateway: allowlist nhà cung cấp theo VendorProfile (G0 chưa duyệt nhà cung cấp nào, nên
// mặc định dùng bộ quy tắc cục bộ), chặn mặc định nội dung sức khỏe/cá nhân, đầu vào ≤16 KiB, đầu ra ≤8 KiB, timeout 15 giây, sửa
// schema tối đa một lần, sai tiếp thì trả form. Tài liệu, kết quả công cụ và câu trả lời của mô hình là dữ liệu không tin cậy.
// V1.0.0 (LNH-T23, LNH-T24): máy chủ không biết ngôn ngữ của người dùng. Mỗi câu trả lời mang `answer_code` để thiết bị dựng
// câu theo ngôn ngữ của mình; `answer` và `proposal.summary` tiếng Việt giữ cho client cũ. Phép chặn sức khỏe và dữ liệu cá
// nhân dùng chung bảng từ 13 ngôn ngữ với thiết bị (web/shared/lele-lexicon.js) và chạy trước mọi xử lý; câu chữ không được lưu.
import { parseInstant, zonedToInstant, localDate, addDays } from "../../web/shared/zone.js";
import { scanLele, leleBlock, normalizeLele } from "../../web/shared/lele-lexicon.js";
import { parseStrictJson } from "../core/strict-json.ts";
import type { SchemaSet } from "../core/schema.ts";

export interface ModelProvider {
  readonly id: string;
  readonly external: boolean;
  propose(input: ProviderInput): Promise<string>;
  repair?(input: ProviderInput, previous: string, issues: string[]): Promise<string>;
}

export interface ProviderInput {
  text: string;
  context: "work" | "home";
  zone: string;
  now: string;
  workspace_ref: string;
  devices: { site: string; device_ref: string; name: string }[];
}

/** Mã của mọi câu trả lời không phải đề xuất (enum `answer_code` của LeLeResult trong OpenAPI) và câu tiếng Việt cho client cũ. */
export const ANSWERS = {
  HELP: "LeLe có thể soạn đề xuất dành thời gian cá nhân trong lịch công việc (ví dụ \"dành 30 phút lúc 15:00\") hoặc bật/tắt đèn đã đăng ký (\"bật đèn bàn\"). Bạn xem lại và xác nhận trước khi LeNhip làm.",
  PICK_LAMP: "Chọn đèn trong Ngôi nhà rồi xác nhận.",
  DURATION_RANGE: "Khung giờ cần dài 5–240 phút.",
  USE_FORM: "Dùng form để tạo thao tác.",
  TOO_LONG: "Nội dung quá dài.",
  HEALTH_LOCAL: "Câu hỏi về sức khỏe được xử lý trên điện thoại, không gửi tới LeLe trong miền công việc.",
  PII_BLOCKED: "Nội dung có thông tin cá nhân; hãy dùng form thay vì gửi cho LeLe.",
  UNAVAILABLE: "LeLe chưa trả lời được; dùng form.",
  TIMEOUT: "LeLe quá thời gian; dùng form.",
  INVALID_PROPOSAL: "Đề xuất không đúng hợp đồng; dùng form.",
} as const;
export type AnswerCode = keyof typeof ANSWERS;
const answerCode = (v: unknown): AnswerCode | null => (typeof v === "string" && Object.hasOwn(ANSWERS, v) ? (v as AnswerCode) : null);

export interface LeLeResult {
  type: "PROPOSAL" | "ANSWER" | "FORM";
  engine: string;
  ai_generated: boolean;
  proposal: { kind: "calendar.block" | "device.set_power"; args: Record<string, unknown>; summary: string } | null;
  answer: string | null;
  fallback: "calendar.block" | "device.set_power" | "NONE" | null;
  /** Mã của `answer` để thiết bị dựng câu theo ngôn ngữ của mình; null với đề xuất và với câu do nhà cung cấp tự viết. */
  answer_code: AnswerCode | null;
}

/** Nhà cung cấp mô hình chỉ được bật khi có VendorProfile đã duyệt ở G0 (mục đích, vùng, retention, không huấn luyện...). */
export interface VendorProfile {
  provider: string;
  model: string;
  region: string;
  purposes: string[];
  retention_days: number;
  no_training: boolean;
  dpa_ref: string;
  approved_by: string;
}
export const VENDOR_PROFILES: VendorProfile[] = [];

/**
 * Bộ quy tắc cục bộ: không gọi mạng, không dùng mô hình. Trả JSON như một nhà cung cấp. Nhận lệnh đèn và lệnh khung giờ của
 * 13 ngôn ngữ theo bảng từ dùng chung với thiết bị (LNH-T24); tên đèn là dữ liệu của site nên được so nguyên văn.
 */
export class LocalRulesProvider implements ModelProvider {
  readonly id = "local-rules";
  readonly external = false;
  async propose(i: ProviderInput): Promise<string> {
    const scan = scanLele(i.text);
    const intent = scan.intent;
    if (intent?.kind === "device.set_power") {
      const on = intent.command === "SET_ON";
      const named = i.devices.find((d) => scan.norm.includes(normalizeLele(d.name))) ?? (i.devices.length === 1 ? i.devices[0] : undefined);
      if (!named) return JSON.stringify({ type: "FORM", fallback: "device.set_power", answer: ANSWERS.PICK_LAMP, answer_code: "PICK_LAMP" });
      return JSON.stringify({
        type: "PROPOSAL",
        proposal: { kind: "device.set_power", args: { site: named.site, device_ref: named.device_ref, command: intent.command }, summary: `${on ? "Bật" : "Tắt"} ${named.name}` },
      });
    }
    if (intent?.kind === "calendar.block") {
      const { minutes, tomorrow } = intent;
      if (minutes < 5 || minutes > 240) return JSON.stringify({ type: "FORM", fallback: "calendar.block", answer: ANSWERS.DURATION_RANGE, answer_code: "DURATION_RANGE" });
      const at = `${String(intent.hour).padStart(2, "0")}:${String(intent.minute).padStart(2, "0")}`;
      const now = parseInstant(i.now);
      const day = tomorrow ? addDays(localDate(now, i.zone), 1) : localDate(now, i.zone);
      const start = zonedToInstant(day, at, i.zone);
      return JSON.stringify({
        type: "PROPOSAL",
        proposal: {
          kind: "calendar.block",
          args: { calendar_ref: "primary", start: new Date(start).toISOString(), end: new Date(start + minutes * 60_000).toISOString(), zone: i.zone, title_code: "PERSONAL_TIME", visibility: "private" },
          summary: `Dành ${minutes} phút thời gian cá nhân lúc ${at}${tomorrow ? " ngày mai" : ""}`,
        },
      });
    }
    return JSON.stringify({ type: "ANSWER", answer: ANSWERS.HELP, answer_code: "HELP" });
  }
}

const timeout = <T>(p: Promise<T>, ms: number) =>
  new Promise<T | "TIMEOUT">((resolve, reject) => {
    const t = setTimeout(() => resolve("TIMEOUT"), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });

export class ModelGateway {
  private readonly provider: ModelProvider;
  private readonly schemas: SchemaSet;
  private readonly limits: { inputBytes: number; outputBytes: number; timeoutMs: number };
  constructor(provider: ModelProvider, schemas: SchemaSet, limits: { inputBytes: number; outputBytes: number; timeoutMs: number }) {
    if (provider.external && !VENDOR_PROFILES.some((v) => v.provider === provider.id)) throw new Error(`nhà cung cấp ${provider.id} chưa có VendorProfile được duyệt`);
    this.provider = provider;
    this.schemas = schemas;
    this.limits = limits;
  }

  /** Câu trả lời dạng form theo mã; `answer` là câu tiếng Việt của mã đó (hoặc câu riêng truyền vào) cho client cũ. */
  private form(fallback: LeLeResult["fallback"], code: AnswerCode | null, answer: string = code ? ANSWERS[code] : ANSWERS.USE_FORM): LeLeResult {
    return { type: "FORM", engine: this.provider.id, ai_generated: false, proposal: null, answer, fallback, answer_code: code };
  }

  /**
   * Phép chặn chạy TRƯỚC mọi xử lý (LNH-T24): quá dài, có từ sức khỏe hoặc dữ liệu cá nhân của bất kỳ ngôn ngữ nào trong 13
   * ngôn ngữ thì trả lời ngay bằng mã, không tra cứu gì, không gọi nhà cung cấp, không ghi câu chữ vào đâu. Trả null khi câu
   * được đi tiếp. Nhà cung cấp ngoài miền còn bị đóng chặt hơn: câu không phải lệnh đèn hay lệnh khung giờ thì không được gửi.
   */
  screen(text: string): LeLeResult | null {
    if (Buffer.byteLength(text, "utf8") > this.limits.inputBytes) return this.form("NONE", "TOO_LONG");
    const scan = scanLele(text);
    const blocked = leleBlock(scan);
    if (blocked === "HEALTH") return this.form("NONE", "HEALTH_LOCAL");
    if (blocked === "PII") return this.form("NONE", "PII_BLOCKED");
    if (this.provider.external && !scan.intent) return { type: "ANSWER", engine: "local-rules", ai_generated: false, proposal: null, answer: ANSWERS.HELP, fallback: null, answer_code: "HELP" };
    return null;
  }

  /** Kiểm đầu ra: JSON chặt, ≤8 KiB, đúng IntentProposal và tham số đúng PlanInput của loại đó. */
  private check(raw: string, input: ProviderInput): { ok: LeLeResult } | { issues: string[] } {
    if (Buffer.byteLength(raw, "utf8") > this.limits.outputBytes) return { issues: ["output quá 8 KiB"] };
    let v: Record<string, unknown>;
    try {
      v = parseStrictJson(raw, 8) as Record<string, unknown>;
    } catch (e) {
      return { issues: [`json: ${(e as Error).message}`] };
    }
    if (!v || typeof v !== "object") return { issues: ["không phải đối tượng"] };
    if (v.type === "ANSWER" && typeof v.answer === "string" && v.answer.length <= 600) {
      return { ok: { type: "ANSWER", engine: this.provider.id, ai_generated: this.provider.external, proposal: null, answer: v.answer, fallback: null, answer_code: answerCode(v.answer_code) } };
    }
    if (v.type === "FORM") {
      const fb = v.fallback === "calendar.block" || v.fallback === "device.set_power" ? v.fallback : "NONE";
      // Câu do nhà cung cấp tự viết mà không kèm mã hợp lệ thì không có mã: thiết bị ngôn ngữ khác in câu chung của nó.
      if (typeof v.answer === "string") return { ok: this.form(fb, answerCode(v.answer_code), v.answer.slice(0, 300)) };
      return { ok: this.form(fb, "USE_FORM") };
    }
    const p = v.proposal as { kind?: string; args?: unknown; summary?: unknown } | undefined;
    const issues = this.schemas.validate("IntentProposal", p).map((x) => `${x.path} ${x.rule}`);
    if (issues.length) return { issues };
    const plan = { kind: p?.kind, schema_version: 1, workspace_ref: input.workspace_ref, args: p?.args };
    const planIssues = this.schemas.validate("PlanInput", plan).map((x) => `${x.path} ${x.rule}`);
    if (planIssues.length) return { issues: planIssues };
    const proposal = p as LeLeResult["proposal"];
    return { ok: { type: "PROPOSAL", engine: this.provider.id, ai_generated: this.provider.external, proposal, answer: proposal?.summary ?? null, fallback: null, answer_code: null } };
  }

  async propose(input: ProviderInput): Promise<LeLeResult> {
    // Chặn mặc định: không gửi nội dung sức khỏe hay dữ liệu cá nhân ra khỏi miền (SRS mục 24).
    const screened = this.screen(input.text);
    if (screened) return screened;
    let raw: string | "TIMEOUT";
    try {
      raw = await timeout(this.provider.propose(input), this.limits.timeoutMs);
    } catch {
      return this.form("NONE", "UNAVAILABLE");
    }
    if (raw === "TIMEOUT") return this.form("NONE", "TIMEOUT");
    const first = this.check(raw, input);
    if ("ok" in first) return first.ok;
    if (!this.provider.repair) return this.form("NONE", "INVALID_PROPOSAL");
    let fixed: string | "TIMEOUT";
    try {
      fixed = await timeout(this.provider.repair(input, raw, first.issues), this.limits.timeoutMs);
    } catch {
      return this.form("NONE", "UNAVAILABLE", "LeLe chưa sửa được đề xuất; dùng form.");
    }
    if (fixed === "TIMEOUT") return this.form("NONE", "TIMEOUT");
    const second = this.check(fixed, input);
    return "ok" in second ? second.ok : this.form("NONE", "INVALID_PROPOSAL", "Đề xuất vẫn sai hợp đồng; dùng form.");
  }
}
