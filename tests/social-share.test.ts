// Chia sẻ ra từ thiết bị (LNH-T40, LNH-T41): danh mục 34 nền tảng, trình dựng liên kết chia sẻ, thẻ chia sẻ. Mọi thứ ở đây
// chạy trên thiết bị và không có phần máy chủ; phép kiểm trình duyệt tương ứng là scripts/e2e-social.mjs.
// Bảng PINNED dưới đây là bản ghim độc lập với danh mục: bật thêm một nền tảng hoặc đổi tên máy chủ mà không sửa bảng này thì
// kiểm thử hỏng. Chưa nền tảng thật nào được gọi: các phép kiểm chỉ xét chuỗi liên kết dựng ra.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SOCIAL_PLATFORMS, EVIDENCE_GRADES, SHARE_REACHES, SHARE_STATUSES, platformById, shareReach, shareStatus, shareLinkPlatforms, buildShareUrl, buildMailtoUrl,
} from "../web/shared/social-registry.js";
import {
  NOTE_LIMIT, NOTE_UNIT_LIMIT, PUBLIC_URL_LIMIT, SHARE_CARD_FIELDS, buildShareCard, countGraphemes, joinNoteAndUrl, normalizeNote, normalizePublicUrl, toWellFormed,
} from "../web/shared/share-card.js";
import viCore from "../web/shared/i18n-vi.js";
import viSocial from "../web/shared/i18n-vi-social.js";
import enSocial from "../web/shared/i18n-en-social.js";

/** Địa chỉ công khai giả định cho kiểm thử (tên miền dành riêng .example); LeNhip chưa có địa chỉ công khai (LNH-Q13). */
const PUBLIC = "https://lenhip.example/";

/** Năm liên kết chia sẻ đang bật (LNH-T40): tên máy chủ, đường dẫn và tên tham số theo đúng thứ tự của mẫu. */
const PINNED: Record<string, { host: string; path: string; params: string[]; urlSlot: boolean; needsUrl: boolean }> = {
  threads: { host: "www.threads.com", path: "/intent/post", params: ["text"], urlSlot: false, needsUrl: false },
  x: { host: "x.com", path: "/intent/tweet", params: ["text", "url"], urlSlot: true, needsUrl: false },
  telegram: { host: "t.me", path: "/share/url", params: ["url", "text"], urlSlot: true, needsUrl: true },
  line: { host: "social-plugins.line.me", path: "/lineit/share", params: ["url", "text"], urlSlot: true, needsUrl: true },
  bluesky: { host: "bsky.app", path: "/intent/compose", params: ["text"], urlSlot: false, needsUrl: false },
};
const ENABLED = Object.keys(PINNED);

const NOTES: [string, string][] = [
  ["dấu & và tham số giả", "a&b=c&url=https://evil.test/&text=khác&via=x"],
  ["dấu #", "#LeNhip #một_ngày đúng nhịp"],
  ["dấu %", "100% %41 %zz %"],
  ["CRLF", "dòng 1\r\ndòng 2\rdòng 3\ndòng 4"],
  ["emoji", "🙂 👨‍👩‍👧‍👦 🇻🇳 👍🏽"],
  ["chữ viết từ phải sang trái và ký tự đổi chiều", "مرحبا بالعالم ‮evil.test‬ שלום"],
  ["5.000 ký tự", "ế".repeat(5000)],
  ["ký tự có nghĩa trong URL", "?x=1;y=2/../..\\@evil.test:80 'a' \"b\" <c> (d) !*~ + [e] {f} |g| ^h` \t"],
  ["nửa cặp thay thế đứng lẻ", "a\uD83Db\uDE00c"],
  ["chuỗi giống liên kết", "https://evil.test/?q=1#x javascript:alert(1)"],
];

