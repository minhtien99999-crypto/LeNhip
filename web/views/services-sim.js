// Phần cổng mô phỏng Le‑ORION của màn hình Dịch vụ (SRS V2.0 mục 09, N20‑SIM, LNH-T68, ca X10). Mọi thứ ở đây là MÔ PHỎNG: chọn
// kỹ năng đã đăng ký và phiên bản scene, xếp một lượt vào hàng đợi mô phỏng, xem danh sách lượt với nhãn SIMULATED ở từng dòng,
// ở thông báo và ở chi tiết. Không có robot hay thiết bị thật: robot thật là cổng G3 theo đề án riêng của LeHR.
// - Chỉ danh tính lab gọi được (workspace là tenant lab và quyền sim.run); người khác thấy câu giải thích, không thấy nút.
// - Mất kết nối: báo «không kết nối», không đoán trạng thái lượt chạy.
// - Phần có ô chọn nên dùng `update`: render và bind một lần, nền chỉ thay vùng danh sách khi đổi.
// Chuỗi: khóa `sim.*` trong web/shared/i18n-<ngôn ngữ>-sim.js. Kiểu: web/views/services-sim.css (lớp sim-).

/** Trạng thái của phần đang hiện (một lần bind). */
let st = null;

const hasGrant = (me) => !!me?.grants?.some((g) => g.scope === "sim.run" && g.status === "ACTIVE");
const when = (ctx, iso) => ctx.formatDate(iso, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: ctx.zone() });
const errKey = (e) => {
  if (e?.status === 0) return "sim.offline";
  const known = ["MODULE_DISABLED", "FORBIDDEN", "SIM_LAB_REQUIRED", "SIM_SKILL_UNKNOWN", "SIM_SCENE_UNKNOWN", "SIM_QUEUE_FULL", "SIM_REQUEST_REUSED"];
  return known.includes(e?.code) ? "sim.error." + e.code : "sim.error.other";
};
const requestRef = () => "req_" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

function runsHtml(ctx) {
  const ts = ctx.tSafe;
  if (st.error) return '<p class="empty-state" role="status">' + ts(errKey(st.error)) + "</p>";
  if (!st.runs) return '<p class="empty-state">' + ts("sim.loading") + "</p>";
  if (!st.runs.length) return '<p class="empty-state">' + ts("sim.runs.empty") + "</p>";
  return '<ul class="sim-runs">' + st.runs.map((r) => {
    const result = r.result ? ts("sim.result." + (r.result.outcome === "SIM_GOAL_REACHED" ? "goal" : "limit"), { steps: r.result.steps }) : ts("sim.state.queued");
    return '<li class="sim-run"><div class="sim-copy"><strong>' + ts("sim.skill." + r.skill_ref) + '</strong><small>' + ts("sim.runs.meta", { scene: r.scene_version, when: when(ctx, r.queued_at) }) + "</small><small>" + result + "</small></div>" +
      '<div class="sim-tags"><span class="sim-badge">' + ts("sim.badge") + '</span><span class="status-chip ' + (r.state === "SIMRUN_COMPLETED" ? "ok" : "busy") + '">' + ts(r.state === "SIMRUN_COMPLETED" ? "sim.state.completed" : "sim.state.queuedShort") + "</span></div></li>";
  }).join("") + "</ul>";
}

function formHtml(ctx) {
  const ts = ctx.tSafe;
  if (!st.catalog) return "";
  const skill = st.catalog.skills.find((s) => s.skill_ref === st.skill) ?? st.catalog.skills[0];
  const scenes = st.catalog.scenes.filter((s) => skill.scenes.includes(s.scene_id));
  return '<form class="sim-form" data-sim-form>' +
    '<label class="field"><span>' + ts("sim.form.skill") + '</span><select name="skill_ref" data-sim-skill>' + st.catalog.skills.map((s) => '<option value="' + ctx.safe(s.skill_ref) + '"' + (s.skill_ref === skill.skill_ref ? " selected" : "") + ">" + ts("sim.skill." + s.skill_ref) + "</option>").join("") + "</select></label>" +
    '<label class="field"><span>' + ts("sim.form.scene") + '</span><select name="scene_version">' + scenes.map((s) => '<option value="' + ctx.safe(s.scene_version) + '">' + ts("sim.scene", { scene: ts("sim.sceneName." + s.scene_id), version: s.version }) + "</option>").join("") + "</select></label>" +
    '<p class="fine-print">' + ts("sim.form.limit", { steps: skill.max_steps, queue: st.catalog.limits.queued_per_workspace }) + "</p>" +
    '<button class="button primary" type="submit">' + ts("sim.form.run") + '</button><p class="sim-status" role="status" data-sim-status></p></form>';
}

