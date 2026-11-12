// @ts-check
// Danh mục nền tảng mạng xã hội của LeNhip (LNH-T40) và trình dựng liên kết chia sẻ. Tệp chỉ ở trên thiết bị: không gọi mạng.
//
// 34 nền tảng đã khảo sát và nhà cung cấp giả lập `mock`. Mỗi mục:
//   id          mã ổn định, chữ thường
//   name        tên dạng chữ; không dùng logo của bên thứ ba (LNH-T20, LNH-T45)
//   region      nơi nền tảng phổ biến: mã nước ISO hoặc nhãn nhóm. Kiến thức chung, CHƯA kiểm; không hiển thị
//   share       cách tới được nền tảng từ trình duyệt:
//               "link"       có liên kết chia sẻ mở cửa sổ soạn bài của chính nền tảng, không cần đăng ký
//               "needs_id"   nút chia sẻ cần mã ứng dụng hoặc tài khoản chính thức do LeDB đăng ký (LeDB chưa đăng ký)
//               "sheet_only" không có liên kết trên web; chỉ tới được qua bảng chia sẻ của thiết bị hoặc sao chép
//               "none"       không chia sẻ (chỉ `mock`)
//   template    mẫu liên kết của mục "link"; {text} và {url} là chỗ điền. Mẫu của mục chưa bật chép từ khảo sát để sau này
//               bật bằng một dòng; chúng KHÔNG được dùng để dựng liên kết nào
//   host        tên máy chủ cố định của mẫu https; buildShareUrl() đối chiếu lại trước khi trả kết quả
//   needs_url   mẫu bắt buộc có liên kết: chỉ dùng được khi LeNhip có địa chỉ công khai (LNH-Q13)
//   enabled     liên kết chia sẻ đang bật. Chỉ Threads, X, Telegram, LINE, Bluesky (LNH-T40)
//   link        bản dựng này liên kết tài khoản được hay không: chỉ `mock` (LNH-T42)
//   api_post    bản dựng này đăng qua API được hay không: chỉ `mock` (LNH-T43)
//   simulated   nhà cung cấp giả lập, không phải nền tảng thật (LNH-T44)
//   evidence    mức bằng chứng của thông tin chia sẻ (LNH-F26). Phiên khảo sát không mở trực tiếp được trang tài liệu của
//               nền tảng nào; mức cao nhất là "official_via_search": tài liệu chính thức, đọc qua tóm tắt của công cụ tìm kiếm
//
// Hai cờ `link` và `api_post` nói về bản dựng này, không nói nền tảng có API hay không (LNH-F21: mọi nền tảng lớn đều đòi
// đăng ký ứng dụng; LeDB chưa đăng ký ứng dụng nào).
// Threads: khảo sát thấy thêm tham số `url`, nhưng chỉ trong một bản tài liệu cũ, nên mẫu đang bật chỉ dùng `text` và liên
// kết đi trong văn bản. Viber có mức bằng chứng cao nhưng mẫu là lược đồ ứng dụng (`viber://`), không phải https: không bật.
import { joinNoteAndUrl, normalizePublicUrl, toWellFormed } from "./share-card.js";

/** @typedef {"link" | "needs_id" | "sheet_only" | "none"} ShareMode */
/** @typedef {"official_via_search" | "partial" | "secondary_only" | "unverified" | "internal"} EvidenceGrade */
/** @typedef {"link_on" | "link_off" | "needs_id" | "sheet_only"} ShareReach */
/** @typedef {"on" | "wait_url" | "unconfirmed" | "app_scheme" | "needs_id" | "sheet_only"} ShareStatus */
/**
 * @typedef {object} SocialPlatform
 * @property {string} id
 * @property {string} name
 * @property {readonly string[]} region
 * @property {ShareMode} share
 * @property {string | null} template
 * @property {string | null} host
 * @property {boolean} needs_url
 * @property {boolean} enabled
 * @property {boolean} link
 * @property {boolean} api_post
 * @property {boolean} simulated
 * @property {EvidenceGrade} evidence
 */

