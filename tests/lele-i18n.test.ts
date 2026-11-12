// LeLe đa ngôn ngữ, đóng khi không chắc (LNH-T24, sửa LNH-F24): bảng từ dùng chung của thiết bị và máy chủ
// (web/shared/lele-lexicon.js và 13 tệp lele-lex-<file>.js). Kiểm: dạng tệp; câu mẫu của từng ngôn ngữ → lệnh, chặn sức khỏe,
// chặn dữ liệu cá nhân; câu mẫu trong catalog giao diện được nhận ra; máy chủ chặn câu sức khỏe gửi thẳng tới API ở cả 13 ngôn
// ngữ và không để lại câu chữ nào trong cơ sở dữ liệu, sổ, hay bảng idem_keys.
//
// Chỉ kiểm một ngôn ngữ (người rà soát làm song song): LENHIP_I18N_ONLY=fr node --test tests/lele-i18n.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCALES } from "../web/shared/i18n.js";
import { LELE_RULES_VERSION, LEXICONS, LEXICON_LISTS, LEXICON_OPTIONAL_LISTS, leleBlock, normalizeLele, scanLele } from "../web/shared/lele-lexicon.js";
import { ANSWERS, LocalRulesProvider, ModelGateway, VENDOR_PROFILES, type ModelProvider } from "../src/server/lele.ts";
import { SCHEMAS } from "../src/server/app.ts";
import { all } from "../src/server/store.ts";
import { parseStrictJson } from "../src/core/strict-json.ts";
import { harness } from "./helpers.ts";

const ONLY = process.env.LENHIP_I18N_ONLY || null;
const shared = new URL("../web/shared/", import.meta.url);
const ZONE = "Asia/Ho_Chi_Minh";

type Expect = "ON" | "OFF" | "HEALTH" | "PII" | null | [minutes: number, time: string, tomorrow?: boolean];
/** Kết quả của scanLele ở dạng gọn để so với bảng mẫu. */
function verdict(text: string): Expect {
  const scan = scanLele(text);
  const blocked = leleBlock(scan);
  if (blocked) return blocked;
  const i = scan.intent;
  if (!i) return null;
  if (i.kind === "device.set_power") return i.command === "SET_ON" ? "ON" : "OFF";
  const time = `${String(i.hour).padStart(2, "0")}:${String(i.minute).padStart(2, "0")}`;
  return i.tomorrow ? [i.minutes, time, true] : [i.minutes, time];
}

