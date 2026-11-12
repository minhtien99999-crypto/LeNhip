# Bản dịch của LeNhip 1.0.0: tình trạng và điểm cần người bản ngữ rà soát

Tài liệu này phục vụ việc LNH-D13. Tiếng Việt là bản gốc. **Mười hai bản còn lại là bản dịch máy, chưa người bản ngữ nào rà soát**,
chưa CLO duyệt văn bản đồng ý và chưa chuyên gia y tế rà câu về sức khỏe; giao diện ghi rõ điều đó ở mọi ngôn ngữ ngoài tiếng Việt.

Mỗi ngôn ngữ có 794 khóa trong bốn catalog (`web/shared/i18n-<file>.js` 409 khóa, `-msg` 154, `-social` 53, `-dev` 178) và một bảng
từ cho bộ lọc của LeLe (`web/shared/lele-lex-<file>.js`). Phép kiểm tự động (`tests/i18n.test.ts`, `tests/lele-i18n.test.ts`,
`scripts/e2e-locales.mjs`) chỉ xét cấu trúc, tham số, nhánh số nhiều, độ dài nhãn, bố cục và các câu lệnh mẫu; **không xét nghĩa**.

Dưới đây là những chỗ chính người dịch (máy) tự thấy chưa chắc, ghi nguyên bằng tiếng Anh kèm câu của từng ngôn ngữ, để người rà
soát bắt đầu từ đó. Tiếng Anh do người viết tính năng soạn song song với tiếng Việt và cũng chưa được rà soát. «New samples» là
các câu đã được thêm vào `tests/lele-i18n.test.ts`. Quy tắc dịch và danh sách kiểm cho bảng từ ở đầu `web/shared/i18n.js` và
`web/shared/lele-lexicon.js`.

Điểm chung cần quyết cho mọi ngôn ngữ:

- Tiêu đề lịch «Thời gian cá nhân» giữ nguyên tiếng Việt (LNH-T26). Trong văn bản đồng ý `consent.calendar_link.body`, bản en, es,
  pt-BR, ja, ko có thêm chú giải nghĩa trong ngoặc; bản fr, it, de, ru, id, zh không có. Cần CLO chọn một cách (LNH-D14).
- Từ chỉ «site», «workspace», «bên xử lý» (processor) mỗi ngôn ngữ chọn một cách; cần thống nhất với hợp đồng và chính sách.
- Bộ lọc của LeLe chặn theo từ khóa của cả 13 ngôn ngữ cùng lúc, nên có chỗ chặn thừa (ví dụ từ sức khỏe tiếng Pháp `dorm*`
  chặn «dormitorio» tiếng Tây Ban Nha; «phòng ngủ» bị coi là câu về sức khỏe). Chặn thừa là hướng an toàn; chặn thiếu mới là lỗi.

## fr / it (36/36 checks each; 416/154/53/178 keys; 236 health terms each)
1. consent.calendar_link.body: «sous-traitant de données de l'entreprise» / «responsabile del trattamento dell'azienda» (GDPR processor term); «Thời gian cá nhân» left unglossed, unlike en.
2. consent.notice.head: rights as nouns («retrait, limitation» / «revoca, limitazione»), elliptical like vi.
3. consent.notice.title: «Notice initiale» / «Informativa iniziale».
4. nav.connect: «Connexions» / «Connessioni» may read as login.
5. dev.status.reported: «Rapporté seulement» / «Solo riferito».
6. workspace: fr «espace de travail», it «workspace».
7. health.steps.title: «Activité» / «Attività».
Lexicon: fr dropped at-word «dès», bare «régime»; it dropped at-word «a». Rule limits: «bloque 1h30 à 15h», «de 15h à 16h», «alle 15 e 30» are misread.
New samples: fr «coupe la lumière du salon» OFF; «garde-moi 45 minutes à 3h de l'après-midi» [45,15:00]; «je suis au régime depuis lundi» HEALTH. it «tienimi 2 ore dalle 14» [120,14:00]; «segna 20 min alle 3 del pomeriggio» [20,15:00]; «non sto bene oggi» HEALTH; «la password del wifi» PII.