test("danh mục: 34 nền tảng và `mock`, mã duy nhất, tên là chữ, mỗi mục đủ trường và bị đóng băng", () => {
  assert.equal(SOCIAL_PLATFORMS.length, 35);
  const real = SOCIAL_PLATFORMS.filter((p) => !p.simulated);
  assert.equal(real.length, 34);
  assert.equal(new Set(SOCIAL_PLATFORMS.map((p) => p.id)).size, 35);
  assert.equal(new Set(SOCIAL_PLATFORMS.map((p) => p.name)).size, 35);
  assert.ok(Object.isFrozen(SOCIAL_PLATFORMS));
  for (const p of SOCIAL_PLATFORMS) {
    assert.deepEqual(Object.keys(p), ["id", "name", "region", "share", "template", "host", "needs_url", "enabled", "link", "api_post", "simulated", "evidence"], p.id);
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.region), p.id);
    assert.match(p.id, /^[a-z][a-z0-9_]{0,23}$/, p.id);
    // Tên là văn bản thuần: không thẻ, không đường dẫn ảnh, không liên kết.
    assert.match(p.name, /^[A-Za-z][A-Za-z ()/.]{0,29}$/, p.id);
    assert.ok(["link", "needs_id", "sheet_only", "none"].includes(p.share), p.id);
    assert.ok(EVIDENCE_GRADES.includes(p.evidence), p.id);
    for (const r of p.region) assert.match(r, /^(?:[A-Z]{2}|[a-z]+(?:-[a-z]+)*)$/, `${p.id}: vùng ${r}`);
    for (const flag of [p.needs_url, p.enabled, p.link, p.api_post, p.simulated]) assert.equal(typeof flag, "boolean", p.id);
    assert.equal(platformById(p.id), p);
    // Mẫu chỉ có ở mục "link"; mục cần liên kết thì mẫu phải có chỗ {url}.
    assert.equal(p.template !== null, p.share === "link", p.id);
    if (p.needs_url) assert.ok(p.template?.includes("{url}"), p.id);
    if (p.host !== null) {
      assert.ok(p.template !== null, p.id);
      const parsed = new URL(p.template.replace(/\{[a-z_]+\}/g, "x"));
      assert.equal(parsed.protocol, "https:", p.id);
      assert.equal(parsed.host, p.host, p.id);
    } else if (p.template !== null) {
      // Không có tên máy chủ cố định: máy chủ do người dùng chọn (Mastodon) hoặc lược đồ ứng dụng (Viber). Không mục nào bật.
      assert.ok(p.template.includes("{instance}") || !p.template.startsWith("https://"), p.id);
      assert.equal(p.enabled, false, p.id);
    }
  }
  // Mức bằng chứng theo khảo sát (LNH-F26): 9 mục dựa trên tài liệu chính thức đọc qua tìm kiếm; không mục nào được đọc trực tiếp.
  const grade = (g: string) => real.filter((p) => p.evidence === g).length;
  assert.deepEqual([grade("official_via_search"), grade("partial"), grade("secondary_only"), grade("unverified"), grade("internal")], [9, 14, 10, 1, 0]);
  for (const id of ["", "X", "x ", "x.com", "threads/../x", "__proto__", "constructor", "toString", "hasOwnProperty"]) assert.equal(platformById(id), null, id);
  for (const id of [null, undefined, 1, {}, ["x"], Symbol("x")]) assert.equal(platformById(id), null);
});

