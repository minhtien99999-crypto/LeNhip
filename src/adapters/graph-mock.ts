// Microsoft Graph giả lập cho staging và kiểm thử (SRS mục 22, T11): lịch primary của từng tài khoản liên kết, calendarView,
// tạo event có transactionId (trùng transactionId trả event cũ như Graph), đọc lại theo ID, và các lỗi có chủ đích: treo, mất
// phản hồi sau khi đã tạo, 400, 429 Retry-After, client thứ hai chèn cuộc hẹn giữa lúc kiểm và lúc tạo. Không gọi mạng.
import { randomUUID } from "node:crypto";

export interface GraphEvent {
  id: string;
  transactionId: string | null;
  subject: string;
  start: string;
  end: string;
  showAs: "busy" | "free" | "tentative" | "oof";
  sensitivity: "private" | "normal";
  createdBy: "lenhip" | "other";
}

export type Throttled = { throttled: true; retryAfterMs: number };

export interface GraphClient {
  calendarView(account: string, start: string, end: string): Promise<{ events: GraphEvent[] } | Throttled>;
  createEvent(account: string, body: Omit<GraphEvent, "id" | "createdBy">): Promise<{ id: string } | { status: number; error: string }>;
  getEvent(account: string, id: string): Promise<GraphEvent | null | Throttled>;
}

export type PostFault = "ok" | "hang" | "lose_response" | "reject_400" | "network_error";

export class MockGraph implements GraphClient {
  readonly calendars = new Map<string, GraphEvent[]>();
  faults: { post: PostFault; throttleReads: number; retryAfterMs: number; beforeCreate: ((account: string) => void) | null } = {
    post: "ok", throttleReads: 0, retryAfterMs: 2000, beforeCreate: null,
  };
  calls = { calendarView: 0, createEvent: 0, getEvent: 0 };
  private hung: (() => void)[] = [];

  events(account: string) {
    let c = this.calendars.get(account);
    if (!c) this.calendars.set(account, (c = []));
    return c;
  }

  /** Cuộc hẹn của người khác (client thứ hai, Outlook...): LeNhip không thấy tiêu đề qua API của mình. */
  addMeeting(account: string, start: string, end: string, subject = "Cuộc họp") {
    const e: GraphEvent = { id: `evt_${randomUUID()}`, transactionId: null, subject, start, end, showAs: "busy", sensitivity: "normal", createdBy: "other" };
    this.events(account).push(e);
    return e;
  }

  /** Giải phóng các lời gọi đang treo (kiểm thử). */
  release() {
    for (const h of this.hung.splice(0)) h();
  }

  async calendarView(account: string, start: string, end: string) {
    this.calls.calendarView++;
    if (this.faults.throttleReads > 0) {
      this.faults.throttleReads--;
      return { throttled: true as const, retryAfterMs: this.faults.retryAfterMs };
    }
    const s = Date.parse(start);
    const e = Date.parse(end);
    return { events: this.events(account).filter((x) => Date.parse(x.start) < e && s < Date.parse(x.end)).map((x) => ({ ...x })) };
  }

  async getEvent(account: string, id: string) {
    this.calls.getEvent++;
    if (this.faults.throttleReads > 0) {
      this.faults.throttleReads--;
      return { throttled: true as const, retryAfterMs: this.faults.retryAfterMs };
    }
    const e = this.events(account).find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  async createEvent(account: string, body: Omit<GraphEvent, "id" | "createdBy">) {
    this.calls.createEvent++;
    this.faults.beforeCreate?.(account);
    const fault = this.faults.post;
    if (fault === "reject_400") return { status: 400, error: "ErrorInvalidRequest" };
    if (fault === "network_error") throw new Error("ECONNRESET");
    const list = this.events(account);
    let ev = body.transactionId ? list.find((x) => x.transactionId === body.transactionId) : undefined;
    if (!ev) {
      ev = { ...body, id: `evt_${randomUUID()}`, createdBy: "lenhip" };
      list.push(ev);
    }
    const id = ev.id;
    if (fault === "hang" || fault === "lose_response") {
      // Event đã được tạo nhưng phản hồi không về (treo tới khi kiểm thử giải phóng, rồi mất hẳn).
      return new Promise<{ id: string }>((resolve, reject) => {
        this.hung.push(() => (fault === "hang" ? resolve({ id }) : reject(new Error("response lost"))));
      });
    }
    return { id };
  }
}