## es (tú; 298 health terms, 57 pii) / pt-BR (você; 334 health terms, 39 pii) — 36/36 checks each
1. consent.calendar_link.body: kept «Thời gian cá nhân» and added a gloss "(en vietnamita, «Tiempo personal»)" / "(em vietnamita, “Tempo pessoal”)": an addition to legal text.
2. Same key: "encargado del tratamiento" (es) / "operador de dados" (pt) for «bên xử lý» (GDPR/LGPD terms).
3. consent.notice.head: "persona responsable de protección de datos (nombre AÚN SIN DEFINIR)" is not a statutory DPO title; "tus/seus datos" adds a possessive.
4. «site» is "sede" (es) / "local" (pt) in house.* and consent.home_control.*.
5. "workspace" left untranslated in msg.*.
6. connect.trackers.title: "Monitores de actividad/atividade" narrower than «thiết bị theo dõi».
7. dev.status.reported: "Solo por referencias" / "Só por relatos".
8. msg.thread.report: "Reportar" (es) is Latin American; Spain says "Denunciar".
9. Plurals: many is "{n} de pasos"; pt-BR one also covers 0 ("0 passo").
10. work.note adds "(en vietnamita)"; pt "luzes" for «đèn»; dev.ble.unit "latidos/min" (es) vs "bpm" (pt).
Lexicon: oclock ["h","y"] (es) / ["h","e"] (pt) with half "media"/"meia" (conjunction used as hour mark); removed "horas"/"hs" from oclock; removed bare "a"/"à" from at; replaced "salud*", "dói", "prend*". Still misread: "y cuarto", "menos cuarto", "pasado mañana" / "depois de amanhã".
Collisions across lexicons (over-blocking, safe direction): fr health "dorm*" blocks es «dormitorio», pt «dormitório»; pii "iban" (fr/it/de) blocks the Spanish verb «iban».
New samples: es "reserva 45 minutos a las 3 y media de la tarde" [45,15:30]; "prende el foco de la entrada" ON; "apágame la luz del salón" OFF; "reserva 2 horas y 30 minutos" null; "estoy con gripa y calentura" HEALTH; "mi curp es esta" PII. pt-BR "reserve 45 minutos às 3 e meia da tarde" [45,15:30]; "reserve 2 horas às 15h" [120,15:00]; "vou ligar para o cliente, reserve 30 minutos de foco às 15h" [30,15:00]; "que droga, apague a luz" OFF; "minha cabeça dói muito" HEALTH; "meu cpf é esse" PII; "saudade de você" null.

## ja (267 health terms) / ko (392 health terms) — 36/36 checks each
ja: 1. review.approve 「承認」 and every «xác nhận» of an action (not 確認). 2. consent.calendar_link.body: gloss 「(ベトナム語で「個人の時間」)」 added after the Vietnamese title. 3. «site» → 「拠点」. 4. consent.notice.title 「最初のお知らせ」 may be too light for a legal notice. 5. «bên xử lý» → 「データ処理者」. 6. outcome.NO_EFFECT 「参照元で…確認されました」 awkward. 7. error.SCHEMA_INVALID «hợp đồng» → 「所定の形式(コントラクト)」. 8. dev.ble.fact.medical 「診断に使用するものではありません」 statement, not instruction. Lexicon: removed 「がん」 (matched がんばって), 「疲れ」 (matched お疲れ様).
ko: 1. «xác nhận» → 「승인」 (not 확인). 2. same gloss in consent.calendar_link.body. 3. «site» → 「거점」. 4. consent.notice.title 「최초 고지」. 5. «bạn» in consent → 「사용자」; elsewhere omitted or 「나/내」. 6. social.composer.needLink / noPublicUrl reordered so no particle follows {names}. 7. state.UNKNOWN 「결과 아직 검증되지 않음」 long for a label. 8. lele.example.* use casual 「켜줘」 forms. Lexicon: removed 「아파」 (아파트), 「약을」 (예약을), 「의사」 (의사결정), 「정신」, 「열이」.
Both: bare "머리 아파"-style sentences caught only for listed body parts; 寝室 commands blocked as health (known limit).
New samples: ja 「電気を付けて」 ON; 「明日の午後3時半に45分おさえて」 [45,15:30,tomorrow]; 「お疲れ様です、デスクライトをつけて」 ON; 「血圧が高めです」 HEALTH. ko 「아파트 조명 꺼줘」 OFF; 「15시에 30분 예약을 잡아줘」 [30,15:00]; 「내일 오후 3시 반에 45분 잡아줘」 [45,15:30,tomorrow]; 「머리 아파」 HEALTH; 「주민번호 알려줄게요」 PII.