test("danh mục: chỉ Threads, X, Telegram, LINE, Bluesky bật liên kết chia sẻ; chỉ `mock` liên kết tài khoản và đăng qua API", () => {
  const enabled = SOCIAL_PLATFORMS.filter((p) => p.enabled);
  assert.deepEqual(enabled.map((p) => p.id), ENABLED);
  for (const p of enabled) {
    const pin = PINNED[p.id];
    assert.equal(p.share, "link", p.id);
    assert.equal(p.evidence, "official_via_search", `${p.id}: chỉ mức «tài liệu chính thức qua tìm kiếm» mới được bật`);
    assert.equal(p.host, pin.host, p.id);
    assert.equal(p.needs_url, pin.needsUrl, p.id);
    assert.ok(p.template !== null && p.template.startsWith(`https://${pin.host}${pin.path}?`), p.id);
    // Mẫu đang bật chỉ có chỗ {text} và {url}; không mã ứng dụng, không tham số nào khác.
    assert.deepEqual(p.template.slice(p.template.indexOf("?") + 1).split("&"), pin.params.map((name) => `${name}={${name}}`), p.id);
    assert.equal(p.link || p.api_post || p.simulated, false, p.id);
  }
  // Liên kết tài khoản và đăng qua API: không nền tảng thật nào (LNH-F21, LNH-T42).
  assert.deepEqual(SOCIAL_PLATFORMS.filter((p) => p.link).map((p) => p.id), ["mock"]);
  assert.deepEqual(SOCIAL_PLATFORMS.filter((p) => p.api_post).map((p) => p.id), ["mock"]);
  assert.deepEqual(SOCIAL_PLATFORMS.filter((p) => p.simulated).map((p) => p.id), ["mock"]);
  const mock = platformById("mock");
  assert.ok(mock && mock.share === "none" && mock.enabled === false && mock.template === null && mock.evidence === "internal");
  assert.equal(shareReach(mock), null);
  assert.equal(shareStatus(mock, true), null);
});

test("danh mục: bốn nhóm theo cách tới được (5, 16, 3, 10) và trạng thái của từng mục", () => {
  const ids = (reach: string) => SOCIAL_PLATFORMS.filter((p) => shareReach(p) === reach).map((p) => p.id);
  assert.deepEqual([...SHARE_REACHES], ["link_on", "link_off", "needs_id", "sheet_only"]);
  assert.deepEqual(ids("link_on"), ENABLED);
  assert.deepEqual(ids("link_off"), ["facebook", "whatsapp", "linkedin", "pinterest", "reddit", "snapchat", "naver", "band", "weibo", "qq_qzone", "vk", "ok", "mastodon", "tumblr", "viber", "ms_teams"]);
  assert.deepEqual(ids("needs_id"), ["messenger", "zalo", "kakaotalk"]);
  assert.deepEqual(ids("sheet_only"), ["instagram", "tiktok", "youtube", "discord", "kakaostory", "wechat", "douyin", "xiaohongshu", "twitch", "kuaishou"]);
  const status = (hasUrl: boolean) => Object.fromEntries(SOCIAL_PLATFORMS.filter((p) => !p.simulated).map((p) => [p.id, shareStatus(p, hasUrl)]));
  const none = status(false);
  const withUrl = status(true);
  for (const s of [...Object.values(none), ...Object.values(withUrl)]) assert.ok(s !== null && SHARE_STATUSES.includes(s));
  // Chưa có địa chỉ công khai: Telegram và LINE chờ; có rồi thì cả năm bật. Các mục khác không đổi theo địa chỉ.
  assert.deepEqual(ENABLED.map((id) => none[id]), ["on", "on", "wait_url", "wait_url", "on"]);
  assert.deepEqual(ENABLED.map((id) => withUrl[id]), ["on", "on", "on", "on", "on"]);
  for (const id of ids("link_off")) assert.equal(none[id], id === "viber" ? "app_scheme" : "unconfirmed", id);
  for (const id of ids("needs_id")) assert.equal(none[id], "needs_id", id);
  for (const id of ids("sheet_only")) assert.equal(none[id], "sheet_only", id);
  for (const p of SOCIAL_PLATFORMS) if (!p.enabled) assert.equal(shareStatus(p, false), shareStatus(p, true), p.id);
  assert.deepEqual(shareLinkPlatforms(false).map((p) => p.id), ["threads", "x", "bluesky"]);
  assert.deepEqual(shareLinkPlatforms(true).map((p) => p.id), ENABLED);
});