/** Mức bằng chứng, từ mạnh tới yếu. "internal" chỉ dành cho `mock`: không có gì để khảo sát. */
export const EVIDENCE_GRADES = Object.freeze(/** @type {const} */ (["official_via_search", "partial", "secondary_only", "unverified", "internal"]));
/** Nhóm theo cách tới được nền tảng, theo thứ tự hiển thị trong danh mục. */
export const SHARE_REACHES = Object.freeze(/** @type {const} */ (["link_on", "link_off", "needs_id", "sheet_only"]));
/** Trạng thái của một nền tảng trong danh mục. */
export const SHARE_STATUSES = Object.freeze(/** @type {const} */ (["on", "wait_url", "unconfirmed", "app_scheme", "needs_id", "sheet_only"]));

/**
 * @param {string} id
 * @param {string} name
 * @param {string[]} region
 * @param {ShareMode} share
 * @param {EvidenceGrade} evidence
 * @param {{ template?: string, host?: string, needs_url?: true, enabled?: true, link?: true, api_post?: true, simulated?: true }} [o]
 * @returns {SocialPlatform}
 */
function row(id, name, region, share, evidence, o = {}) {
  return Object.freeze({
    id, name, region: Object.freeze(region), share,
    template: o.template ?? null, host: o.host ?? null, needs_url: o.needs_url === true, enabled: o.enabled === true,
    link: o.link === true, api_post: o.api_post === true, simulated: o.simulated === true, evidence,
  });
}