// Mỗi ngôn ngữ ít nhất sáu câu: bật, tắt, khung giờ, khung giờ ngày mai, câu sức khỏe, câu sức khỏe nằm trong lệnh đèn, và câu
// thường không phải lệnh. Câu sức khỏe đầu tiên của mỗi ngôn ngữ (HEALTH_TEXT) còn được gửi thẳng tới máy chủ ở phép kiểm dưới.
const SAMPLES: Record<string, [string, Expect][]> = {
  vi: [
    ["mở đèn bàn", "ON"], ["Bật đèn bàn giúp tôi", "ON"], ["tắt đèn trần", "OFF"], ["dành 30 phút lúc 15:00", [30, "15:00"]], ["Dành 30 phút tập trung lúc 17:00 ngày mai", [30, "17:00", true]],
    ["dành 2 giờ lúc 15 giờ", [120, "15:00"]], ["giữ 45 phút lúc 3 giờ rưỡi chiều", [45, "15:30"]], ["tối qua tôi ngủ kém", "HEALTH"], ["bật đèn bàn, tôi đang đau đầu", "HEALTH"],
    ["huyet ap cua toi hom nay cao", "HEALTH"], ["gọi 0912345678 rồi đặt 30 phút lúc 15:00", "PII"], ["số cccd của tôi", "PII"], ["xin chào", null], ["hôm nay trời đẹp", null],
  ],
  en: [
    ["turn on the desk lamp", "ON"], ["turn the light on", "ON"], ["turn off the light on the desk", "OFF"], ["block 30 minutes at 15:00", [30, "15:00"]], ["Reserve 1 hour 30 minutes at 3 pm tomorrow", [90, "15:00", true]],
    ["I slept badly last night and my heart rate is high", "HEALTH"], ["turn on the lamp, I have a headache", "HEALTH"], ["block 30 minutes at 15:00 for my doctor", "HEALTH"],
    ["my email is someone@example.org", "PII"], ["my password is hunter", "PII"], ["hello there", null], ["what a nice day", null],
  ],
  fr: [
    ["allume la lampe du bureau", "ON"], ["éteins la lumière", "OFF"], ["eteins la lumiere", "OFF"], ["bloque 30 minutes à 15h", [30, "15:00"]], ["réserve 45 minutes à 15h30 demain", [45, "15:30", true]],
    ["j'ai mal dormi, ma tension est élevée", "HEALTH"], ["allume la lampe, j'ai de la fièvre", "HEALTH"], ["voici mon mot de passe", "PII"], ["bonjour tout le monde", null], ["il fait beau", null],
    ["coupe la lumière du salon", "OFF"], ["garde-moi 45 minutes à 3h de l'après-midi", [45, "15:00"]], ["je suis au régime depuis lundi", "HEALTH"],
  ],
  "zh-Hans": [
    ["打开台灯", "ON"], ["把灯关了", "OFF"], ["开会前关灯", "OFF"], ["15点留出30分钟", [30, "15:00"]], ["明天下午3点半预留30分钟", [30, "15:30", true]], ["昨晚没睡好，心跳很快", "HEALTH"], ["打开台灯，我头痛", "HEALTH"],
    ["我的身份证号码", "PII"], ["你好", null], ["今天天气不错", null],
    ["明晚8点半预留45分钟", [45, "20:30", true]], ["帮我把夜灯熄掉", "OFF"], ["我血糖有点高", "HEALTH"], ["我的支付宝账号", "PII"],
  ],
  ko: [
    ["스탠드 켜줘", "ON"], ["불 꺼줘", "OFF"], ["스탠드 꺼내서 켜줘", "ON"], ["15시에 30분 예약해줘", [30, "15:00"]], ["내일 오후 3시에 30분 비워줘", [30, "15:00", true]], ["어젯밤에 잠을 잘 못 잤어요", "HEALTH"], ["조명 켜줘, 두통이 심해", "HEALTH"],
    ["제 비밀번호는", "PII"], ["안녕하세요", null], ["오늘 날씨가 좋네요", null],
    ["아파트 조명 꺼줘", "OFF"], ["15시에 30분 예약을 잡아줘", [30, "15:00"]], ["내일 오후 3시 반에 45분 잡아줘", [45, "15:30", true]], ["머리 아파", "HEALTH"], ["주민번호 알려줄게요", "PII"],
  ],
  ja: [
    ["デスクライトをつけて", "ON"], ["電気を消して", "OFF"], ["オフィスのライトをつけて", "ON"], ["オンライン会議の前にライトを消して", "OFF"], ["15時に30分確保して", [30, "15:00"]], ["明日15時から2時間ブロックして", [120, "15:00", true]], ["昨夜はよく眠れませんでした", "HEALTH"], ["ライトをつけて、頭痛がする", "HEALTH"],
    ["パスワードを教えます", "PII"], ["こんにちは", null], ["今日はいい天気ですね", null],
    ["電気を付けて", "ON"], ["明日の午後3時半に45分おさえて", [45, "15:30", true]], ["お疲れ様です、デスクライトをつけて", "ON"], ["血圧が高めです", "HEALTH"],
  ],
  es: [
    ["enciende la lámpara", "ON"], ["apaga la luz", "OFF"], ["reserva 30 minutos a las 15:00", [30, "15:00"]], ["bloquea 30 minutos a las 9 de la mañana", [30, "09:00"]], ["reserva 30 minutos a las 15:00 mañana", [30, "15:00", true]],
    ["anoche dormí mal y me duele la cabeza", "HEALTH"], ["enciende la luz, tengo fiebre", "HEALTH"], ["mi contraseña es esta", "PII"], ["hola a todos", null], ["hace buen tiempo", null],
    ["reserva 45 minutos a las 3 y media de la tarde", [45, "15:30"]], ["prende el foco de la entrada", "ON"], ["apágame la luz del salón", "OFF"], ["reserva 2 horas y 30 minutos", null], ["estoy con gripa y calentura", "HEALTH"], ["mi curp es esta", "PII"],
  ],
  "pt-BR": [
    ["acenda a luz", "ON"], ["desligue a luminária", "OFF"], ["reserve 30 minutos às 15:00", [30, "15:00"]], ["bloqueie 30 minutos às 15h amanhã", [30, "15:00", true]], ["dormi mal e estou com dor de cabeça", "HEALTH"],
    ["acenda a luz, estou com febre", "HEALTH"], ["minha senha é esta", "PII"], ["olá pessoal", null], ["o tempo está bom", null],
    ["reserve 45 minutos às 3 e meia da tarde", [45, "15:30"]], ["reserve 2 horas às 15h", [120, "15:00"]], ["vou ligar para o cliente, reserve 30 minutos de foco às 15h", [30, "15:00"]], ["que droga, apague a luz", "OFF"], ["minha cabeça dói muito", "HEALTH"], ["meu cpf é esse", "PII"], ["saudade de você", null],
  ],
  it: [
    ["accendi la lampada", "ON"], ["spegni la luce", "OFF"], ["sono occupato, blocca 30 minuti alle 15", [30, "15:00"]], ["riserva 45 minuti alle 15:30 domani", [45, "15:30", true]], ["ho dormito male e ho mal di testa", "HEALTH"],
    ["accendi la luce, ho la febbre", "HEALTH"], ["il mio codice fiscale", "PII"], ["ciao a tutti", null], ["oggi c'è il sole", null],
    ["tienimi 2 ore dalle 14", [120, "14:00"]], ["segna 20 min alle 3 del pomeriggio", [20, "15:00"]], ["non sto bene oggi", "HEALTH"], ["la password del wifi", "PII"],
  ],
  "zh-Hant": [
    ["打開檯燈", "ON"], ["把燈關掉", "OFF"], ["開會前關燈", "OFF"], ["15點保留30分鐘", [30, "15:00"]], ["明天15:00預留30分鐘", [30, "15:00", true]], ["昨晚失眠了，頭很痛", "HEALTH"], ["打開檯燈，我發燒了", "HEALTH"],
    ["我的身分證字號", "PII"], ["你好", null], ["今天天氣不錯", null],
    ["今晚8點留45分鐘", [45, "20:00"]], ["把桌燈關掉", "OFF"], ["我要去看牙", "HEALTH"], ["我的統編", "PII"],
  ],
  id: [
    ["nyalakan lampu", "ON"], ["matikan lampu meja", "OFF"], ["blokir 30 menit pukul 15.00", [30, "15:00"]], ["sisihkan 2 jam jam 3 sore besok", [120, "15:00", true]], ["semalam saya kurang tidur dan pusing", "HEALTH"],
    ["nyalakan lampu, saya demam", "HEALTH"], ["kata sandi saya", "PII"], ["halo semuanya", null], ["rapat tim berjalan baik", null],
    ["tolong lampunya dimatikan", "OFF"], ["hidupin lampu ruang tamu dong", "ON"], ["jadwalkan waktu pribadi 60 menit mulai 14.00", [60, "14:00"]], ["sisihkan 30 menit jam 11 untuk makan siang", [30, "11:00"]], ["tadi malam saya ketiduran", "HEALTH"], ["ktp saya hilang", "PII"],
  ],
  ru: [
    ["включи лампу", "ON"], ["выключи свет", "OFF"], ["заблокируй 30 минут в 15:00", [30, "15:00"]], ["забронируй 2 часа в 15:00 завтра", [120, "15:00", true]], ["я плохо спал и болит голова", "HEALTH"],
    ["включи свет, у меня температура", "HEALTH"], ["мой пароль такой", "PII"], ["привет всем", null], ["сегодня хорошая погода", null],
    ["погаси торшер", "OFF"], ["выдели 45 минут в 3 часа дня", [45, "15:00"]], ["забронируй час в 10:00 к стоматологу", "HEALTH"], ["мой СНИЛС", "PII"],
  ],
  de: [
    ["schalte die Lampe ein", "ON"], ["Schalte die Lampe an der Wand aus", "OFF"], ["mach das Licht aus", "OFF"], ["blocke 30 Minuten um 15 Uhr", [30, "15:00"]], ["reserviere 45 Minuten um 15:30 morgen", [45, "15:30", true]],
    ["ich habe schlecht geschlafen und Kopfschmerzen", "HEALTH"], ["mach das Licht an, ich habe Fieber", "HEALTH"], ["mein Passwort lautet so", "PII"], ["hallo zusammen", null], ["dort drüben ist es schön", null],
    ["knips die Stehlampe an", "ON"], ["halte 2 Stunden um 9 Uhr morgen frei", [120, "09:00", true]], ["blocke 30 Minuten um 15 Uhr für den Zahnarzt", "HEALTH"], ["meine IBAN lautet", "PII"],
  ],
};
/** Câu sức khỏe đầu tiên của mỗi ngôn ngữ. */
const healthText = (tag: string) => SAMPLES[tag].find(([, want]) => want === "HEALTH")![0];
const tags = LOCALES.map((l) => l.tag).filter((tag) => !ONLY || tag === ONLY);