test("buildShareUrl: tên máy chủ ghim sẵn, https, từng tham số được mã hóa riêng và giải mã lại đúng từng ký tự", () => {
  for (const id of ENABLED) {
    const pin = PINNED[id];
    for (const [label, note] of NOTES) {
      for (const link of [null, PUBLIC]) {
        const where = `${id} · ${label} · ${link ? "có" : "không"} liên kết`;
        const out = buildShareUrl(id, { note, url: link });
        if (pin.needsUrl && !link) {
          assert.equal(out, null, `${where}: thiếu liên kết bắt buộc thì không dựng`);
          continue;
        }
        assert.ok(typeof out === "string", where);
        // Chỉ ký tự ASCII in được: không xuống dòng, không khoảng trắng, không ký tự đổi chiều chưa mã hóa.
        assert.match(out, /^[\x21-\x7E]+$/, where);
        assert.ok(out.startsWith(`https://${pin.host}${pin.path}?`), where);
        const parsed = new URL(out);
        assert.equal(parsed.href, out, where);
        assert.deepEqual([parsed.protocol, parsed.host, parsed.port, parsed.pathname, parsed.username, parsed.password, parsed.hash], ["https:", pin.host, "", pin.path, "", "", ""], where);
        const expected: Record<string, string> = pin.urlSlot ? { text: toWellFormed(note), url: link ?? "" } : { text: joinNoteAndUrl(toWellFormed(note), link) };
        const names = pin.params.filter((name) => expected[name]);
        assert.deepEqual([...parsed.searchParams.keys()], names, `${where}: không tham số nào bị chèn thêm`);
        assert.equal(out.split("?").length, 2, where);
        assert.equal(out.split("?")[1].split("&").length, names.length, where);
        for (const name of names) assert.equal(parsed.searchParams.get(name), expected[name], `${where}: tham số ${name}`);
        // Không ký tự nào của RFC 3986 dành riêng lọt ra ngoài giá trị.
        for (const part of out.split("?")[1].split("&")) assert.match(part, /^[a-z]+=[A-Za-z0-9\-_.~%]+$/, where);
      }
    }
  }
  // Không cắt bớt: 5.000 ký tự vào thì 5.000 ký tự ra.
  const long = new URL(buildShareUrl("bluesky", { note: "ế".repeat(5000) }) as string).searchParams.get("text") as string;
  assert.equal(long.length, 5000);
  // CRLF đi nguyên trong giá trị đã mã hóa, không thành dòng mới của liên kết.
  assert.equal(buildShareUrl("x", { note: "a\r\nb" }), "https://x.com/intent/tweet?text=a%0D%0Ab");
  assert.equal(buildShareUrl("x", { note: "a&b #c 100%", url: PUBLIC }), "https://x.com/intent/tweet?text=a%26b%20%23c%20100%25&url=https%3A%2F%2Flenhip.example%2F");
  assert.equal(buildShareUrl("telegram", { note: "", url: PUBLIC }), "https://t.me/share/url?url=https%3A%2F%2Flenhip.example%2F");
  assert.equal(buildShareUrl("line", { note: "chào", url: PUBLIC }), "https://social-plugins.line.me/lineit/share?url=https%3A%2F%2Flenhip.example%2F&text=ch%C3%A0o");
  assert.equal(buildShareUrl("threads", { note: "chào", url: PUBLIC }), "https://www.threads.com/intent/post?text=ch%C3%A0o%0Ahttps%3A%2F%2Flenhip.example%2F");
  assert.equal(buildShareUrl("bluesky", { url: PUBLIC }), "https://bsky.app/intent/compose?text=https%3A%2F%2Flenhip.example%2F");
  assert.equal(buildShareUrl("x", { note: "it's (ok)!*" }), "https://x.com/intent/tweet?text=it%27s%20%28ok%29%21%2A");
});

