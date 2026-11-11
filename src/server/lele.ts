// LeLe trong LeNhip (SRS mục 04, 10, 24; MG01, AI01). LeLe chỉ sinh IntentProposal hoặc nội dung; người dùng xác nhận qua plan,
// worker mới là chủ thể thực thi. Model Gateway: allowlist nhà cung cấp theo VendorProfile (G0 chưa duyệt nhà cung cấp nào, nên
// mặc định dùng bộ quy tắc cục bộ), chặn mặc định nội dung sức khỏe/cá nhân, đầu vào ≤16 KiB, đầu ra ≤8 KiB, timeout 15 giây, sửa
// schema tối đa một lần, sai tiếp thì trả form. Tài liệu, kết quả công cụ và câu trả lời của mô hình là dữ liệu không tin cậy.
import { parseInstant, zonedToInstant, localDate, addDays } from "../../web/shared/zone.js";
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

export interface LeLeResult {
  type: "PROPOSAL" | "ANSWER" | "FORM";
  engine: string;
  ai_generated: boolean;
  proposal: { kind: "calendar.block" | "device.set_power"; args: Record<string, unknown>; summary: string } | null;
  answer: string | null;
  fallback: "calendar.block" | "device.set_power" | "NONE" | null;
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

const HEALTH = /(ngủ|giấc|bước chân|nhịp tim|huyết áp|bệnh|thuốc|khám|sức khỏe|sức khoẻ|cân nặng|đường huyết|stress|trầm cảm|kinh nguyệt)/i;
const PII = /(\b\d{9,12}\b|\b0\d{9}\b|[\w.+-]+@[\w-]+\.[\w.]+|\bcccd\b|\bcmnd\b)/i;

const HELP = "LeLe có thể soạn đề xuất dành thời gian cá nhân trong lịch công việc (ví dụ \"dành 30 phút lúc 15:00\") hoặc bật/tắt đèn đã đăng ký (\"bật đèn bàn\"). Bạn xem lại và xác nhận trước khi LeNhip làm.";

/** Bộ quy tắc cục bộ: không gọi mạng, không dùng mô hình. Trả JSON như một nhà cung cấp. */
export class LocalRulesProvider implements ModelProvider {
  readonly id = "local-rules";
  readonly external = false;
  async propose(i: ProviderInput): Promise<string> {
    const t = i.text.toLocaleLowerCase("vi").normalize("NFC");
    const power = /\b(bật|mở|tắt)\b/.exec(t);
    if (power && /đèn/.test(t)) {
      const on = power[1] !== "tắt";
      const named = i.devices.find((d) => t.includes(d.name.toLocaleLowerCase("vi"))) ?? (i.devices.length === 1 ? i.devices[0] : undefined);
      if (!named) return JSON.stringify({ type: "FORM", fallback: "device.set_power", answer: "Chọn đèn trong Ngôi nhà rồi xác nhận." });
      return JSON.stringify({
        type: "PROPOSAL",
        proposal: { kind: "device.set_power", args: { site: named.site, device_ref: named.device_ref, command: on ? "SET_ON" : "SET_OFF" }, summary: `${on ? "Bật" : "Tắt"} ${named.name}` },
      });
    }
    const dur = /(\d{1,3})\s*(phút|giờ|tiếng)/.exec(t);
    const at = /(?:lúc|vào|từ)\s*(\d{1,2})(?:[:h](\d{2}))?/.exec(t);
    if (dur && at && /(dành|giữ|đặt|chặn|block|tập trung|cá nhân)/.test(t)) {
      const minutes = Number(dur[1]) * (dur[2] === "phút" ? 1 : 60);
      const hh = Number(at[1]);
      const mm = Number(at[2] ?? 0);
      if (minutes < 5 || minutes > 240 || hh > 23 || mm > 59) return JSON.stringify({ type: "FORM", fallback: "calendar.block", answer: "Khung giờ cần dài 5–240 phút." });
      const now = parseInstant(i.now);
      const day = /ngày mai/.test(t) ? addDays(localDate(now, i.zone), 1) : localDate(now, i.zone);
      const start = zonedToInstant(day, `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, i.zone);
      return JSON.stringify({
        type: "PROPOSAL",
        proposal: {
          kind: "calendar.block",
          args: { calendar_ref: "primary", start: new Date(start).toISOString(), end: new Date(start + minutes * 60_000).toISOString(), zone: i.zone, title_code: "PERSONAL_TIME", visibility: "private" },
          summary: `Dành ${minutes} phút thời gian cá nhân lúc ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}${/ngày mai/.test(t) ? " ngày mai" : ""}`,
        },
      });
    }
    return JSON.stringify({ type: "ANSWER", answer: HELP });
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

  private form(fallback: LeLeResult["fallback"], answer: string): LeLeResult {
    return { type: "FORM", engine: this.provider.id, ai_generated: false, proposal: null, answer, fallback };
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
      return { ok: { type: "ANSWER", engine: this.provider.id, ai_generated: this.provider.external, proposal: null, answer: v.answer, fallback: null } };
    }
    if (v.type === "FORM") {
      const fb = v.fallback === "calendar.block" || v.fallback === "device.set_power" ? v.fallback : "NONE";
      return { ok: this.form(fb, typeof v.answer === "string" ? v.answer.slice(0, 300) : "Dùng form để tạo thao tác.") };
    }
    const p = v.proposal as { kind?: string; args?: unknown; summary?: unknown } | undefined;
    const issues = this.schemas.validate("IntentProposal", p).map((x) => `${x.path} ${x.rule}`);
    if (issues.length) return { issues };
    const plan = { kind: p?.kind, schema_version: 1, workspace_ref: input.workspace_ref, args: p?.args };
    const planIssues = this.schemas.validate("PlanInput", plan).map((x) => `${x.path} ${x.rule}`);
    if (planIssues.length) return { issues: planIssues };
    const proposal = p as LeLeResult["proposal"];
    return { ok: { type: "PROPOSAL", engine: this.provider.id, ai_generated: this.provider.external, proposal, answer: proposal?.summary ?? null, fallback: null } };
  }

  async propose(input: ProviderInput): Promise<LeLeResult> {
    if (Buffer.byteLength(input.text, "utf8") > this.limits.inputBytes) return this.form("NONE", "Nội dung quá dài.");
    // Chặn mặc định: không gửi nội dung sức khỏe hay dữ liệu cá nhân ra khỏi miền (SRS mục 24).
    if (HEALTH.test(input.text)) return this.form("NONE", "Câu hỏi về sức khỏe được xử lý trên điện thoại, không gửi tới LeLe trong miền công việc.");
    if (PII.test(input.text)) return this.form("NONE", "Nội dung có thông tin cá nhân; hãy dùng form thay vì gửi cho LeLe.");
    let raw: string | "TIMEOUT";
    try {
      raw = await timeout(this.provider.propose(input), this.limits.timeoutMs);
    } catch {
      return this.form("NONE", "LeLe chưa trả lời được; dùng form.");
    }
    if (raw === "TIMEOUT") return this.form("NONE", "LeLe quá thời gian; dùng form.");
    const first = this.check(raw, input);
    if ("ok" in first) return first.ok;
    if (!this.provider.repair) return this.form("NONE", "Đề xuất không đúng hợp đồng; dùng form.");
    let fixed: string | "TIMEOUT";
    try {
      fixed = await timeout(this.provider.repair(input, raw, first.issues), this.limits.timeoutMs);
    } catch {
      return this.form("NONE", "LeLe chưa sửa được đề xuất; dùng form.");
    }
    if (fixed === "TIMEOUT") return this.form("NONE", "LeLe quá thời gian; dùng form.");
    const second = this.check(fixed, input);
    return "ok" in second ? second.ok : this.form("NONE", "Đề xuất vẫn sai hợp đồng; dùng form.");
  }
}