test("bảng từ: 13 tệp đúng thứ tự LOCALES, JSON chặt, đủ danh sách, mục từ chữ thường đã chuẩn hóa, bản không phải tiếng Việt ghi draft", () => {
  assert.match(LELE_RULES_VERSION, /^lele-rules-\d+\.\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(LEXICONS.map((l) => l.tag), LOCALES.map((l) => l.tag), "một bảng từ cho mỗi ngôn ngữ, cùng thứ tự");
  assert.deepEqual(readdirSync(shared).filter((f) => f.startsWith("lele-lex-")).sort(), LOCALES.map((l) => `lele-lex-${l.file}.js`).sort());
  const allowed = new Set(["tag", "draft", "pick", ...LEXICON_LISTS, ...LEXICON_OPTIONAL_LISTS]);
  for (const locale of LOCALES) {
    if (ONLY && locale.tag !== ONLY) continue;
    const name = `lele-lex-${locale.file}.js`;
    const text = readFileSync(new URL(name, shared), "utf8");
    assert.ok(text.startsWith("export default {") && text.endsWith("};\n"), `${name}: đúng dạng export default + JSON + ;`);
    const data = parseStrictJson(text.slice("export default ".length, -2), 8) as Record<string, unknown>; // JSON chặt: khóa trùng cũng bị từ chối
    assert.ok(Object.is(JSON.stringify(data), JSON.stringify(LEXICONS.find((l) => l.tag === locale.tag))), `${name}: nội dung nạp được trùng tệp trên đĩa`);
    assert.equal(data.tag, locale.tag, name);
    assert.equal(data.draft, locale.tag !== "vi", `${name}: draft là true với mọi bản không phải tiếng Việt`);
    assert.deepEqual(Object.keys(data).filter((k) => !allowed.has(k)), [], `${name}: khóa lạ`);
    if ("pick" in data) assert.equal(data.pick, "last", name);
    for (const key of [...LEXICON_LISTS, ...LEXICON_OPTIONAL_LISTS]) {
      if (!(key in data) && LEXICON_OPTIONAL_LISTS.includes(key)) continue;
      const list = data[key] as string[];
      assert.ok(Array.isArray(list), `${name}: ${key} phải là mảng`);
      // Ngôn ngữ đặt giờ bằng dấu đứng sau con số (15時, 15点, 15시) không cần từ đứng trước, và ngược lại.
      if (key !== "at" && key !== "oclock") assert.ok(list.length > 0, `${name}: ${key} rỗng`);
      assert.equal(new Set(list).size, list.length, `${name}: ${key} có mục lặp`);
      for (const term of list) {
        assert.equal(typeof term, "string", `${name}: ${key}`);
        assert.equal(term, term.normalize("NFKC").toLowerCase(), `${name}: ${key} «${term}» phải là chữ thường đã chuẩn hóa NFKC`);
        assert.match(term, /^\*?[^\s*](?:[^*]*[^\s*])?\*?$/u, `${name}: ${key} «${term}»: dấu * chỉ ở đầu hoặc cuối, không khoảng trắng thừa`);
        assert.doesNotMatch(term, / {2}|[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF<>]/, `${name}: ${key} «${term}» có ký tự lạ`);
      }
    }
    assert.ok((data.at as string[]).length + (data.oclock as string[]).length > 0, `${name}: cần từ đứng trước giờ hoặc dấu giờ`);
    assert.ok((data.health as string[]).length >= 40, `${name}: danh sách sức khỏe cố ý rộng (ít nhất 40 mục)`);
  }
  assert.equal(normalizeLele("  To\u0302\u0301i  QUA\u200B \uFF4E\uFF47u\u0309 \uFF11\uFF15\uFF1A\uFF10\uFF10 "), "tối qua ngủ 15:00", "NFKC, chữ thường, bỏ ký tự ẩn, gộp khoảng trắng");
});

for (const tag of tags) {
  test(`câu mẫu ${tag}: lệnh đèn, lệnh khung giờ, chặn sức khỏe, chặn dữ liệu cá nhân, câu thường`, () => {
    const rows = SAMPLES[tag];
    assert.ok(rows.length >= 6, tag);
    for (const [text, want] of rows) {
      assert.deepEqual(verdict(text), want, `${tag}: «${text}»`);
      // Dạng tổ hợp (NFD) và chữ hoa cho cùng kết quả.
      assert.deepEqual(verdict(text.normalize("NFD").toUpperCase()), want, `${tag}: «${text}» ở dạng NFD viết hoa`);
    }
    for (const kind of ["ON", "OFF", "HEALTH", "PII", null]) assert.ok(rows.some(([, want]) => want === kind), `${tag}: thiếu câu mẫu loại ${kind}`);
    assert.ok(rows.filter(([, want]) => Array.isArray(want)).length >= 2, `${tag}: cần ít nhất hai câu khung giờ`);
  });
}

test("«mở đèn bàn» được nhận ra (ranh giới từ theo Unicode); tiếng Việt tổ hợp; câu trộn ngôn ngữ; từ sức khỏe của mọi ngôn ngữ đều chặn", () => {
  assert.deepEqual(scanLele("mở đèn bàn").intent, { kind: "device.set_power", command: "SET_ON" });
  assert.deepEqual(scanLele("đèn bàn: mở").intent, { kind: "device.set_power", command: "SET_ON" }, "«mở» ở cuối câu");
  assert.equal(verdict("tối qua tôi ngủ kém".normalize("NFD")), "HEALTH", "tiếng Việt ở dạng tổ hợp (NFD)");
  assert.notEqual("tối qua tôi ngủ kém".normalize("NFD"), "tối qua tôi ngủ kém");
  // Trộn ngôn ngữ: lệnh của một ngôn ngữ, từ sức khỏe của ngôn ngữ khác; chữ toàn chiều rộng; ký tự ẩn chẻ đôi từ.
  for (const text of ["turn on the lamp vì tôi mất ngủ", "bật đèn bàn because of my insomnia", "allume la lampe, ich habe Fieber", "电気を消して 我头痛", "block 30 minutes at 15:00 für den Arzt",
    "ｓｌｅｅｐ badly", "sle\u200Bep badly", "turn off the light 昨夜はよく眠れませんでした"]) assert.equal(verdict(text), "HEALTH", text);
  // Mỗi câu sức khỏe của một ngôn ngữ bị chặn dù đứng sau lệnh hợp lệ của ngôn ngữ khác.
  for (const tag of tags) for (const command of ["bật đèn bàn", "turn off the desk lamp", "block 30 minutes at 15:00"]) assert.equal(verdict(`${command}. ${healthText(tag)}`), "HEALTH", `${command} + ${tag}`);
  // Dữ liệu cá nhân theo hình dạng, không theo ngôn ngữ.
  for (const text of ["bật đèn rồi gọi 0912 345 678", "block 30 minutes at 15:00, card 4111-1111-1111-1111", "写信给 someone@example.org", "+84 912.345.678"]) assert.equal(verdict(text), "PII", text);
  // Giờ và ngày không phải dãy số bị chặn.
  assert.deepEqual(verdict("block 30 minutes at 15:00 tomorrow"), [30, "15:00", true]);
  // Bật và tắt cùng lúc: lấy từ đứng trước (tiếng Đức: từ đứng sau cùng).
  assert.equal(verdict("turn off the lamp then turn on the light"), "OFF");
  // Thời lượng ngoài 5–240 phút vẫn là lệnh: máy chủ trả lời bằng mã DURATION_RANGE.
  assert.deepEqual(verdict("dành 300 phút lúc 15:00"), [300, "15:00"]);
  assert.equal(verdict("dành 30 phút lúc 25:00"), null, "giờ không hợp lệ thì không phải lệnh");
  assert.equal(verdict("dành 30 phút"), null, "thiếu giờ thì không phải lệnh");
  assert.equal(scanLele("đổi màu giao diện").ui, true);
  assert.equal(scanLele("change the theme colour").ui, true);
});

test("câu dài nhất mà API nhận (4.000 ký tự) được đọc nhanh: phép chặn không là điểm làm nghẽn máy chủ", () => {
  const worst = ["bật đèn ".repeat(500), "lúc 15 giờ ".repeat(360), "a".repeat(4000), "漢".repeat(4000), "x@".repeat(2000), "1 ".repeat(2000), "block 30 minutes at 15:00 ".repeat(150)];
  scanLele("khởi động"); // lần đầu dựng biểu thức
  const started = performance.now();
  for (const text of worst) scanLele(text);
  const took = performance.now() - started;
  assert.ok(took < 1500, `bảy câu 4.000 ký tự mất ${took.toFixed(0)} ms (thường dưới 100 ms)`);
});

test("câu lệnh mẫu trong catalog giao diện của từng ngôn ngữ được bảng từ nhận ra và không bị chặn", () => {
  for (const locale of LOCALES) {
    if (ONLY && locale.tag !== ONLY && locale.tag !== "vi") continue;
    let text: string;
    try {
      text = readFileSync(new URL(`i18n-${locale.file}.js`, shared), "utf8");
    } catch {
      continue; // catalog chưa có
    }
    const catalog = parseStrictJson(text.slice("export default ".length, -2), 64) as Record<string, string>;
    assert.equal(verdict(catalog["lele.example.lampOn"]), "ON", `${locale.tag}: lele.example.lampOn = «${catalog["lele.example.lampOn"]}»`);
    assert.equal(verdict(catalog["lele.example.lampOff"]), "OFF", `${locale.tag}: lele.example.lampOff = «${catalog["lele.example.lampOff"]}»`);
    assert.ok(Array.isArray(verdict(catalog["lele.example.block"])), `${locale.tag}: lele.example.block = «${catalog["lele.example.block"]}»`);
  }
});

/** Mọi tệp trong thư mục dữ liệu (cơ sở dữ liệu, WAL, sổ, tệp điều khiển) dưới dạng byte. */
function dataFiles(dir: string): { path: string; bytes: Buffer }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? dataFiles(path) : [{ path, bytes: readFileSync(path) }];
  });
}

