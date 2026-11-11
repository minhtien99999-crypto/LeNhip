// Lỗi chuẩn của API /v1 (SRS mục 15): code, message chung, request_id của miền, retryable. EXECUTION_UNKNOWN không bao giờ là
// lỗi HTTP: nó nằm trong tài nguyên action đã nhận.

export const MESSAGES: Record<string, string> = {
  SCHEMA_INVALID: "Yêu cầu không đúng hợp đồng.",
  DUPLICATE_KEY: "Yêu cầu có khóa JSON trùng.",
  BODY_TOO_LARGE: "Yêu cầu quá lớn.",
  UNSUPPORTED_MEDIA_TYPE: "Chỉ nhận application/json.",
  UNAUTHENTICATED: "Cần đăng nhập lại.",
  REAUTH_REQUIRED: "Cần xác thực lại trước thao tác này.",
  FORBIDDEN: "Không có quyền với thao tác này.",
  NOT_FOUND: "Không tìm thấy.",
  PLAN_STALE: "Quyền hoặc chính sách đã thay đổi; cần lập kế hoạch mới.",
  DIGEST_MISMATCH: "Nội dung xác nhận khác nội dung đã chuẩn hóa.",
  REQUEST_IN_PROGRESS: "Yêu cầu cùng khóa đang được xử lý.",
  IDEMPOTENCY_CONFLICT: "Khóa chống lặp đã dùng cho nội dung khác.",
  IDEMPOTENCY_KEY_REQUIRED: "Thiếu Idempotency-Key.",
  IDEMPOTENCY_KEY_INVALID: "Idempotency-Key không hợp lệ.",
  IDEMPOTENCY_EXPIRED: "Khóa chống lặp đã hết hạn phát lại; xem tài nguyên cũ.",
  APPROVAL_EXPIRED: "Bản duyệt đã hết hạn.",
  LINK_EXPIRED: "Liên kết đã dùng hoặc đã hết hạn.",
  ACTION_FINAL: "Tác vụ đã có kết quả cuối.",
  INVALID_TRANSITION: "Trạng thái hiện tại không cho thao tác này.",
  RESOURCE_LOCKED: "Tài nguyên đang chờ xác minh một tác vụ trước.",
  CONSENT_REQUIRED: "Chưa có đồng ý cho mục đích này.",
  HEALTH_LOCAL_ONLY: "Dữ liệu sức khỏe chỉ xử lý trên điện thoại.",
  CALENDAR_NOT_LINKED: "Chưa liên kết tài khoản Microsoft 365.",
  UNSUPPORTED: "Chưa hỗ trợ.",
  MODULE_DISABLED: "Mô-đun đang tắt.",
  RATE_LIMITED: "Quá nhiều yêu cầu.",
  DEPENDENCY_UNAVAILABLE: "Dịch vụ phụ thuộc chưa sẵn sàng.",
  DISPATCH_CLOSED: "Đang đóng phát tác vụ.",
  INTERNAL: "Lỗi máy chủ.",
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;
  /** Lỗi mang theo một thay đổi trạng thái hợp lệ (ví dụ EXPIRED khi duyệt quá hạn): giao dịch vẫn COMMIT rồi mới trả lỗi. */
  readonly commit: boolean;
  constructor(status: number, code: string, opts: { retryable?: boolean; extra?: Record<string, unknown>; headers?: Record<string, string>; detail?: string; commit?: boolean } = {}) {
    super(opts.detail ?? MESSAGES[code] ?? code);
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.extra = opts.extra ?? {};
    this.headers = opts.headers ?? {};
    this.commit = opts.commit ?? false;
  }
}

export const bad = (code = "SCHEMA_INVALID", extra?: Record<string, unknown>) => new ApiError(400, code, { extra });
export const notFound = () => new ApiError(404, "NOT_FOUND");
export const forbidden = () => new ApiError(403, "FORBIDDEN");
export const conflict = (code: string, extra?: Record<string, unknown>) => new ApiError(409, code, { extra });