test("buildShareUrl: từ chối nền tảng lạ hoặc chưa bật, thẻ rỗng, thiếu liên kết bắt buộc và liên kết không phải địa chỉ công khai", () => {
  const full = { note: "Xin chào", url: PUBLIC };
  // Mọi mục chưa bật, kể cả mục có mẫu chép từ khảo sát và `mock`, đều không dựng được liên kết.
  for (const p of SOCIAL_PLATFORMS) assert.equal(buildShareUrl(p.id, full) === null, !ENABLED.includes(p.id), p.id);
  for (const id of ["", "X", "Threads", "x ", " x", "x.com", "https://x.com", "x/../telegram", "x@evil.test", "__proto__", "constructor", "toString", null, undefined, 0, {}, ["x"]]) {
    assert.equal(buildShareUrl(id, full), null, String(id));
  }
  for (const id of ENABLED) {
    for (const content of [null, undefined, {}, { note: "" }, { note: "", url: null }, { note: 5 }, { url: undefined }]) assert.equal(buildShareUrl(id, content as never), null, `${id}: thẻ rỗng`);
    assert.equal(buildShareUrl(id, "Xin chào" as never), null, id);
    // Liên kết sai thì không dựng gì cả, không lặng lẽ bỏ liên kết đi.
    for (const url of [
      "http://lenhip.example/", "javascript:alert(1)", "data:text/html,x", "//lenhip.example/", "lenhip.example", "https://evil.test@lenhip.example/", "https://user:pass@lenhip.example/",
      "https://lenhip.example/#x", " https://lenhip.example/", "https://lenhip.example/ ", "https://LENHIP.example/", "HTTPS://lenhip.example/", "https://localhost/", "https://127.0.0.1/",
      "https://[::1]/", "https://lenhip/", "https://lenhip.example\\@evil.test/", "https:/lenhip.example/", "https://lenhip.example/a/../b", "https://lenhip.example/đường", "",
      "https://lenhip.example/" + "a".repeat(PUBLIC_URL_LIMIT), 5, {}, ["https://lenhip.example/"],
    ]) {
      assert.equal(buildShareUrl(id, { note: "Xin chào", url: url as never }), null, `${id}: ${String(url).slice(0, 60)}`);
    }
  }
  assert.equal(buildShareUrl("telegram", { note: "Xin chào" }), null);
  assert.equal(buildShareUrl("line", { note: "Xin chào", url: null }), null);
  assert.equal(typeof buildShareUrl("x", { note: "Xin chào" }), "string");
  // Ghi chú chứa một địa chỉ khác không đổi được nơi liên kết dẫn tới.
  const tricky = new URL(buildShareUrl("telegram", { note: "https://evil.test/?url=https://evil.test/&text=x", url: PUBLIC }) as string);
  assert.equal(tricky.host, "t.me");
  assert.equal(tricky.searchParams.getAll("url").join("|"), PUBLIC);
});

test("địa chỉ công khai: chỉ https, tên miền công khai ở dạng chuẩn", () => {
  assert.equal(normalizePublicUrl("https://lenhip.example"), "https://lenhip.example/");
  for (const ok of ["https://lenhip.example/", "https://app.lenhip.example/moi?x=1", "https://lenhip.example:8443/", "https://xn--lnhip-dsa.vn/", "https://a-b.c0.example/x/y.html"]) assert.equal(normalizePublicUrl(ok), ok, ok);
  for (const bad of [null, undefined, 0, "", "lenhip.example", "http://lenhip.example/", "ftp://lenhip.example/", "https://localhost/", "https://localhost:8787/", "https://127.0.0.1/", "https://10.0.0.1:8443/",
    "https://[::1]/", "https://lenhip/", "https://-a.example/", "https://a-.example/", "https://lenhip.example/#x", "https://lenhip.example/\n", "https://a@lenhip.example/", "https://Lenhip.example/",
    "https://lenhip.example/a b", "https://lenhip.example/%7E/../x", "https://lenhip.example/" + "a".repeat(PUBLIC_URL_LIMIT)]) {
    assert.equal(normalizePublicUrl(bad), null, String(bad).slice(0, 60));
  }
});

