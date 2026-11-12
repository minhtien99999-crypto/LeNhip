// @ts-check
// Phần sức khỏe của Bản tóm tắt buổi sáng (LNH-T62), thuần: không DOM, không mạng, không lưu. Đầu vào là bản tổng hợp app.js đã tính
// trên thiết bị (computeHealthDays của web/shared/sleep.js); kết quả chỉ được vẽ vào trang. Kiểm trên Node ở tests/sync.test.ts.

/**
 * Trạng thái phần sức khỏe của bản tóm tắt, thuần (kiểm trên Node).
 * @param {{ consent: "granted" | "declined" | "withdrawn" | "none", health: any }} local  health: { days: [{ sleep_seconds, steps }…] }, ngày cuối là hôm nay
 * @returns {{ state: "data" | "missing" | "unavailable" | "withdrawn" | "off", sleepSeconds: number | null, steps: number | null }}
 */
export function briefHealth(local) {
  const none = { sleepSeconds: null, steps: null };
  if (local?.consent === "withdrawn") return { state: "withdrawn", ...none };
  if (local?.consent !== "granted") return { state: "off", ...none };
  const days = local.health?.days;
  if (!Array.isArray(days) || days.length < 2) return { state: "unavailable", ...none };
  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  const sleepSeconds = Number.isFinite(today?.sleep_seconds) ? today.sleep_seconds : null;
  const steps = Number.isFinite(yesterday?.steps) ? yesterday.steps : null;
  return { state: sleepSeconds === null && steps === null ? "missing" : "data", sleepSeconds, steps };
}
