// @ts-check
// Chữ LeNhip theo gói nhận diện (LNH-T20): năm bản vẽ L01–L05, mỗi bản đi với một phong cách giao diện để luôn đọc được
// (LNH-F25: chữ L01 màu #12394A không đọc được trên nền tối, nên Không gian đêm dùng L02, Titanium dùng L05).
// Dữ liệu đường và màu chép nguyên từ Logo/SVG của docs/source/LeNhip_05_Logo_05_Icon.zip; tests/brand.test.ts đối chiếu từng
// đường với tệp gốc. Chỉ khác tệp gốc ở khung nhìn: cắt sát nét vẽ theo chiều ngang, cùng một khung dọc (y 16–140) để năm bản
// cao bằng nhau; bỏ thẻ <title> ("LeNhip · <tên phương án>") vì tên truy cập của chữ luôn là "LeNhip".
// Không đổi màu, không thêm khẩu hiệu. Icon ứng dụng luôn là I01 (web/icon.svg, web/icons/*.png).

/** Bản vẽ theo phong cách: mã trong gói, khung nhìn đã cắt và phần thân SVG chép nguyên. */
const ART = {
  orbit: {
    code: "L01",
    viewBox: "28 16 375 124",
    body: '<g transform="translate(20 4) scale(1)"><g transform="translate(0 109) scale(0.119 -0.119)"><path d="M68 0H431V131H205V739H68Z" fill="#12394A"/></g><g transform="translate(50.46 109) scale(0.119 -0.119)"><path d="M603 218C607 238 608 250 608 270C608 441 487 567 322 567C159 567 30 438 30 275C30 113 161 -13 330 -13C421 -13 492 20 550 87C571 113 585 136 594 164H449C415 124 382 109 327 109C248 109 190 151 174 218ZM170 335C191 407 245 445 324 445C406 445 460 406 477 335Z" fill="#12394A"/></g><g transform="translate(124.72 109) scale(0.119 -0.119)"><path d="M68 0H205V537L514 0H667V739H530V201L224 739H68Z" fill="#12394A"/></g><g transform="translate(210.88 109) scale(0.119 -0.119)"><path d="M54 0H187V281C187 336 192 367 206 392C226 426 260 445 304 445C382 445 412 400 412 283V0H545V313C545 394 535 439 508 480C471 537 407 568 328 568C270 568 227 552 187 516V739H54Z" fill="#12394A"/></g><g transform="translate(280.38 109) scale(0.119 -0.119)"><path d="M54 0H187V554H54Z" fill="#12394A"/></g><g transform="translate(280.7195 10.754) scale(0.28)"><path d="M50 92C39 82 3 61 3 35C3 19 14 9 28 9C37 9 45 14 50 22C55 14 63 9 72 9C86 9 97 19 97 35C97 61 61 82 50 92Z" fill="#A86610"/></g><g transform="translate(307.04 109) scale(0.119 -0.119)"><path d="M54 -185H187V52C238 7 289 -13 357 -13C517 -13 634 111 634 279C634 446 518 567 359 567C283 567 219 540 176 489V554H54ZM341 445C431 445 500 372 500 276C500 182 431 109 343 109C249 109 179 181 179 278C179 373 249 445 341 445Z" fill="#12394A"/></g></g>',
  },
  night: {
    code: "L02",
    viewBox: "28 16 376 124",
    body: '<g transform="translate(20 4) scale(1)"><g transform="translate(0 109) scale(0.115 -0.115)"><path d="M76 0H456V67H150V739H76Z" fill="#F2F3FF"/></g><g transform="translate(53.93 109) scale(0.115 -0.115)"><path d="M611 249C611 324 601 370 574 418C525 506 430 560 325 560C166 560 42 435 42 276C42 114 169 -13 331 -13C450 -13 557 64 597 180H520C489 105 412 55 329 55C216 55 122 141 116 249ZM118 316C138 421 221 492 325 492C431 492 511 426 537 316Z" fill="#F2F3FF"/></g><g transform="translate(129.48 109) scale(0.115 -0.115)"><path d="M76 0H150V650L590 0H664V739H590V126L176 739H76Z" fill="#D8CCFF"/></g><g transform="translate(215.38 109) scale(0.115 -0.115)"><path d="M63 0H137V300C137 359 145 394 167 424C197 467 248 492 304 492C357 492 407 470 436 433C462 400 473 358 473 294V0H547V294C547 376 532 433 500 476C459 529 390 560 310 560C236 560 174 530 137 476V739H63Z" fill="#D8CCFF"/></g><g transform="translate(286.33 109) scale(0.115 -0.115)"><path d="M63 0H137V547H63Z" fill="#D8CCFF"/></g><g transform="translate(284.83 15.655) scale(0.26)"><path d="M50 92C39 82 3 61 3 35C3 19 14 9 28 9C37 9 45 14 50 22C55 14 63 9 72 9C86 9 97 19 97 35C97 61 61 82 50 92Z" fill="#C6B9FF"/></g><g transform="translate(310.13 109) scale(0.115 -0.115)"><path d="M63 547V-192H137V94C185 24 259 -13 350 -13C514 -13 640 112 640 272C640 436 515 560 352 560C258 560 184 523 137 453V547ZM349 492C473 492 565 398 565 272C565 149 472 55 350 55C225 55 132 149 132 276C132 397 227 492 349 492Z" fill="#D8CCFF"/></g></g>',
  },
  calm: {
    code: "L03",
    viewBox: "22 16 375 124",
    body: '<g transform="translate(20 4) scale(1)"><g transform="translate(0 109) scale(0.106 -0.106)"><path d="M28 0V53H70Q92 53 106.5 64.0Q121 75 121 118V596Q121 639 106.5 650.0Q92 661 70 661H28V714H373V661H331Q310 661 295.0 650.5Q280 640 280 600V61H466Q501 61 520.5 83.5Q540 106 549 148L565 223H621L614 0Z" fill="#374A31"/></g><g transform="translate(67.624 109) scale(0.106 -0.106)"><path d="M306 -10Q179 -10 113.0 62.5Q47 135 47 265Q47 406 112.0 477.5Q177 549 295 549Q404 549 466.5 488.0Q529 427 529 308V257H201Q204 157 238.5 111.0Q273 65 335 65Q387 65 423.0 88.5Q459 112 476 146Q503 131 503 97Q503 54 455.0 22.0Q407 -10 306 -10ZM376 321Q376 398 358.0 441.0Q340 484 297 484Q255 484 230.0 442.5Q205 401 203 321Z" fill="#374A31"/></g><g transform="translate(126.45 109) scale(0.106 -0.106)"><path d="M28 0V53H70Q91 53 106.0 64.0Q121 75 121 118V600Q121 640 105.5 650.5Q90 661 70 661H28V714H250L603 215V600Q603 640 587.5 650.5Q572 661 552 661H510V714H771V661H729Q708 661 693.0 650.0Q678 639 678 596V0H586L196 551V118Q196 75 211.0 64.0Q226 53 247 53H289V0Z" fill="#374A31"/></g><g transform="translate(208.278 109) scale(0.106 -0.106)"><path d="M20 0V53H22Q56 53 78.5 65.0Q101 77 101 122L100 646Q100 673 88.0 686.0Q76 699 59.5 703.0Q43 707 29 707H17V760H252V595Q252 569 250.0 539.5Q248 510 246.0 489.0Q244 468 244 468H253Q273 506 296.5 523.0Q320 540 347.5 544.5Q375 549 406 549Q483 549 527.0 503.0Q571 457 571 356V124Q571 78 587.5 65.5Q604 53 638 53H641V0H419V329Q419 394 401.0 429.0Q383 464 339 464Q306 464 287.0 442.5Q268 421 260.0 385.5Q252 350 252 309L253 118Q253 76 272.0 64.5Q291 53 324 53H327V0Z" fill="#374A31"/></g><g transform="translate(277.28 109) scale(0.106 -0.106)"><path d="M17 0V53H29Q44 53 60.5 57.5Q77 62 88.5 76.0Q100 90 100 118V422Q100 449 88.0 462.0Q76 475 59.5 479.0Q43 483 29 483H17V536H252V118Q252 90 263.5 76.0Q275 62 292.0 57.5Q309 53 323 53H335V0Z" fill="#374A31"/></g><g transform="translate(283.436 22.684) scale(0.25)"><path d="M50 92C39 82 3 61 3 35C3 19 14 9 28 9C37 9 45 14 50 22C55 14 63 9 72 9C86 9 97 19 97 35C97 61 61 82 50 92Z" fill="#A64D37"/></g><g transform="translate(312.892 109) scale(0.106 -0.106)"><path d="M13 -240V-187H25Q40 -187 56.5 -182.5Q73 -178 84.5 -164.0Q96 -150 96 -122V413Q96 459 77.0 471.0Q58 483 29 483H22V536H218L236 458H240Q262 497 298.5 521.5Q335 546 393 546Q493 546 545.5 479.0Q598 412 598 266Q598 121 546.5 54.5Q495 -12 397 -12Q340 -12 304.5 9.5Q269 31 247 68H240Q242 54 244.0 30.5Q246 7 247.0 -15.5Q248 -38 248 -53V-122Q248 -150 259.5 -164.0Q271 -178 288.0 -182.5Q305 -187 319 -187H341V-240ZM350 62Q400 62 422.0 112.5Q444 163 444 265Q444 365 422.5 418.0Q401 471 351 471Q291 471 269.5 418.0Q248 365 248 266Q248 163 269.5 112.5Q291 62 350 62Z" fill="#374A31"/></g></g>',
  },
  flow: {
    code: "L04",
    viewBox: "27 16 387 124",
    body: '<g transform="translate(20 4) scale(1)"><g transform="translate(0 109) scale(0.118 -0.118)"><path d="M385 729H235L80 0H579L606 125H257Z" fill="#14458C"/></g><g transform="translate(70.298 109) scale(0.118 -0.118)"><path d="M573 226C585 271 591 313 591 351C591 420 554 489 501 519C468 539 426 549 379 549C301 549 221 518 174 469C110 402 64 285 64 184C64 61 149 -23 275 -23C396 -23 497 40 552 152H414C398 121 369 100 330 92C320 90 311 89 302 89C252 89 214 120 208 164C207 170 207 175 207 181C207 191 208 201 210 226ZM448 319H228C246 382 272 414 319 430C333 435 347 437 361 437C414 437 448 403 448 349Z" fill="#14458C"/></g><g transform="translate(134.106 109) scale(0.118 -0.118)"><path d="M816 729H674L565 214L373 729H223L68 0H210L321 523L513 0H661Z" fill="#14458C"/></g><g transform="translate(217.502 109) scale(0.118 -0.118)"><path d="M222 729 67 0H207L272 304C285 368 323 416 370 431C382 435 394 437 407 437C454 437 479 410 479 361C479 348 477 335 473 313L406 0H546L623 362C627 381 629 399 629 417C629 496 571 549 484 549C412 549 358 521 304 458L362 729Z" fill="#14458C"/></g><g transform="translate(287.8 109) scale(0.118 -0.118)"><path d="M322 540H182L67 0H207Z" fill="#14458C"/></g><g transform="translate(305.3974 14.84) scale(0.26)"><path d="M50 92C39 82 3 61 3 35C3 19 14 9 28 9C37 9 45 14 50 22C55 14 63 9 72 9C86 9 97 19 97 35C97 61 61 82 50 92Z" fill="#007B70"/></g><g transform="translate(318.804 109) scale(0.118 -0.118)"><path d="M312 540H172L11 -218H151L211 64C232 4 274 -23 344 -23C505 -23 637 142 637 342C637 469 570 549 463 549C396 549 341 520 295 460ZM406 437C460 437 494 393 494 323C494 228 449 136 386 102C370 93 353 89 333 89C281 89 246 134 246 202C246 297 290 388 354 424C370 433 386 437 406 437Z" fill="#14458C"/></g><path d="M10 128H146" fill="none" stroke="#1475D5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="128" r="4.5" fill="#1475D5"/><circle cx="79" cy="128" r="4.5" fill="#1475D5"/><circle cx="146" cy="128" r="4.5" fill="#007B70"/></g>',
  },
  titanium: {
    code: "L05",
    viewBox: "30 16 426 124",
    body: '<g transform="translate(20 4) scale(1)"><path fill="#EFF4F7" fill-rule="evenodd" d="M10 39H23V94H66V106H10Z"/><path fill="#EFF4F7" fill-rule="evenodd" d="M90 55H137L147 65V86H95V92L100 96H141V106H91L82 97V65ZM95 68V76H134V69L131 65H99Z"/><path fill="#EFF4F7" fill-rule="evenodd" d="M166 39H178L227 88V39H240V106H228L179 57V106H166Z"/><path fill="#EFF4F7" fill-rule="evenodd" d="M257 39H270V59L276 54H310L319 63V106H306V72L302 67H277L270 74V106H257Z"/><path fill="#EFF4F7" fill-rule="evenodd" d="M338 55H352V106H338Z"/><path fill="#EFF4F7" fill-rule="evenodd" d="M372 54H426L436 65V95L426 106H385V130H372ZM385 67V93H419L423 89V72L418 67Z"/><g transform="translate(332.5 23.5) scale(0.25)"><path d="M50 94 5 51V25L24 8H39L50 19 61 8H76L95 25V51Z" fill="#65F0EC"/></g></g>',
  },
};

