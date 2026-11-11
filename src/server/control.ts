// Control store: kho thẩm quyền riêng, tách khỏi DB (SRS mục 21 bước 1: "Không rollback epoch cùng DB"). Giữ recovery_epoch,
// khóa phát toàn hệ, cờ mô-đun/site (kill switch, SRS mục 24) và danh sách receiver được mở sau khôi phục. Ghi bằng tệp tạm +
// fsync + rename để không còn trạng thái nửa vời.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type ModuleName = "calendar" | "home" | "robot" | "lele";

export interface ControlState {
  recovery_epoch: number;
  dispatch: { locked: boolean; reason: string | null; since: string | null };
  modules: Record<ModuleName, boolean>;
  sites: Record<string, boolean>;
  receivers_allowlist: string[] | null;
  history: { at: string; by: string; change: string }[];
}

const initial = (): ControlState => ({
  recovery_epoch: 1,
  dispatch: { locked: false, reason: null, since: null },
  modules: { calendar: true, home: true, robot: true, lele: true },
  sites: {},
  receivers_allowlist: null,
  history: [],
});

export class ControlStore {
  readonly path: string;
  private state: ControlState;

  constructor(path: string) {
    this.path = path;
    this.state = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ControlState) : initial();
    if (!existsSync(path)) this.persist();
  }

  get(): Readonly<ControlState> {
    return this.state;
  }

  private persist() {
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(this.state, null, 1));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    try {
      const dfd = openSync(dirname(this.path), "r");
      fsyncSync(dfd);
      closeSync(dfd);
    } catch {
      /* một số hệ tệp không cho fsync thư mục */
    }
  }

  private change(at: string, by: string, change: string, f: (s: ControlState) => void) {
    f(this.state);
    this.state.history.push({ at, by, change });
    if (this.state.history.length > 500) this.state.history.splice(0, this.state.history.length - 500);
    this.persist();
  }

  lockDispatch(at: string, by: string, reason: string) {
    if (this.state.dispatch.locked && this.state.dispatch.reason === reason) return;
    this.change(at, by, `lock: ${reason}`, (s) => (s.dispatch = { locked: true, reason, since: at }));
  }

  /** Khóa và tăng epoch trong một lần ghi: permit cũ bị chặn ở mọi receiver (SRS mục 21 bước 1, mục 17 recovery_epoch). */
  beginRecovery(at: string, by: string, reason: string) {
    this.change(at, by, `recovery: ${reason}`, (s) => {
      s.recovery_epoch += 1;
      s.dispatch = { locked: true, reason: `RECOVERY: ${reason}`, since: at };
      s.receivers_allowlist = [];
    });
    return this.state.recovery_epoch;
  }

  /** Mở phát: cần hai người khác nhau ký (dual control, SRS mục 12, 21 bước 5). Sau khôi phục chỉ receiver trong allowlist. */
  unlockDispatch(at: string, approvers: [string, string], allowlist: string[] | null) {
    if (!approvers[0] || !approvers[1] || approvers[0] === approvers[1]) throw new Error("mở phát cần hai người khác nhau");
    this.change(at, `${approvers[0]}+${approvers[1]}`, `unlock (${allowlist ? allowlist.join(",") || "không receiver nào" : "mọi receiver"})`, (s) => {
      s.dispatch = { locked: false, reason: null, since: null };
      s.receivers_allowlist = allowlist;
    });
  }

  setModule(at: string, by: string, module: ModuleName, enabled: boolean, reason: string) {
    this.change(at, by, `module ${module}=${enabled}: ${reason}`, (s) => (s.modules[module] = enabled));
  }

  setSite(at: string, by: string, site: string, enabled: boolean, reason: string) {
    this.change(at, by, `site ${site}=${enabled}: ${reason}`, (s) => (s.sites[site] = enabled));
  }

  moduleOn(m: ModuleName) {
    return this.state.modules[m] !== false;
  }

  siteOn(site: string) {
    return this.state.sites[site] !== false;
  }

  receiverAllowed(audience: string) {
    const a = this.state.receivers_allowlist;
    return a === null || a.includes(audience);
  }

  dispatchOpen() {
    return !this.state.dispatch.locked;
  }
}