test("thẻ chia sẻ: chỉ có ghi chú và liên kết LeNhip; liên kết không kèm sẵn và chỉ có khi LeNhip có địa chỉ công khai", () => {
  assert.deepEqual([...SHARE_CARD_FIELDS], ["note", "includeLink", "publicUrl"]);
  assert.deepEqual(buildShareCard({ note: "Xin chào" }), { ok: true, code: null, note: "Xin chào", url: null, text: "Xin chào", graphemes: 8 });
  // Mặc định không kèm liên kết, kể cả khi đã có địa chỉ công khai; includeLink phải đúng bằng true.
  for (const includeLink of [undefined, false, null, "true", 1, {}]) assert.equal(buildShareCard({ note: "a", includeLink, publicUrl: PUBLIC }).url, null, String(includeLink));
  assert.deepEqual(buildShareCard({ note: "Xin chào", includeLink: true, publicUrl: PUBLIC }), { ok: true, code: null, note: "Xin chào", url: PUBLIC, text: "Xin chào\n" + PUBLIC, graphemes: 8 });
  // Chưa có địa chỉ công khai (hiện trạng, LNH-Q13) hoặc địa chỉ không hợp lệ: không có liên kết để kèm.
  for (const publicUrl of [undefined, null, "", "http://lenhip.example/", "https://localhost/", "javascript:alert(1)"]) {
    assert.deepEqual(buildShareCard({ note: "a", includeLink: true, publicUrl }), { ok: true, code: null, note: "a", url: null, text: "a", graphemes: 1 }, String(publicUrl));
    assert.deepEqual(buildShareCard({ note: " ", includeLink: true, publicUrl }), { ok: false, code: "EMPTY", note: "", url: null, text: "", graphemes: 0 }, String(publicUrl));
  }
  assert.deepEqual(buildShareCard({ note: "  \n ", includeLink: true, publicUrl: PUBLIC }), { ok: true, code: null, note: "", url: PUBLIC, text: PUBLIC, graphemes: 0 });
  for (const note of ["", "   ", "\r\n\t", undefined, null, 5, {}, ["a"]]) assert.equal(buildShareCard({ note }).code, "EMPTY", String(note));
  // Tập trường đóng: không có cách nào đưa dữ liệu sức khỏe, lịch hay ngôi nhà vào thẻ (LNH-T41).
  for (const key of ["steps", "sleep", "sleep_minutes", "heart_rate", "health", "reason_from_health", "calendar", "event", "busy", "home", "lamp", "device", "tracker", "text", "url", "title", "image"]) {
    assert.throws(() => buildShareCard({ note: "a", [key]: 1 } as never), new RegExp(`không có trường ${key}`), key);
  }
  for (const bad of [null, undefined, "a", 5, ["a"]]) assert.throws(() => buildShareCard(bad as never), TypeError);
  // Văn bản của thẻ luôn là ghi chú rồi tới liên kết ở dòng riêng.
  assert.equal(joinNoteAndUrl("a", null), "a");
  assert.equal(joinNoteAndUrl("", PUBLIC), PUBLIC);
  assert.equal(joinNoteAndUrl("a", PUBLIC), "a\n" + PUBLIC);
});