/** @type {readonly SocialPlatform[]} */
export const SOCIAL_PLATFORMS = Object.freeze([
  row("facebook", "Facebook", ["global"], "link", "partial", { template: "https://www.facebook.com/sharer/sharer.php?u={url}", host: "www.facebook.com", needs_url: true }),
  row("instagram", "Instagram", ["global"], "sheet_only", "official_via_search"),
  row("threads", "Threads", ["global"], "link", "official_via_search", { template: "https://www.threads.com/intent/post?text={text}", host: "www.threads.com", enabled: true }),
  row("messenger", "Messenger", ["global"], "needs_id", "official_via_search"),
  row("whatsapp", "WhatsApp", ["global"], "link", "secondary_only", { template: "https://wa.me/?text={text}", host: "wa.me" }),
  row("x", "X (Twitter)", ["global"], "link", "official_via_search", { template: "https://x.com/intent/tweet?text={text}&url={url}", host: "x.com", enabled: true }),
  row("tiktok", "TikTok", ["global-not-cn"], "sheet_only", "partial"),
  row("youtube", "YouTube", ["global-not-cn"], "sheet_only", "partial"),
  row("linkedin", "LinkedIn", ["global-not-cn"], "link", "partial", { template: "https://www.linkedin.com/sharing/share-offsite/?url={url}", host: "www.linkedin.com", needs_url: true }),
  row("pinterest", "Pinterest", ["global"], "link", "partial", { template: "https://www.pinterest.com/pin/create/button/?url={url}&media={image}&description={text}", host: "www.pinterest.com" }),
  row("reddit", "Reddit", ["global"], "link", "partial", { template: "https://www.reddit.com/submit?url={url}&title={title}", host: "www.reddit.com" }),
  row("snapchat", "Snapchat", ["global"], "link", "partial", { template: "https://www.snapchat.com/share?link={url}", host: "www.snapchat.com", needs_url: true }),
  row("telegram", "Telegram", ["global"], "link", "official_via_search", { template: "https://t.me/share/url?url={url}&text={text}", host: "t.me", needs_url: true, enabled: true }),
  row("discord", "Discord", ["global-not-cn"], "sheet_only", "official_via_search"),
  row("zalo", "Zalo", ["VN"], "needs_id", "secondary_only"),
  row("line", "LINE", ["JP", "TW", "TH", "ID"], "link", "official_via_search", { template: "https://social-plugins.line.me/lineit/share?url={url}&text={text}", host: "social-plugins.line.me", needs_url: true, enabled: true }),
  row("kakaotalk", "KakaoTalk", ["KR"], "needs_id", "partial"),
  row("kakaostory", "Kakao Story", ["KR"], "sheet_only", "partial"),
  row("naver", "Naver", ["KR"], "link", "secondary_only", { template: "https://share.naver.com/web/shareView?url={url}&title={title}", host: "share.naver.com", needs_url: true }),
  row("band", "BAND", ["KR", "JP", "US"], "link", "unverified", { template: "https://band.us/plugin/share?body={text}&route={site}", host: "band.us" }),
  row("wechat", "WeChat", ["CN", "zh-speaking"], "sheet_only", "secondary_only"),
  row("weibo", "Weibo", ["CN"], "link", "secondary_only", { template: "https://service.weibo.com/share/share.php?url={url}&title={text}&pic={image}&appkey={appkey}", host: "service.weibo.com", needs_url: true }),
  row("qq_qzone", "QQ / Qzone", ["CN"], "link", "secondary_only", { template: "https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url={url}&title={title}&summary={text}&pics={image}&site={site}", host: "sns.qzone.qq.com", needs_url: true }),
  row("douyin", "Douyin", ["CN"], "sheet_only", "secondary_only"),
  row("xiaohongshu", "Xiaohongshu", ["CN"], "sheet_only", "secondary_only"),
  row("vk", "VK", ["RU", "cis"], "link", "partial", { template: "https://vk.com/share.php?url={url}&title={title}&image={image}", host: "vk.com", needs_url: true }),
  row("ok", "Odnoklassniki (OK)", ["RU", "cis"], "link", "partial", { template: "https://connect.ok.ru/offer?url={url}&title={title}&imageUrl={image}", host: "connect.ok.ru", needs_url: true }),
  row("mastodon", "Mastodon", ["global"], "link", "partial", { template: "https://{instance}/share?text={text}" }),
  row("bluesky", "Bluesky", ["global"], "link", "official_via_search", { template: "https://bsky.app/intent/compose?text={text}", host: "bsky.app", enabled: true }),
  row("tumblr", "Tumblr", ["global"], "link", "secondary_only", { template: "https://www.tumblr.com/widgets/share/tool?canonicalUrl={url}&title={title}&caption={text}&tags={tags}&posttype=link", host: "www.tumblr.com", needs_url: true }),
  row("viber", "Viber", ["eastern-europe", "PH", "VN", "mena"], "link", "official_via_search", { template: "viber://forward?text={text}" }),
  row("twitch", "Twitch", ["global-not-cn"], "sheet_only", "partial"),
  row("ms_teams", "Microsoft Teams", ["global"], "link", "partial", { template: "https://teams.microsoft.com/share?href={url}&msgText={text}", host: "teams.microsoft.com", needs_url: true }),
  row("kuaishou", "Kuaishou", ["CN"], "sheet_only", "secondary_only"),
  // Nhà cung cấp giả lập cho liên kết tài khoản và đăng qua API (LNH-T42..LNH-T44). Không phải nền tảng thật, không nằm
  // trong danh mục 34 nền tảng, không có liên kết chia sẻ. Tên hiển thị lấy từ catalog, không lấy `name` này.
  row("mock", "Mock", [], "none", "internal", { link: true, api_post: true, simulated: true }),
]);

/** @type {ReadonlyMap<string, SocialPlatform>} */
const BY_ID = new Map(SOCIAL_PLATFORMS.map((p) => [p.id, p]));

/**
 * @param {unknown} id
 * @returns {SocialPlatform | null}
 */
export function platformById(id) {
  return typeof id === "string" ? BY_ID.get(id) ?? null : null;
}

/**
 * Nhóm của một nền tảng trong danh mục; null với `mock`.
 * @param {SocialPlatform} p
 * @returns {ShareReach | null}
 */
export function shareReach(p) {
  if (p.share === "link") return p.enabled ? "link_on" : "link_off";
  return p.share === "none" ? null : p.share;
}

/**
 * Trạng thái của một nền tảng trong danh mục; null với `mock`.
 * @param {SocialPlatform} p
 * @param {boolean} hasPublicUrl LeNhip có địa chỉ công khai hay chưa
 * @returns {ShareStatus | null}
 */
export function shareStatus(p, hasPublicUrl) {
  if (p.share === "none") return null;
  if (p.share !== "link") return p.share;
  if (p.enabled) return p.needs_url && !hasPublicUrl ? "wait_url" : "on";
  return p.template !== null && p.template.startsWith("https://") ? "unconfirmed" : "app_scheme";
}