/** Phong cách có bản vẽ riêng, theo thứ tự PA01–PA05. */
export const WORDMARK_THEMES = /** @type {(keyof typeof ART)[]} */ (Object.keys(ART));

/** Mã bản vẽ trong gói nhận diện (L01–L05) của một phong cách. @param {string} theme */
export function wordmarkCode(theme) {
  return (ART[/** @type {keyof typeof ART} */ (theme)] ?? ART.orbit).code;
}

/**
 * SVG chữ LeNhip cho một phong cách; phong cách lạ dùng L01. Tên truy cập là "LeNhip" (trình đọc màn hình không đọc tên phương án).
 * @param {string} [theme]
 * @param {{ className?: string, label?: string | false }} [o] label=false khi chữ chỉ để trang trí cạnh một tên đã có.
 */
export function wordmark(theme = "orbit", o = {}) {
  const key = /** @type {keyof typeof ART} */ (theme in ART ? theme : "orbit");
  const art = ART[key];
  const cls = ["brand-wordmark", /^[a-z0-9 _-]*$/i.test(o.className ?? "") ? o.className ?? "" : ""].join(" ").trim();
  const label = o.label === false ? "" : String(o.label ?? "LeNhip").replace(/[&<>"']/g, "");
  const a11y = o.label === false ? 'aria-hidden="true"' : `role="img" aria-label="${label}"`;
  return `<svg class="${cls}" data-wordmark="${art.code}" viewBox="${art.viewBox}" preserveAspectRatio="xMinYMid meet" ${a11y} focusable="false">${art.body}</svg>`;
}