test("máy chủ: câu sức khỏe và dữ liệu cá nhân gửi thẳng tới API bị chặn ở cả 13 ngôn ngữ, không tới nhà cung cấp, không để lại câu chữ nào", async () => {
  let providerCalls = 0;
  const local = new LocalRulesProvider();
  const recording: ModelProvider = { id: "local-rules", external: false, propose: (i) => (providerCalls++, local.propose(i)) };
  const h = await harness({ provider: recording });
  try {
    const posted: string[] = [];
    const post = async (text: string, context = "work") => {
      posted.push(text);
      const r = await h.call("POST", "/v1/lele/proposals", { body: { text, context, zone: ZONE } });
      assert.equal(r.status, 200, text);
      assert.deepEqual(SCHEMAS.validate("LeLeResult", r.body), [], text);
      return r.body;
    };
    for (const tag of tags) {
      for (const text of [healthText(tag), `bật đèn bàn. ${healthText(tag)}`, healthText(tag).normalize("NFD")]) {
        const r = await post(text, "home");
        assert.deepEqual([r.type, r.answer_code, r.answer, r.proposal, r.fallback], ["FORM", "HEALTH_LOCAL", ANSWERS.HEALTH_LOCAL, null, "NONE"], `${tag}: «${text}»`);
      }
      const pii = SAMPLES[tag].find(([, want]) => want === "PII")![0];
      assert.equal((await post(pii)).answer_code, "PII_BLOCKED", `${tag}: «${pii}»`);
    }
    assert.equal(providerCalls, 0, "câu bị chặn không tới nhà cung cấp");
    // Phép dò tự nó tìm được chuỗi có thật trong dữ liệu: tên hành động của nhật ký.
    const files = dataFiles(h.dir);
    assert.ok(files.length >= 2 && files.some((f) => f.bytes.includes(Buffer.from("lele.propose"))), "phép dò byte tìm được chuỗi có thật");
    for (const text of posted) {
      // Nguyên câu, dạng NFC và NFD, dạng JSON đã thoát ký tự, và các từ dài của câu (bỏ câu lệnh đèn tiếng Việt ghép phía trước).
      const sentence = text.replace(/^bật đèn bàn\. /, "");
      const needles = new Set([text, text.normalize("NFC"), text.normalize("NFD"), JSON.stringify(text).slice(1, -1), sentence, ...sentence.split(/[\s,，、。.]+/u).filter((w) => [...w].length >= 6)]);
      for (const needle of needles) for (const f of files) assert.ok(!f.bytes.includes(Buffer.from(needle, "utf8")), `«${needle}» còn trong ${f.path}`);
    }
    const idem = all<{ request_digest: string; body: string | null }>(h.app.ctx.db, "SELECT request_digest, body FROM idem_keys WHERE route = '/v1/lele/proposals'");
    assert.equal(idem.length, posted.length);
    for (const row of idem) {
      assert.match(row.request_digest, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(["HEALTH_LOCAL", "PII_BLOCKED"].includes((JSON.parse(row.body as string) as { answer_code: string }).answer_code));
    }
    const audits = all<{ data: string }>(h.app.ctx.db, "SELECT data FROM audit WHERE action = 'lele.propose'");
    assert.equal(audits.length, posted.length);
    for (const a of audits) assert.deepEqual(Object.keys(JSON.parse(a.data) as object).sort(), ["engine", "type"], "nhật ký chỉ giữ loại và bộ máy");

    // Lệnh hợp lệ của ngôn ngữ khác đi tiếp tới bộ quy tắc: khung giờ ngày mai bằng tiếng Anh, đèn gọi đúng tên trong dữ liệu.
    const block = await post("block 30 minutes at 15:00 tomorrow");
    assert.deepEqual([block.type, block.answer_code, block.proposal.kind], ["PROPOSAL", null, "calendar.block"]);
    assert.deepEqual([block.proposal.args.start, block.proposal.args.end, block.proposal.args.title_code], ["2026-11-12T08:00:00.000Z", "2026-11-12T08:30:00.000Z", "PERSONAL_TIME"]);
    assert.equal(block.proposal.summary, "Dành 30 phút thời gian cá nhân lúc 15:00 ngày mai", "summary tiếng Việt giữ cho client cũ");
    const lamp = await post("please turn off Đèn trần", "home");
    assert.deepEqual([lamp.type, lamp.proposal.args.device_ref, lamp.proposal.args.command], ["PROPOSAL", "dev_lamp_02", "SET_OFF"]);
    const pick = await post("schalte die Lampe ein", "home");
    assert.deepEqual([pick.type, pick.answer_code, pick.fallback, pick.answer], ["FORM", "PICK_LAMP", "device.set_power", ANSWERS.PICK_LAMP]);
    const range = await post("dành 300 phút lúc 15:00");
    assert.deepEqual([range.type, range.answer_code, range.fallback], ["FORM", "DURATION_RANGE", "calendar.block"]);
    const help = await post("hello there");
    assert.deepEqual([help.type, help.answer_code, help.answer], ["ANSWER", "HELP", ANSWERS.HELP]);
    assert.equal(providerCalls, 5);
  } finally {
    await h.close();
  }
});

test("ModelGateway: mọi câu trả lời có mã; câu nhà cung cấp tự viết không có mã; nhà cung cấp ngoài miền không nhận câu không phải lệnh", async () => {
  const limits = { inputBytes: 200, outputBytes: 8192, timeoutMs: 30 };
  const input = { text: "bật đèn", context: "home" as const, zone: ZONE, now: "2026-11-11T02:00:00.000Z", workspace_ref: "ws_demo", devices: [] };
  const gate = (provider: ModelProvider) => new ModelGateway(provider, SCHEMAS, limits);
  const fixed = (raw: string): ModelProvider => ({ id: "fixed", external: false, propose: async () => raw });
  const code = async (provider: ModelProvider, text = input.text) => {
    const r = await gate(provider).propose({ ...input, text });
    assert.deepEqual(SCHEMAS.validate("LeLeResult", r), [], JSON.stringify(r));
    return [r.type, r.answer_code, r.answer];
  };
  assert.deepEqual(await code(new LocalRulesProvider(), "x".repeat(201)), ["FORM", "TOO_LONG", ANSWERS.TOO_LONG]);
  assert.deepEqual(await code(new LocalRulesProvider()), ["FORM", "PICK_LAMP", ANSWERS.PICK_LAMP], "không có đèn nào để chọn");
  assert.deepEqual(await code({ id: "down", external: false, propose: async () => Promise.reject(new Error("x")) }), ["FORM", "UNAVAILABLE", ANSWERS.UNAVAILABLE]);
  assert.deepEqual(await code({ id: "slow", external: false, propose: () => new Promise<string>(() => undefined) }), ["FORM", "TIMEOUT", ANSWERS.TIMEOUT]);
  assert.deepEqual(await code(fixed("{not json")), ["FORM", "INVALID_PROPOSAL", ANSWERS.INVALID_PROPOSAL]);
  assert.deepEqual(await code(fixed('{"type":"FORM"}')), ["FORM", "USE_FORM", ANSWERS.USE_FORM]);
  assert.deepEqual(await code(fixed('{"type":"FORM","answer":"Tự viết","answer_code":"NOT_A_CODE"}')), ["FORM", null, "Tự viết"], "mã lạ của nhà cung cấp bị bỏ");
  assert.deepEqual(await code(fixed('{"type":"ANSWER","answer":"Tự viết"}')), ["ANSWER", null, "Tự viết"]);
  assert.deepEqual(await code(fixed('{"type":"ANSWER","answer":"x","answer_code":"HELP"}')), ["ANSWER", "HELP", "x"]);
  // Mọi mã của máy chủ có trong enum của hợp đồng và ngược lại.
  const api = parseStrictJson(readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8"), 64) as { components: { schemas: { LeLeResult: { properties: { answer_code: { enum: (string | null)[] } } } } } };
  assert.deepEqual(api.components.schemas.LeLeResult.properties.answer_code.enum, [...Object.keys(ANSWERS), null]);

  // Nhà cung cấp ngoài miền (không có cái nào được duyệt; hồ sơ dưới đây chỉ tồn tại trong phép kiểm này).
  let calls = 0;
  const external: ModelProvider = { id: "vendor-test", external: true, propose: async () => (calls++, '{"type":"ANSWER","answer":"từ mô hình"}') };
  VENDOR_PROFILES.push({ provider: "vendor-test", model: "test", region: "test", purposes: ["test"], retention_days: 0, no_training: true, dpa_ref: "test", approved_by: "test" });
  try {
    assert.deepEqual(await code(external, "kể chuyện cười đi"), ["ANSWER", "HELP", ANSWERS.HELP], "câu không phải lệnh không được gửi ra ngoài miền");
    assert.deepEqual(await code(external, healthText("ja")), ["FORM", "HEALTH_LOCAL", ANSWERS.HEALTH_LOCAL]);
    assert.equal(calls, 0);
    assert.deepEqual(await code(external, "bật đèn"), ["ANSWER", null, "từ mô hình"]);
    assert.equal(calls, 1, "chỉ lệnh đèn hoặc khung giờ, không có từ sức khỏe, mới tới nhà cung cấp ngoài miền");
  } finally {
    VENDOR_PROFILES.pop();
  }
});