/**
 * Nền tảng có liên kết chia sẻ dùng được ngay, theo thứ tự của danh mục. Mục cần liên kết (Telegram, LINE) chỉ có mặt khi
 * LeNhip có địa chỉ công khai.
 * @param {boolean} hasPublicUrl
 */
export function shareLinkPlatforms(hasPublicUrl) {
  return SOCIAL_PLATFORMS.filter((p) => shareStatus(p, hasPublicUrl) === "on");
}

/** Mã hóa một giá trị tham số: encodeURIComponent, thêm bốn ký tự dành riêng của RFC 3986 mà hàm đó để nguyên. */
const encode = (/** @type {string} */ value) => encodeURIComponent(toWellFormed(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const SLOT = /^([A-Za-z][A-Za-z0-9_]*)=\{(text|url)\}$/;

/**
 * Liên kết mở cửa sổ soạn bài của một nền tảng, hoặc null. Chỉ dựng cho mục "link" đang bật; tên máy chủ chỉ lấy từ danh
 * mục; luôn là https; từng tham số qua encodeURIComponent; kết quả được phân tích lại và đối chiếu với `host` trước khi trả.
 * Trả null khi: nền tảng lạ hoặc chưa bật, thẻ rỗng, thiếu liên kết mà mẫu bắt buộc có, hoặc `url` không phải địa chỉ công
 * khai hợp lệ. Không cắt bớt và không sửa ghi chú.
 * @param {unknown} platformId
 * @param {{ note?: string | null, url?: string | null } | null | undefined} content ghi chú và liên kết LeNhip của thẻ
 * @returns {string | null}
 */
export function buildShareUrl(platformId, content) {
  const p = platformById(platformId);
  if (!p || p.share !== "link" || p.enabled !== true || p.template === null || p.host === null) return null;
  if (content === null || typeof content !== "object") return null;
  const note = typeof content.note === "string" ? content.note : "";
  let url = null;
  if (content.url !== undefined && content.url !== null) {
    url = normalizePublicUrl(content.url);
    if (url === null) return null;
  }
  if (p.needs_url && url === null) return null;
  const mark = p.template.indexOf("?");
  if (mark < 0) return null;
  const base = p.template.slice(0, mark);
  const slots = p.template.slice(mark + 1).split("&").map((part) => SLOT.exec(part));
  if (!base.startsWith("https://" + p.host + "/") || slots.some((m) => m === null)) return null;
  // Mẫu không có chỗ riêng cho liên kết (Threads, Bluesky): liên kết đi trong văn bản, đúng như ô xem trước.
  const hasUrlSlot = slots.some((m) => m !== null && m[2] === "url");
  /** @type {Record<string, string>} */
  const values = { text: hasUrlSlot ? note : joinNoteAndUrl(note, url), url: hasUrlSlot && url !== null ? url : "" };
  if (values.text === "" && values.url === "") return null;
  /** @type {string[]} */
  const query = [];
  for (const m of slots) if (m !== null && values[m[2]] !== "") query.push(m[1] + "=" + encode(values[m[2]]));
  const out = base + "?" + query.join("&");
  let parsed;
  try {
    parsed = new URL(out);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.host !== p.host || parsed.username !== "" || parsed.password !== "" || parsed.origin + parsed.pathname !== base || parsed.href !== out) return null;
  return out;
}

/**
 * Liên kết `mailto:` không có người nhận, hoặc null khi nội dung rỗng. Xuống dòng trong thư là CRLF (RFC 6068).
 * @param {{ subject?: string | null, body?: string | null } | null | undefined} mail
 * @returns {string | null}
 */
export function buildMailtoUrl(mail) {
  if (mail === null || typeof mail !== "object" || typeof mail.body !== "string" || mail.body === "") return null;
  const subject = typeof mail.subject === "string" && mail.subject !== "" ? "subject=" + encode(mail.subject) + "&" : "";
  return "mailto:?" + subject + "body=" + encode(mail.body.replace(/\r\n?|\n/g, "\r\n"));
}
