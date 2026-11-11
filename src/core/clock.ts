// Đồng hồ tiêm được: mọi hạn (120 giây duyệt, 120 giây phát, 30 giây permit, SLA của UNKNOWN) đọc từ đây để kiểm thử
// được mà không chờ thật.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  private t: number;
  constructor(start: number | string) {
    this.t = typeof start === "string" ? Date.parse(start) : start;
  }
  now() {
    return this.t;
  }
  set(t: number | string) {
    this.t = typeof t === "string" ? Date.parse(t) : t;
  }
  advance(ms: number) {
    this.t += ms;
    return this.t;
  }
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
