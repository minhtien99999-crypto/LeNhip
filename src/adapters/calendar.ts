// Calendar adapter (SRS mục 22, CAL01): Microsoft Graph v1.0, quyền delegated Calendars.ReadWrite, chỉ lịch primary của tài
// khoản liên kết, không attendees. Event có tiêu đề cố định, sensitivity=private, showAs=busy, giờ UTC, transactionId ổn định
// theo action. Kiểm bận ngay trước ghi; đọc lại theo ID hoặc calendarView hẹp + transactionId; không bao giờ tự POST lại sau kết
// quả mơ hồ. Credential (refresh token) nằm trong vault của adapter, không ở app hay sổ.
import type { ActionRow } from "../server/machine.ts";
import type { Ctx } from "../server/context.ts";
import type { DispatchAdapter, Evidence, ExecResult, Precheck, Readback } from "../server/receiver.ts";
import { all } from "../server/store.ts";
import type { GraphClient, GraphEvent } from "./graph-mock.ts";

export const CALENDAR_AUDIENCE = "lenhip:calendar-adapter";
export const TITLE: Record<string, string> = { PERSONAL_TIME: "Thời gian cá nhân" };

interface CalPayload {
  start: string;
  end: string;
  title_code: string;
  target: { account: string };
}

export class CalendarAdapter implements DispatchAdapter {
  readonly kind = "calendar.block" as const;
  readonly ackTimeoutMs: number;
  readonly unknownAfterMs: number;
  readonly readsAtMs = [0, 5_000, 10_000, 20_000, 30_000];
  private readonly ctx: Ctx;
  readonly graph: GraphClient;

  constructor(ctx: Ctx, graph: GraphClient) {
    this.ctx = ctx;
    this.graph = graph;
    this.ackTimeoutMs = ctx.config.calendar.ackTimeoutMs;
    this.unknownAfterMs = ctx.config.calendar.unknownAfterMs;
  }

  audience() {
    return CALENDAR_AUDIENCE;
  }
  servesAudience(aud: string) {
    return aud === CALENDAR_AUDIENCE;
  }

  private ev(data: Record<string, unknown>): Evidence {
    return { grade: "PROVIDER_READBACK", source: "graph:v1.0", observed_at: new Date(this.ctx.clock.now()).toISOString(), data };
  }

  private p(row: ActionRow) {
    return JSON.parse(row.payload) as CalPayload;
  }

  /** Cuộc hẹn khác (không phải event của chính action này) chồng khoảng [start, end). */
  private others(events: GraphEvent[], row: ActionRow) {
    return events.filter((e) => e.transactionId !== row.transaction_id && e.showAs !== "free");
  }

  async precheck(row: ActionRow): Promise<Precheck> {
    const p = this.p(row);
    const view = await this.graph.calendarView(p.target.account, p.start, p.end);
    if ("throttled" in view) return { result: "UNAVAILABLE", reason: "PROVIDER_THROTTLED", evidence: this.ev({ throttled: true }) };
    const busy = this.others(view.events, row);
    if (busy.length) return { result: "BUSY", evidence: this.ev({ overlaps: busy.length, event_created: false }) };
    return { result: "CLEAR" };
  }

  async execute(row: ActionRow): Promise<ExecResult> {
    const p = this.p(row);
    const r = await this.graph.createEvent(p.target.account, {
      transactionId: row.transaction_id, subject: TITLE[p.title_code] ?? "Thời gian cá nhân", start: p.start, end: p.end, showAs: "busy", sensitivity: "private",
    });
    if ("status" in r) return { result: "NO_EFFECT", reason: `PROVIDER_REJECTED_${r.status}`, evidence: this.ev({ status: r.status }) };
    return { result: "ACK", provider_ref: r.id };
  }

  /** provider_ref có thể nằm ở action (ACK đúng hạn) hoặc chỉ ở receipt (ACK trễ sau khi đã UNKNOWN). */
  private providerRef(row: ActionRow) {
    if (row.provider_ref) return row.provider_ref;
    const r = all<{ provider_ref: string | null }>(this.ctx.db, "SELECT provider_ref FROM receipts WHERE plan_id = ? AND provider_ref IS NOT NULL", row.id);
    return r[0]?.provider_ref ?? null;
  }

  async readback(row: ActionRow): Promise<Readback> {
    const p = this.p(row);
    let id = this.providerRef(row);
    let event: GraphEvent | null = null;
    if (id) {
      const got = await this.graph.getEvent(p.target.account, id);
      if (got && "throttled" in got) return { result: "UNDETERMINED", retryAfterMs: got.retryAfterMs, note: "429" };
      event = got;
      if (!event) return { result: "CONFLICT", evidence: this.ev({ provider_ref: id, found: false }), event_created: true, outcome: "EVENT_CHANGED" };
    } else {
      // Không có ID: tìm trong cửa sổ hẹp theo transactionId; chỉ kết luận khi xác định được duy nhất.
      const view = await this.graph.calendarView(p.target.account, p.start, p.end);
      if ("throttled" in view) return { result: "UNDETERMINED", retryAfterMs: view.retryAfterMs, note: "429" };
      const mine = view.events.filter((e) => e.transactionId === row.transaction_id);
      if (mine.length !== 1) return { result: "UNDETERMINED", note: mine.length ? "nhiều event cùng transactionId" : "chưa thấy event" };
      event = mine[0];
      id = event.id;
    }
    const fieldsOk = event.start === p.start && event.end === p.end && event.showAs === "busy" && event.sensitivity === "private" && event.subject === (TITLE[p.title_code] ?? event.subject);
    if (!fieldsOk) return { result: "CONFLICT", evidence: this.ev({ provider_ref: id, fields: "changed" }), event_created: true, outcome: "EVENT_CHANGED" };
    const view = await this.graph.calendarView(p.target.account, p.start, p.end);
    if ("throttled" in view) return { result: "UNDETERMINED", retryAfterMs: view.retryAfterMs, note: "429" };
    const overlaps = this.others(view.events, row);
    if (overlaps.length) return { result: "CONFLICT", evidence: this.ev({ provider_ref: id, overlaps: overlaps.length }), event_created: true, outcome: "OVERLAP_AFTER_CREATE" };
    return { result: "MATCH", evidence: this.ev({ provider_ref: id, fields: "ok", overlaps: 0 }), provider_ref: id, outcome: "EVENT_CREATED" };
  }

  /** GET /calendar/availability: bận/trống của chính lịch được cấp, không tiêu đề, không khách (SRS mục 15). */
  async availability(account: string, start: string, end: string) {
    const view = await this.graph.calendarView(account, start, end);
    if ("throttled" in view) return view;
    const s = Date.parse(start);
    const e = Date.parse(end);
    const busy = view.events
      .filter((x) => x.showAs !== "free")
      .map((x) => [Math.max(s, Date.parse(x.start)), Math.min(e, Date.parse(x.end))] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const b of busy) {
      const last = merged[merged.length - 1];
      if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
      else merged.push([...b]);
    }
    const free: [number, number][] = [];
    let cursor = s;
    for (const [bs, be] of merged) {
      if (bs > cursor) free.push([cursor, bs]);
      cursor = Math.max(cursor, be);
    }
    if (cursor < e) free.push([cursor, e]);
    const iso = (n: number) => new Date(n).toISOString();
    return { busy: merged.map(([a, b]) => ({ start: iso(a), end: iso(b) })), free: free.map(([a, b]) => ({ start: iso(a), end: iso(b) })) };
  }
}
