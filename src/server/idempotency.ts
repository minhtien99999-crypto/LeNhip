// Idempotency (SRS mục 16, TX01, T08). Khóa duy nhất theo (workspace đã xác minh, actor, method, route cụ thể, key). Digest =
// SHA-256 JCS của {method, route, workspace_id, body} sau khi kiểm schema. Bản ghi khóa được INSERT trong cùng giao dịch với
// mutation; cùng key/digest đang chạy → 409 REQUEST_IN_PROGRESS + Retry-After 1; khác digest → 409 IDEMPOTENCY_CONFLICT; sau
// commit phát lại nguyên status/body, vẫn qua xác thực và quyền đọc hiện hành. Replay 90 ngày; action chưa rõ kết quả giữ tombstone.
import { ApiError } from "../core/errors.ts";
import { digestJcs } from "../core/crypto.ts";
import { type Ctx, nowIso } from "./context.ts";
import { TERMINAL, type State } from "./machine.ts";
import { all, one, run, tx } from "./store.ts";

export const KEY_RE = /^[A-Za-z0-9_-]{22,128}$/;

export interface Stored {
  status: number;
  body: unknown;
  resource?: { type: string; id: string };
}

interface Row {
  request_digest: string;
  status: number | null;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  replay_until: string;
  tombstone: number;
}

export class Idempotency {
  private readonly ctx: Ctx;
  private readonly inflight = new Map<string, string>();
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  static digest(method: string, route: string, ws: string, body: unknown) {
    return digestJcs({ method, route, workspace_id: ws, body });
  }

  /**
   * Handler bất đồng bộ (ví dụ LeLe chờ mô hình): không ghi sổ trong lúc chờ; khi có kết quả, bản ghi khóa được ghi trong một
   * giao dịch. Cùng khóa đang chạy trả REQUEST_IN_PROGRESS.
   */
  async run(
    o: { ws: string; actor: string; method: string; route: string; key: string | undefined; body: unknown; readable: (r: { type: string; id: string } | null) => boolean },
    handler: () => Promise<Stored>,
  ): Promise<Stored & { replayed: boolean }> {
    if (!o.key) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
    if (!KEY_RE.test(o.key)) throw new ApiError(400, "IDEMPOTENCY_KEY_INVALID");
    const digest = Idempotency.digest(o.method, o.route, o.ws, o.body);
    const composite = JSON.stringify([o.ws, o.actor, o.method, o.route, o.key]);
    const running = this.inflight.get(composite);
    if (running !== undefined) {
      if (running === digest) throw new ApiError(409, "REQUEST_IN_PROGRESS", { retryable: true, headers: { "Retry-After": "1" } });
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
    }
    const replay = this.lookup(o, digest);
    if (replay) return replay;
    this.inflight.set(composite, digest);
    try {
      const result = await handler();
      return tx(this.ctx.db, () => {
        const again = this.lookup(o, digest);
        if (again) return again;
        this.insert(o, digest, result);
        return { ...result, replayed: false };
      });
    } finally {
      this.inflight.delete(composite);
    }
  }

  /** Handler đồng bộ: mutation và bản ghi khóa trong cùng một giao dịch. */
  runSync(
    o: { ws: string; actor: string; method: string; route: string; key: string | undefined; body: unknown; readable: (r: { type: string; id: string } | null) => boolean },
    handler: () => Stored,
  ): Stored & { replayed: boolean } {
    if (!o.key) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
    if (!KEY_RE.test(o.key)) throw new ApiError(400, "IDEMPOTENCY_KEY_INVALID");
    const digest = Idempotency.digest(o.method, o.route, o.ws, o.body);
    const composite = JSON.stringify([o.ws, o.actor, o.method, o.route, o.key]);
    const running = this.inflight.get(composite);
    if (running !== undefined) {
      if (running === digest) throw new ApiError(409, "REQUEST_IN_PROGRESS", { retryable: true, headers: { "Retry-After": "1" } });
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
    }
    return tx(this.ctx.db, () => {
      const replay = this.lookup(o, digest);
      if (replay) return replay;
      const result = handler();
      this.insert(o, digest, result);
      return { ...result, replayed: false };
    });
  }

  private lookup(o: { ws: string; actor: string; method: string; route: string; key: string | undefined; readable: (r: { type: string; id: string } | null) => boolean }, digest: string) {
    const r = one<Row>(this.ctx.db, "SELECT request_digest, status, body, resource_type, resource_id, replay_until, tombstone FROM idem_keys WHERE workspace_id = ? AND actor = ? AND method = ? AND route = ? AND idem_key = ?",
      o.ws, o.actor, o.method, o.route, o.key as string);
    if (!r) return null;
    if (r.request_digest !== digest) throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
    const resource = r.resource_type && r.resource_id ? { type: r.resource_type, id: r.resource_id } : null;
    if (r.tombstone || nowIso(this.ctx) > r.replay_until) throw new ApiError(410, "IDEMPOTENCY_EXPIRED", { extra: resource ? { resource_id: resource.id } : {} });
    // Phát lại vẫn qua quyền đọc hiện hành: cache cũ không vượt thu hồi quyền.
    if (!o.readable(resource)) throw new ApiError(404, "NOT_FOUND");
    return { status: r.status as number, body: JSON.parse(r.body as string), resource: resource ?? undefined, replayed: true };
  }

  private insert(o: { ws: string; actor: string; method: string; route: string; key: string | undefined }, digest: string, result: Stored) {
    const now = this.ctx.clock.now();
    run(this.ctx.db, `INSERT INTO idem_keys (workspace_id, actor, method, route, idem_key, request_digest, status, body, resource_type, resource_id, received_at, replay_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.ws, o.actor, o.method, o.route, o.key as string, digest, result.status, JSON.stringify(result.body), result.resource?.type ?? null, result.resource?.id ?? null,
      new Date(now).toISOString(), new Date(now + this.ctx.config.idempotencyReplayMs).toISOString());
  }
}

/** Dọn khóa hết hạn phát lại: xóa nếu tài nguyên đã có kết quả; giữ tombstone nếu action còn chưa rõ (SRS mục 11, 16). */
export function purgeIdempotency(ctx: Ctx) {
  const at = nowIso(ctx);
  const rows = all<{ rowid: number; resource_type: string | null; resource_id: string | null }>(ctx.db, "SELECT rowid, resource_type, resource_id FROM idem_keys WHERE replay_until < ? AND tombstone = 0", at);
  let deleted = 0;
  let tombstoned = 0;
  tx(ctx.db, () => {
    for (const r of rows) {
      let unresolved = false;
      if (r.resource_type === "plan" || r.resource_type === "action") {
        const a = one<{ state: State }>(ctx.db, r.resource_type === "plan" ? "SELECT state FROM actions WHERE id = ?" : "SELECT state FROM actions WHERE action_id = ?", r.resource_id as string);
        unresolved = !!a && !TERMINAL.has(a.state);
      }
      if (unresolved) {
        run(ctx.db, "UPDATE idem_keys SET tombstone = 1, body = NULL, status = NULL WHERE rowid = ?", r.rowid);
        tombstoned++;
      } else {
        run(ctx.db, "DELETE FROM idem_keys WHERE rowid = ?", r.rowid);
        deleted++;
      }
    }
    // jti đã tiêu thụ giữ ít nhất 24 giờ sau exp; sau đó tombstone action, epoch và binding bảo vệ phát lại dài hạn.
    run(ctx.db, "DELETE FROM permit_jti WHERE exp * 1000 + ? < ?", ctx.config.jtiRetentionMs, ctx.clock.now());
  });
  return { deleted, tombstoned };
}