## zh-Hans (335 health terms, 39 pii) / zh-Hant (Taiwan vocabulary; 349 health terms, 34 pii) — 36/36 checks each
1. consent.calendar_link.body: «Thời gian cá nhân» has no gloss (en, ja, es, pt add one). 2. connect.trackers.title 追踪设备 / 追蹤裝置 may read as a location tracker. 3. "site" as 站点 / 據點. 4. nav.house 家居 / 居家. 5. state.UNKNOWN 结果尚未核实 / 結果尚未驗證 (verb differs between the two). 6. dev.ble.*: Bluetooth kept in Latin; 蓝牙 / 藍牙 is usual. 7. dev.kind.apple_health_xml: added 文件 / 檔案 (script check needs a Han character). 8. error.SCHEMA_INVALID «hợp đồng» as 接口约定 / 介面約定. 9. msg.state.THREAD_ACTIVE 开放中 / 開放中.
Lexicon: bare 眠 (zh-Hant) also blocks 休眠; removed 开着, 灯开, 灯关; Chinese numerals (半小时) are not parsed; each file also lists the other script's command words.
New samples: zh-Hans 明晚8点半预留45分钟 [45,20:30,tomorrow]; 帮我把夜灯熄掉 OFF; 我血糖有点高 HEALTH; 我的支付宝账号 PII. zh-Hant 今晚8點留45分鐘 [45,20:00]; 把桌燈關掉 OFF; 我要去看牙 HEALTH; 我的統編 PII.

## id (Anda; 214 health terms, 38 pii) — 36/36 checks
1. consent.calendar_link.body: «Thời gian cá nhân» quoted with no Indonesian gloss. 2. consent.notice.head: "penanggung jawab pelindungan data" may need the legal term "Pejabat Pelindungan Data Pribadi". 3. "Versi uji coba" renders both the dev trial build and the pilot. 4. msg.endpoints.remove "Lepas" for «gỡ» (distinct from "Hapus"). 5. review.unknown.lastCheck "Rekonsiliasi terakhir" is formal. 6. "menu berbagi perangkat" for share sheet. 7. dev.ble.unit "denyut/menit". 8. site → "lokasi"; workspace left as "workspace".
Lexicon: pm has "siang": "jam 1 siang" gives 13:00 but "jam 11 siang" gives 23:00; "jam" is both hour unit and time word: "sisihkan 1 jam 30 menit pukul 15.00" is not recognised (fails closed).
New samples: "tolong lampunya dimatikan" OFF; "hidupin lampu ruang tamu dong" ON; "jadwalkan waktu pribadi 60 menit mulai 14.00" [60,14:00]; "sisihkan 30 menit jam 11 untuk makan siang" [30,11:00]; "tadi malam saya ketiduran" HEALTH; "ktp saya hilang" PII.

## de (Sie; 310 health terms, 30 pii) / ru (вы; 301 health terms, 29 pii) — 36/36 checks each
de: consent.notice.head "…einzusehen, zu berichtigen, zurückzuziehen, einzuschränken…" («rút lại» literal, reads oddly); consent.calendar_link.body: no gloss for «Thời gian cá nhân», "Auftragsverarbeiter des Unternehmens" is GDPR wording; work.row.busy "Beschäftigt" (Outlook says "Gebucht"); state.CANCELED "Abgebrochen" (or "Storniert"); review.digest.ok "festgeschrieben" for «khóa»; lele.local.health "in der Arbeitsdomäne"; dev.import.fact.until + dev.import.until read well only together; dev.ble.unit "Schläge/min"; nav.connect "Verbinden". Lexicon: "tablette*" narrowed (matched French); plain "operation*" avoided (matches English); not fixed: "müde" folds to "mude" (pt-BR verb).
ru: state.VERIFIED "Результат подтверждён" / state.UNKNOWN "Результат ещё не подтверждён" vs state.AUTHORIZED "Вы подтвердили" (same verb for approval and verification); review.evidence.* "Подтверждающие данные"; social.evidence.label "Уровень доказательности"; msg.* "пользователю {name}" (avoids declining the name); msg.report.HARASSMENT "Преследование"; consent.calendar_link.body "обработчик данных предприятия"; house.noSite "площадках, у которых есть управляющий"; dev.status.reported "По сообщениям"; health.sleep.sentence.insufficient awkward word order; msg.safety.confirm "Этот код мной сверен". Lexicon: "здоров*" narrowed (matched "здорово"); not fixed: pm word "дня" turns "11 часов дня" into 23:00.
New samples: de "knips die Stehlampe an" ON; "halte 2 Stunden um 9 Uhr morgen frei" [120,09:00,tomorrow]; "blocke 30 Minuten um 15 Uhr für den Zahnarzt" HEALTH; "meine IBAN lautet" PII. ru "погаси торшер" OFF; "выдели 45 минут в 3 часа дня" [45,15:00]; "забронируй час в 10:00 к стоматологу" HEALTH; "мой СНИЛС" PII.