test("thẻ chia sẻ: giới hạn 280 ký tự đếm theo cụm chữ; ghi chú được giữ nguyên, chỉ chuẩn hóa xuống dòng và bỏ ký tự điều khiển", () => {
  assert.equal(NOTE_LIMIT, 280);
  assert.deepEqual(["", "abc", "Tiếng Việt", "ế", "🙂", "👨‍👩‍👧‍👦", "🇻🇳", "👍🏽", "한국어", "नमस्ते", "a\nb"].map(countGraphemes), [0, 3, 10, 1, 1, 1, 1, 1, 3, 3, 3]);
  // Chữ Việt dạng tổ hợp (ba điểm mã cho «ế») và emoji vẫn là một ký tự mỗi cụm.
  for (const unit of ["a", "ế", "ế", "🙂", "🇻🇳"]) {
    const at = buildShareCard({ note: unit.repeat(NOTE_LIMIT) });
    assert.ok(at.ok && at.graphemes === NOTE_LIMIT && at.note === unit.repeat(NOTE_LIMIT), `280 × ${unit}`);
    assert.deepEqual(buildShareCard({ note: unit.repeat(NOTE_LIMIT + 1) }), { ok: false, code: "NOTE_TOO_LONG", note: "", url: null, text: "", graphemes: NOTE_LIMIT + 1 }, `281 × ${unit}`);
  }
  // Quá dài thì từ chối, không cắt bớt; có kèm liên kết cũng vậy.
  assert.equal(buildShareCard({ note: "a".repeat(5000), includeLink: true, publicUrl: PUBLIC }).code, "NOTE_TOO_LONG");
  // Một cụm chữ mang hàng nghìn dấu kết hợp: đếm là một ký tự nhưng vượt trần đơn vị mã.
  const stacked = "a" + "́".repeat(NOTE_UNIT_LIMIT);
  assert.equal(countGraphemes(stacked), 1);
  assert.equal(buildShareCard({ note: stacked }).code, "NOTE_TOO_LONG");
  assert.ok(buildShareCard({ note: "a" + "́".repeat(NOTE_UNIT_LIMIT - 1) }).ok);
  assert.equal(normalizeNote("  dòng 1\r\ndòng 2\rdòng 3\n\tdòng 4  \n"), "dòng 1\ndòng 2\ndòng 3\n\tdòng 4");
  assert.equal(normalizeNote("a\u0000b\u0008c\u001Bd\u007Fe\u0085f"), "abcdef");
  assert.equal(normalizeNote("a\uD83Db"), "a�b");
  assert.equal(toWellFormed("\uDE00🙂\uD83D"), "�🙂�");
  // Không chuẩn hóa NFC và không đụng tới chữ viết từ phải sang trái hay ký tự đổi chiều: đó là chữ của người dùng.
  for (const kept of ["ế", "مرحبا ‮abc‬", "#a &b %c <d>"]) assert.equal(normalizeNote(kept), kept);
  for (const raw of [undefined, null, 5, {}, ["a"]]) assert.equal(normalizeNote(raw), "");
});

test("thẻ chia sẻ ↔ liên kết: nội dung tới nền tảng đúng bằng ô xem trước; mailto không có người nhận", () => {
  for (const note of ["Một ngày đúng nhịp 🙂\nvới LeNhip & bạn #1", ""]) {
    for (const includeLink of [false, true]) {
      const card = buildShareCard({ note, includeLink, publicUrl: PUBLIC });
      if (!card.ok) {
        for (const id of ENABLED) assert.equal(buildShareUrl(id, card), null, id);
        assert.equal(buildMailtoUrl({ subject: "LeNhip", body: card.text }), null);
        continue;
      }
      for (const id of ENABLED) {
        const out = buildShareUrl(id, card);
        if (PINNED[id].needsUrl && !card.url) {
          assert.equal(out, null, id);
          continue;
        }
        const q = new URL(out as string).searchParams;
        if (PINNED[id].urlSlot) assert.deepEqual([q.get("text") ?? "", q.get("url")], [card.note, card.url], id);
        else assert.equal(q.get("text"), card.text, id);
      }
      const mail = buildMailtoUrl({ subject: "LeNhip", body: card.text }) as string;
      assert.match(mail, /^mailto:\?subject=LeNhip&body=[A-Za-z0-9\-_.~%]+$/);
      assert.equal(new URL(mail).pathname, "", "không có người nhận");
      assert.equal(decodeURIComponent(mail.slice(mail.indexOf("&body=") + 6)), card.text.replace(/\n/g, "\r\n"));
    }
  }
  assert.equal(buildMailtoUrl({ subject: "LeNhip", body: "a&cc=x@evil.test\nb" }), "mailto:?subject=LeNhip&body=a%26cc%3Dx%40evil.test%0D%0Ab");
  assert.equal(buildMailtoUrl({ body: "a" }), "mailto:?body=a");
  for (const bad of [null, undefined, {}, { body: "" }, { subject: "LeNhip" }, { body: 5 }]) assert.equal(buildMailtoUrl(bad as never), null);
});