async function load(ctx) {
  if (!st || st.loading) return;
  st.loading = true;
  const mine = st;
  try {
    const [c, r] = await Promise.all([st.catalog ? Promise.resolve(st.catalog) : ctx.api.get("/v2/sim/catalog"), ctx.api.get("/v2/sim/runs")]);
    if (st !== mine) return;
    st.catalog = c;
    st.skill ??= c.skills[0]?.skill_ref;
    st.runs = r.runs;
    st.error = null;
  } catch (e) {
    if (st === mine) st.error = e;
  } finally {
    mine.loading = false;
  }
  if (st === mine && st.el.isConnected) draw(ctx);
}

function draw(ctx) {
  if (!st) return;
  const el = st.el;
  const put = (name, html) => {
    if (st.html[name] === html) return;
    const box = el.querySelector('[data-sim="' + name + '"]');
    st.html[name] = html;
    box.innerHTML = html;
  };
  if (!hasGrant(ctx.me)) {
    put("form", '<p class="empty-state">' + ctx.tSafe("sim.gate.lab") + "</p>");
    put("runs", "");
    return;
  }
  put("form", st.error && !st.catalog ? "" : formHtml(ctx));
  put("runs", runsHtml(ctx));
}

export default {
  id: "sim",
  order: 30,
  visible: (ctx) => ctx.modules.sim === true,

  render(ctx) {
    const ts = ctx.tSafe;
    return '<div class="section-heading"><h2>' + ctx.icon("cube") + "<span>" + ts("sim.title") + '</span></h2><span class="sim-badge">' + ts("sim.badge") + "</span></div>" +
      '<p class="fine-print">' + ts("sim.lead") + "</p>" +
      '<ul class="sim-limits"><li>' + ts("sim.limits.queue") + "</li><li>" + ts("sim.limits.inputs") + "</li><li>" + ts("sim.limits.receipt") + "</li></ul>" +
      '<p class="privacy-note sim-real">' + ts("sim.realRobot") + "</p>" +
      '<div data-sim="form"></div><h3>' + ts("sim.runs.title") + '</h3><div data-sim="runs"></div>';
  },

  bind(ctx, el) {
    st = { el, sub: ctx.me?.user?.id ?? "", html: {}, catalog: null, runs: null, skill: null, loading: false, error: null };
    el.addEventListener("change", (ev) => {
      const t = /** @type {HTMLElement} */ (ev.target);
      if (!t.matches("[data-sim-skill]")) return;
      st.skill = /** @type {HTMLSelectElement} */ (t).value;
      draw(ctx);
      el.querySelector("[data-sim-skill]")?.focus();
    }, { signal: ctx.signal });
    el.addEventListener("submit", (ev) => {
      const f = /** @type {HTMLFormElement} */ (ev.target);
      if (!f.matches("[data-sim-form]")) return;
      ev.preventDefault();
      const data = new FormData(f);
      const status = f.querySelector("[data-sim-status]");
      const button = f.querySelector("button[type=submit]");
      button.disabled = true;
      status.textContent = ctx.t("sim.form.sending");
      ctx.api.post("/v2/sim/runs", { skill_ref: String(data.get("skill_ref")), scene_version: String(data.get("scene_version")), request_ref: requestRef() }).then(async (r) => {
        status.textContent = ctx.t("sim.form.queued", { run: r.run_ref.slice(-6) });
        ctx.toast(ctx.t("sim.toast.queued"));
        await load(ctx);
      }, (e) => (status.textContent = ctx.t(errKey(e)))).finally(() => (button.disabled = false));
    }, { signal: ctx.signal });
    // Lượt đang chờ: hỏi lại mỗi 3 giây; khi không còn lượt chờ thì chỉ nạp khi người dùng thao tác.
    ctx.every(3000, () => (st && (!st.runs || st.runs.some((r) => r.state === "SIMRUN_QUEUED")) && hasGrant(ctx.me) ? load(ctx) : undefined), { immediate: true });
    draw(ctx);
  },

  update(ctx) {
    if (!st) return;
    const sub = ctx.me?.user?.id ?? "";
    if (sub !== st.sub) Object.assign(st, { sub, html: {}, catalog: null, runs: null, skill: null, error: null });
    draw(ctx);
    if (!st.runs && !st.loading && hasGrant(ctx.me)) void load(ctx);
  },
};
