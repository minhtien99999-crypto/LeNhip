// Kho độc lập với sổ thực thi (SRS mục 21): tệp JSONL chỉ ghi thêm, mỗi dòng nối mã băm dòng trước, fsync trước khi trả về.
// Dùng cho dispatch barrier (ghi trước mọi I/O) và sổ thu hồi (tombstone xóa, thu hồi đồng ý/quyền) để nạp lại sau restore.
// Môi trường thật đặt kho này ngoài DB và chu trình backup của DB, có ACL và retention chống sửa (LNH-D05).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { canonicalize } from "../../web/shared/jcs.js";
import { sha256b64 } from "../core/crypto.ts";

export interface JournalEntry {
  seq: number;
  prev: string;
  at: string;
  type: string;
  hash: string;
  [k: string]: unknown;
}

export class JournalUnavailable extends Error {}

export class AppendJournal {
  readonly path: string;
  private seq = 0;
  private last = "GENESIS";
  /** Kiểm thử: giả lập kho không ghi được. */
  unavailable = false;

  constructor(path: string) {
    this.path = path;
    const { entries, broken } = this.readAll();
    if (broken !== null) throw new Error(`${path}: chuỗi băm gãy ở dòng ${broken}`);
    const tail = entries[entries.length - 1];
    if (tail) {
      this.seq = tail.seq;
      this.last = tail.hash;
    }
  }

  append(type: string, at: string, data: Record<string, unknown>): JournalEntry {
    if (this.unavailable) throw new JournalUnavailable(`${this.path}: kho không ghi được`);
    const body = { ...data, seq: this.seq + 1, prev: this.last, at, type };
    const entry = { ...body, hash: sha256b64(canonicalize(body)) } as JournalEntry;
    const line = JSON.stringify(entry) + "\n";
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "a", 0o600);
      writeSync(fd, line);
      fsyncSync(fd);
    } catch (e) {
      throw new JournalUnavailable(`${this.path}: ${(e as Error).message}`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
    this.seq = entry.seq;
    this.last = entry.hash;
    return entry;
  }

  /** Đọc và kiểm chuỗi. Dòng cuối dở dang (ghi bị cắt) được trả riêng để bên đọc coi là "có thể đã ghi". */
  readAll(): { entries: JournalEntry[]; broken: number | null; partial: string | null } {
    if (!existsSync(this.path)) return { entries: [], broken: null, partial: null };
    const text = readFileSync(this.path, "utf8");
    const lines = text.split("\n");
    const partial = lines[lines.length - 1] ? lines.pop() ?? null : (lines.pop(), null);
    const entries: JournalEntry[] = [];
    let prev = "GENESIS";
    for (let i = 0; i < lines.length; i++) {
      let e: JournalEntry;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        return { entries, broken: i + 1, partial };
      }
      const { hash, ...body } = e;
      if (e.prev !== prev || sha256b64(canonicalize(body)) !== hash || e.seq !== i + 1) return { entries, broken: i + 1, partial };
      entries.push(e);
      prev = hash;
    }
    return { entries, broken: null, partial };
  }
}