test("chuỗi và mã của phần Mạng xã hội: mọi chuỗi qua catalog (vi, en), không chữ Việt trong mã, không gọi mạng, không ghi bộ nhớ trình duyệt", () => {
  const strip = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const view = strip("../web/views/connect-social.js");
  const vi = viSocial as Record<string, string>;
  const en = enSocial as Record<string, string>;
  // Khóa viết thẳng trong mã, và ba họ khóa ghép từ hằng của danh mục.
  const literal = [...view.matchAll(/"((?:social|connect)\.[A-Za-z0-9_.]*[A-Za-z0-9_])"/g)].map((m) => m[1]);
  const prefixes = [...view.matchAll(/"(social\.[A-Za-z0-9_.]*\.)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(prefixes)].sort(), ["social.evidence.", "social.group.", "social.status."]);
  const dynamic = [
    ...SHARE_STATUSES.map((s) => `social.status.${s}`),
    ...EVIDENCE_GRADES.filter((g) => g !== "internal").map((g) => `social.evidence.${g}`),
    ...SHARE_REACHES.flatMap((r) => [`social.group.${r}.title`, `social.group.${r}.note`]),
  ];
  assert.ok(literal.length > 30);
  for (const key of [...literal, ...dynamic]) assert.ok(Object.hasOwn(key.startsWith("social.") ? vi : viCore, key), `thiếu khóa ${key} trong catalog tiếng Việt`);
  const used = new Set([...literal, ...dynamic]);
  for (const key of Object.keys(vi)) assert.ok(used.has(key), `khóa ${key} không còn được dùng`);
  // Bản tiếng Anh có cùng tập khóa và cùng tham số {tên} cho từng khóa.
  const slots = (text: string) => [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  for (const key of Object.keys(vi)) assert.deepEqual(slots(en[key]), slots(vi[key]), key);
  // Câu sau khi mở nơi nhận không bao giờ khẳng định đã đăng: bỏ mệnh đề «không biết…» đi thì không còn chữ «đã đăng», «đã gửi».
  for (const [key, text] of Object.entries(vi)) {
    if (!key.startsWith("social.result.")) continue;
    assert.doesNotMatch(text.replace(/LeNhip không biết bạn đã (?:đăng|gửi) hay chưa\./, ""), /đã đăng|đã gửi|đã chia sẻ|thành công/i, key);
    assert.doesNotMatch(en[key].replace(/LeNhip does not know whether you (?:posted|sent it)\./, ""), /\bposted\b|\bsent\b|\bshared\b|success/i, key);
  }
  for (const key of ["social.result.opened", "social.result.sheetHanded"]) assert.ok(vi[key].endsWith("LeNhip không biết bạn đã đăng hay chưa."), key);
  // Không chữ tiếng Việt viết thẳng trong mã của phần (chú thích không tính).
  assert.doesNotMatch(view, /[À-ɏḀ-ỿ]/);
  // Chia sẻ ra không có phần máy chủ: không gọi mạng, không ghi bộ nhớ của trình duyệt, không nạp mã từ nơi khác.
  // (Khi phần này có thêm liên kết tài khoản theo LNH-T42, lời gọi /v1/social/* phải nằm ngoài hộp soạn chia sẻ; lúc đó thu
  // hẹp phép kiểm `ctx.api` này về mã của hộp soạn, không bỏ nó.)
  for (const file of ["../web/views/connect-social.js", "../web/shared/social-registry.js", "../web/shared/share-card.js"]) {
    assert.doesNotMatch(strip(file), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|ctx\.api\b|\bimport\s*\(|window\.open/, file);
  }
  // Thẻ <a> của nền tảng mở cửa sổ mới mà không trao quyền điều khiển trang LeNhip và không gửi địa chỉ trang.
  assert.match(view, /target="_blank" rel="noopener noreferrer"/);
});
