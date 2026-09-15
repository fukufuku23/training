/**
 * 画面制御。ストレージ層（storage.js）とドメインロジック（domain.js）だけに依存する。
 * フェーズ2で storage.js の中身が Supabase 同期付きに変わっても、このファイルは無変更。
 *
 * 設計方針:
 *  - モバイル＝「迷わず始める」。判断を「はじめる」の1つに絞る
 *  - PC＝「振り返る」。カレンダーと分析
 *  - 休養日を明示的に肯定する（継続日数を切らさない）
 */

import { EXERCISES } from "./exercises.js?v=20260916005440";
import { storage, todayKey, shiftDate, toDateKey, requestPersistence } from "./storage.js?v=20260916005440";
import {
  CONDITIONS, PAIN_REGIONS, PURPOSES, TIME_PRESETS,
  conditionByKey, calcCalories, filterExercises, curateForTime, warningFor,
  uniqueCategoriesByType, uniqueEquipment, youtubeUrl, imageSearchUrl,
  regionGroupOf, REGION_GROUPS, buildSession, flattenSession,
  STRENGTH_LEVELS, DEFAULT_LEVEL, clampLevel, levelRange,
} from "./domain.js?v=20260916005440";
import { poseArt, bodyMap, laurel } from "./art.js?v=20260916005440";
import { Guide } from "./guide.js?v=20260916005440";
import { renderWeightChart, renderCaloriesChart, renderBalanceChart } from "./chart.js?v=20260916005440";

const EX_BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

const state = {
  exercises: EXERCISES,
  today: todayKey(),
  yesterday: shiftDate(todayKey(), -1),
  log: null,
  settings: null,
  lastTrained: {},
  fallbackWeight: 60,
  loggedToday: new Set(),
  picked: [],
  phases: [],
  flat: [],
  historyRange: 30,
  calMonth: null,      // { y, m }
  bodySide: "front",
  mediaIndex: null,
  filters: {
    strengthCategory: new Set(),
    stretchCategory: new Set(),
    purpose: new Set(),
    equipment: new Set(),
  },
};

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";

/* ---------------- 汎用UI ---------------- */

/**
 * トースト。action を渡すと取消ボタン付きになる。
 *
 * 「本当に完了にしますか？」のような確認ダイアログは出さない。
 * 毎回の記録に確認が挟まると入力コストが上がり、続かなくなる。
 * かわりに、すべての操作を1タップで戻せるようにしている。
 */
function showToast(message, action) {
  const toast = $("toast");
  toast.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  toast.classList.toggle("toast--action", !!action);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast__action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      toast.classList.remove("show");
      action.onClick();
    });
    toast.appendChild(btn);
  }

  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(
    () => toast.classList.remove("show"), action ? 7000 : 2600);
}

function svg(paths, attrs = {}) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", attrs.viewBox || "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  paths.forEach((d) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    s.appendChild(p);
  });
  return s;
}

/* 体調の表情。口の形だけで4段階を表す */
const FACE_MOUTH = {
  good: "M8 13.4 Q12 17.2 16 13.4",
  normal: "M8.6 14.4 Q12 16.2 15.4 14.4",
  tired: "M8.6 15 L15.4 15",
  exhausted: "M8 16.2 Q12 13 16 16.2",
};

function faceSvg(key) {
  return svg([
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    "M9.2 10 L9.2 11.4",
    "M14.8 10 L14.8 11.4",
    FACE_MOUTH[key] || FACE_MOUTH.normal,
  ]);
}

/**
 * ステップのアイコン（線画）。
 * ストレッチに「腕を横に広げた人」を使うと、車椅子マークと並ぶ
 * アクセシビリティのピクトグラムに見えてしまうため、
 * 「両腕を頭上に伸ばした姿勢」にして意味を明確にしている。
 */
const STEP_ICON = {
  strength: [
    "M4 10v4", "M20 10v4",
    "M7.5 7.5v9", "M16.5 7.5v9",
    "M7.5 12h9",
  ],
  stretch: [
    "M13.7 4.3a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0z",
    "M12 7.4v6.2",
    "M12 8.6 8.7 5.2", "M12 8.6l3.3-3.4",
    "M12 13.6 9.2 20.2", "M12 13.6l2.8 6.6",
  ],
};

function buildMultiChips(containerId, values, activeSet, onToggle, extraClass) {
  const box = $(containerId);
  box.innerHTML = "";
  values.forEach((v) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (extraClass ? ` ${extraClass}` : "") +
      (activeSet.has(v) ? " is-active" : "");
    chip.textContent = v;
    chip.setAttribute("aria-pressed", activeSet.has(v) ? "true" : "false");
    chip.addEventListener("click", () => {
      activeSet.has(v) ? activeSet.delete(v) : activeSet.add(v);
      onToggle();
    });
    box.appendChild(chip);
  });
}

function buildValueChips(containerId, values, currentGetter, onSelect, format) {
  const box = $(containerId);
  box.innerHTML = "";
  values.forEach((v) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (currentGetter() === v ? " is-active" : "");
    chip.textContent = format ? format(v) : String(v);
    chip.addEventListener("click", () => onSelect(v));
    box.appendChild(chip);
  });
}

/* ---------------- 体重 ---------------- */

function effectiveWeight() {
  if (state.log && state.log.weight_kg != null) return state.log.weight_kg;
  return state.fallbackWeight;
}

async function loadFallbackWeight() {
  const logs = await storage.getAllLogs();
  const withWeight = logs
    .filter((l) => l.weight_kg != null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (withWeight.length > 0) state.fallbackWeight = withWeight[0].weight_kg;
}

/* ---------------- 継続日数 ---------------- */

/* ---------------- 今日：コースカード ---------------- */

function currentMinutes() {
  return state.log.minutes != null ? state.log.minutes : state.settings.default_minutes;
}

function renderConditionFaces() {
  const box = $("chips-condition");
  box.innerHTML = "";
  CONDITIONS.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "face" + (state.log.condition === c.key ? " is-active" : "");
    btn.setAttribute("aria-pressed", state.log.condition === c.key ? "true" : "false");
    btn.appendChild(faceSvg(c.key));
    const label = document.createElement("span");
    label.className = "face__label";
    label.textContent = c.label;
    btn.appendChild(label);
    btn.addEventListener("click", async () => {
      state.log.condition = c.key;
      await storage.saveLog(state.today, { condition: c.key });
      renderConditionFaces();
      renderToday();
    });
    box.appendChild(btn);
  });
  $("condition-hint").textContent = conditionByKey(state.log.condition).note;
}

function renderTimeChips() {
  buildValueChips("chips-time", TIME_PRESETS, currentMinutes, async (v) => {
    state.log.minutes = v;
    await storage.saveLog(state.today, { minutes: v });
    renderTimeChips();
    renderToday();
  }, (v) => `${v}分`);
}

function renderPainChips() {
  const set = new Set(state.log.pain_regions || []);
  buildMultiChips("chips-pain", PAIN_REGIONS, set, async () => {
    state.log.pain_regions = Array.from(set);
    await storage.saveLog(state.today, { pain_regions: state.log.pain_regions });
    renderPainChips();
    syncBodyMapSelection();
    renderToday();
  }, "chip--pain");
}

/** 今日のメニューを組み立てて、コースカードと種目リストを更新する */
function renderToday() {
  const card = $("course-card");
  const startBtn = $("start-btn");
  const restBtn = $("rest-btn");

  // --- 休養日 ---
  if (state.log.rest) {
    card.classList.add("is-rest");
    $("course-title").textContent = "休養日";
    $("course-sub").textContent = "しっかり休むのもトレーニングのうち。継続日数は途切れません。";
    $("course-flow").innerHTML = "";
    $("course-progress").style.width = "100%";
    $("course-progress-label").textContent = "休養";
    startBtn.disabled = true;
    startBtn.textContent = "今日はお休み";
    restBtn.textContent = "やっぱり運動する";
    restBtn.classList.add("is-on");
    $("session-list").innerHTML = "";
    return;
  }

  card.classList.remove("is-rest");
  startBtn.disabled = false;
  restBtn.textContent = "今日は休養日にする";
  restBtn.classList.remove("is-on");

  const filtered = filterExercises(state.exercises, {
    ...state.filters,
    painRegions: state.log.pain_regions || [],
    conditionKey: state.log.condition,
    strengthLevel: (state.settings && state.settings.strength_level) || DEFAULT_LEVEL,
  });
  const { picked, totalMin } = curateForTime(filtered, currentMinutes(), state.log.condition);
  state.phases = buildSession(picked);
  state.flat = flattenSession(state.phases);
  state.picked = picked;

  // 設定時間ではなく「実際に組めた時間」を出す。
  // 体調が悪い日はセット数が減って短くなるので、設定値を出すと嘘になる。
  $("course-title").textContent = picked.length
    ? `${Math.round(totalMin)}分コース`
    : "メニューなし";

  renderFlow();
  updateProgress();
  renderSessionList();
}

function renderFlow() {
  const box = $("course-flow");
  box.innerHTML = "";
  state.phases.forEach((ph, i) => {
    if (i > 0) {
      const arrow = document.createElement("li");
      arrow.className = "flow__arrow";
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      box.appendChild(arrow);
    }
    const li = document.createElement("li");
    li.className = `flow__step flow__step--${ph.key}`;

    const disc = document.createElement("span");
    disc.className = "flow__disc";
    disc.appendChild(poseArt(phaseArtGroup(ph)));
    const num = document.createElement("span");
    num.className = "flow__num";
    num.textContent = String(i + 1);
    disc.appendChild(num);
    li.appendChild(disc);

    const label = document.createElement("span");
    label.className = "flow__label";
    label.textContent = ph.label;
    li.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "flow__meta";
    meta.textContent = `${ph.count}種目 ・ ${ph.minutes}分`;
    li.appendChild(meta);

    box.appendChild(li);
  });
}

/** そのフェーズを代表する部位グループ（最も多い部位）を選ぶ */
function phaseArtGroup(phase) {
  const counts = new Map();
  phase.items.forEach((p) => {
    const g = regionGroupOf(p.ex.category);
    counts.set(g, (counts.get(g) || 0) + 1);
  });
  let best = "全身", max = 0;
  counts.forEach((v, k) => { if (v > max) { max = v; best = k; } });
  return best;
}

function updateProgress() {
  const total = state.flat.length;
  const done = state.flat.filter((p) => state.loggedToday.has(p.ex.id)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("course-progress").style.width = `${pct}%`;
  $("course-progress-label").textContent = total ? `${done} / ${total} 完了` : "";

  const startBtn = $("start-btn");
  const sub = $("course-sub");
  if (total === 0) {
    sub.textContent = "条件に合う種目がありません。設定を見直してください。";
    startBtn.disabled = true;
  } else if (done === 0) {
    sub.textContent = conditionByKey(state.log.condition).note;
    startBtn.textContent = "はじめる";
    startBtn.disabled = false;
  } else if (done < total) {
    sub.textContent = `あと ${total - done} 種目です。`;
    startBtn.textContent = "つづきから";
    startBtn.disabled = false;
  } else {
    sub.textContent = "今日のメニューを完了しました。おつかれさまでした。";
    startBtn.textContent = "完了";
    startBtn.disabled = true;
  }
}

function renderSessionList() {
  const box = $("session-list");
  box.innerHTML = "";

  if (state.flat.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "条件に合う種目がありません。設定タブで絞り込みを見直してください。";
    box.appendChild(empty);
    return;
  }

  const weight = effectiveWeight();
  state.phases.forEach((ph, i) => {
    const head = document.createElement("div");
    head.className = `phase phase--${ph.key}`;
    head.innerHTML = `<span class="phase__num"></span>
      <span class="phase__label"></span><span class="phase__meta"></span>`;
    head.querySelector(".phase__num").textContent = String(i + 1);
    head.querySelector(".phase__label").textContent = ph.label;
    head.querySelector(".phase__meta").textContent = `${ph.note} ・ ${ph.minutes}分`;
    box.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "ex-list";
    ph.items.forEach((item) => {
      const flat = state.flat.find((f) => f.ex.id === item.ex.id);
      ul.appendChild(buildExRow(item, ph, flat ? flat.index : 0, weight));
    });
    box.appendChild(ul);
  });
}

function checkSvg() {
  return svg(["M5 12.5 L10 17 L19 7.5"]);
}

function buildExRow({ ex, sets, durationMin }, phase, index, weight) {
  const warnText = warningFor(ex, state.lastTrained, state.yesterday);
  const calories = calcCalories(ex, weight, sets);
  const done = state.loggedToday.has(ex.id);
  const setsChanged = sets !== (ex.default_sets || 1);

  const li = document.createElement("li");
  li.className = `ex ex--${phase.key}` + (done ? " is-done" : "") + (warnText ? " is-warn" : "");
  li.dataset.id = ex.id;

  const art = document.createElement("span");
  art.className = "ex__art";
  if (state.mediaIndex && state.mediaIndex.has(ex.id)) {
    const img = document.createElement("img");
    img.src = `media/images/${ex.id}.jpg`;
    img.alt = ""; img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove(); art.prepend(poseArt(regionGroupOf(ex.category)));
    }, { once: true });
    art.appendChild(img);
  } else {
    art.appendChild(poseArt(regionGroupOf(ex.category)));
  }
  const num = document.createElement("span");
  num.className = "ex__num";
  num.textContent = String(index);
  art.appendChild(num);
  const check = document.createElement("span");
  check.className = "ex__check" + (done ? " ex__check--static" : "");
  check.appendChild(checkSvg());
  art.appendChild(check);
  li.appendChild(art);

  const body = document.createElement("div");
  body.className = "ex__body";
  const setsLabel = ex.type === "stretch"
    ? `${sets}セット`
    : (setsChanged ? `${ex.default_sets}→${sets}セット` : `${sets}セット`);
  // 情報は「部位＝チップ」「それ以外＝1行のメタ」に畳む。
  // 全部チップにすると折り返して行が伸び、リストが読みにくくなる。
  body.innerHTML = `
    <h4 class="ex__name"></h4>
    <div class="ex__chips"><span class="ex__chip"></span></div>
    <div class="ex__meta"></div>
  `;
  body.querySelector(".ex__name").textContent = ex.name;
  body.querySelector(".ex__chip").textContent = ex.category;
  const metaParts = [setsLabel, `約${Math.round(durationMin)}分`, `${calories}kcal`];
  if (ex.equipment && ex.equipment !== "なし") metaParts.unshift(ex.equipment);
  if (warnText) metaParts.push(warnText);
  body.querySelector(".ex__meta").textContent = metaParts.join(" ・ ");
  li.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "ex__actions";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "ex__done" + (done ? " is-done" : "");
  doneBtn.textContent = done ? "済" : "完了";
  doneBtn.title = done ? "タップで取り消し" : "完了として記録";
  doneBtn.addEventListener("click", () => {
    if (state.loggedToday.has(ex.id)) handleUndo(ex, li, doneBtn);
    else handleLogDone(ex, calories, li, doneBtn);
  });
  actions.appendChild(doneBtn);

  const links = document.createElement("div");
  links.className = "ex__links";
  [["動画", youtubeUrl(ex.youtube_query)], ["画像", imageSearchUrl(ex.image_query)]]
    .forEach(([label, url]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ex__link";
      b.textContent = label;
      b.addEventListener("click", () => window.open(url, "_blank", "noopener"));
      links.appendChild(b);
    });
  actions.appendChild(links);
  li.appendChild(actions);

  return li;
}

function markRowDone(rowEl, buttonEl, animate) {
  rowEl.classList.add("is-done");
  rowEl.classList.remove("is-next");
  buttonEl.textContent = "済";
  buttonEl.title = "タップで取り消し";
  buttonEl.classList.add("is-done");
  const check = rowEl.querySelector(".ex__check");
  check.classList.add(animate ? "show" : "ex__check--static");
}

function markRowUndone(rowEl, buttonEl) {
  rowEl.classList.remove("is-done");
  buttonEl.textContent = "完了";
  buttonEl.title = "完了として記録";
  buttonEl.classList.remove("is-done");
  const check = rowEl.querySelector(".ex__check");
  check.classList.remove("show", "ex__check--static");
}

async function handleLogDone(ex, calories, rowEl, buttonEl) {
  buttonEl.disabled = true;
  try {
    state.log = await storage.addExercise(state.today, {
      id: ex.id, name: ex.name, calories,
    });
    state.loggedToday.add(ex.id);
    markRowDone(rowEl, buttonEl, true);
    updateProgress();
    await renderSide();

    const allDone = state.flat.every((p) => state.loggedToday.has(p.ex.id));
    showToast(
      allDone ? "今日のメニューを完了しました" : `「${ex.name}」を記録しました`,
      { label: "取消", onClick: () => handleUndo(ex, rowEl, buttonEl) }
    );
  } catch (err) {
    showToast("記録に失敗しました。もう一度お試しください。");
    console.error(err);
  } finally {
    buttonEl.disabled = false;
  }
}

/** 記録の取り消し。取り消したあとも1タップで戻せるようにする */
async function handleUndo(ex, rowEl, buttonEl) {
  buttonEl.disabled = true;
  try {
    state.log = await storage.removeExercise(state.today, ex.id);
    state.loggedToday.delete(ex.id);
    markRowUndone(rowEl, buttonEl);
    updateProgress();
    await renderSide();

    const entry = state.flat.find((p) => p.ex.id === ex.id);
    const calories = entry
      ? calcCalories(ex, effectiveWeight(), entry.sets)
      : 0;
    showToast(`「${ex.name}」の記録を取り消しました`, {
      label: "元に戻す",
      onClick: () => handleLogDone(ex, calories, rowEl, buttonEl),
    });
  } catch (err) {
    showToast("取り消しに失敗しました。もう一度お試しください。");
    console.error(err);
  } finally {
    buttonEl.disabled = false;
  }
}

/* ---------------- サイド：継続を実感させる情報 ---------------- */

const DOW_SHORT = ["日", "月", "火", "水", "木", "金", "土"];

async function renderSide() {
  const streak = await storage.getStreak(state.today);
  $("stat-streak").textContent = String(streak);
  if (!$("laurel-l").firstChild) {
    $("laurel-l").appendChild(laurel());
    $("laurel-r").appendChild(laurel());
  }
  $("streak-note").textContent = streak === 0
    ? "今日から始めましょう。"
    : "休養日も継続に数えています。";

  // 直近7日（今日を含む）
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(shiftDate(state.today, -i));
  const logs = await storage.getLogs(days[0], days[6]);
  const byDate = new Map(logs.map((l) => [l.date, l]));

  const weekBox = $("week-dots");
  weekBox.innerHTML = "";
  let doneCount = 0;
  days.forEach((d) => {
    const log = byDate.get(d);
    const trained = log && (log.exercises || []).length > 0;
    const rest = log && log.rest;
    if (trained || rest) doneCount++;
    const cell = document.createElement("div");
    cell.className = "week__day"
      + (trained ? " week__day--done" : rest ? " week__day--rest" : "")
      + (d === state.today ? " week__day--today" : "");
    const dow = document.createElement("span");
    dow.className = "week__dow";
    dow.textContent = DOW_SHORT[new Date(...d.split("-").map((v, i) => i === 1 ? +v - 1 : +v)).getDay()];
    cell.appendChild(dow);
    const mark = document.createElement("span");
    mark.className = "week__mark";
    if (trained) mark.appendChild(checkSvg());
    cell.appendChild(mark);
    cell.title = `${d} — ${trained ? "実施" : rest ? "休養日" : "記録なし"}`;
    weekBox.appendChild(cell);
  });
  $("week-progress").style.width = `${Math.round((doneCount / 7) * 100)}%`;
  $("week-label").textContent = `${doneCount} / 7 日`;

  // 鍛えた部位（今週）
  const active = new Set();
  logs.forEach((l) => (l.exercises || []).forEach((e) => {
    const meta = EX_BY_ID.get(e.id);
    if (meta) active.add(regionGroupOf(meta.category));
  }));
  const fig = $("week-bodymap");
  fig.innerHTML = "";
  fig.appendChild(bodyMap(active));
  const list = $("week-regions");
  list.innerHTML = "";
  REGION_GROUPS.forEach((g) => {
    const li = document.createElement("li");
    li.className = active.has(g) ? "" : "is-off";
    li.textContent = g;
    list.appendChild(li);
  });

  // 最近の記録
  const recentLogs = (await storage.getLogs(shiftDate(state.today, -21), state.today))
    .filter((l) => (l.exercises || []).length > 0 || l.rest)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 5);
  const recent = $("recent-list");
  recent.innerHTML = "";
  if (recentLogs.length === 0) {
    recent.innerHTML = `<li><span class="recent__name" style="color:var(--ink-muted)">まだ記録がありません</span></li>`;
  }
  recentLogs.forEach((l) => {
    const ex = l.exercises || [];
    const cal = Math.round(ex.reduce((s, e) => s + (e.calories || 0), 0));
    const li = document.createElement("li");
    li.innerHTML = `<span class="recent__body">
        <span class="recent__date"></span><br><span class="recent__name"></span>
      </span><span class="recent__val"></span>`;
    li.querySelector(".recent__date").textContent = l.date.slice(5).replace("-", "/");
    li.querySelector(".recent__name").textContent =
      ex.length ? `${ex.length}種目` : "休養日";
    const val = li.querySelector(".recent__val");
    val.textContent = ex.length ? `${cal} kcal` : "—";
    if (!ex.length) val.classList.add("recent__val--rest");
    recent.appendChild(li);
  });
}

async function loadMediaIndex() {
  try {
    const res = await fetch("media/index.json", { cache: "no-cache" });
    if (!res.ok) return;
    const ids = await res.json();
    if (Array.isArray(ids)) state.mediaIndex = new Set(ids);
  } catch (_) { /* 未配置なら画像機能は無効のまま */ }
}

/** 「はじめる」= 次にやる種目まで運んで強調するだけ。判断を増やさない */
/**
 * 「はじめる」は音声ガイドを開く。
 * 開始の判断を1つに保ちたいので、ここでリストへスクロールさせる従来動作は
 * ガイドを開けないときの退避にした（リストから個別に記録する道は残っている）。
 */
function setupStartButton() {
  $("start-btn").addEventListener("click", async () => {
    const remaining = state.flat.filter((p) => !state.loggedToday.has(p.ex.id));
    if (remaining.length === 0) {
      showToast("今日のメニューはすべて完了しています");
      return;
    }
    const btn = $("start-btn");
    btn.disabled = true;
    try {
      const opened = await guide.open(remaining);
      if (!opened) scrollToNext();
    } catch (err) {
      console.error(err);
      showToast("音声ガイドを開けませんでした");
      scrollToNext();
    } finally {
      btn.disabled = false;
    }
  });
}

function scrollToNext() {
  const next = state.flat.find((p) => !state.loggedToday.has(p.ex.id));
  if (!next) return;
  const el = document.querySelector(`.ex[data-id="${next.ex.id}"]`);
  if (!el) return;
  document.querySelectorAll(".ex.is-next").forEach((c) => c.classList.remove("is-next"));
  el.classList.add("is-next");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * ガイドから届いた完了を記録する。
 * 画面の行も同じように更新するので、ガイドを閉じたあと食い違わない。
 */
async function recordFromGuide(item) {
  const ex = item.ex;
  if (state.loggedToday.has(ex.id)) return;
  const calories = calcCalories(ex, effectiveWeight(), item.sets);
  try {
    state.log = await storage.addExercise(state.today, {
      id: ex.id, name: ex.name, calories,
    });
    state.loggedToday.add(ex.id);
    const rowEl = document.querySelector(`.ex[data-id="${ex.id}"]`);
    const btnEl = rowEl && rowEl.querySelector(".ex__done");
    if (rowEl && btnEl) markRowDone(rowEl, btnEl, false);
    updateProgress();
    await renderSide();
  } catch (err) {
    console.error(err);
  }
}

const guide = new Guide({
  onExerciseDone: recordFromGuide,
  onClose: () => { scrollToNext(); },
  settings: { voice_enabled: true },
});

// ガイド内で音声のオンオフを変えたら設定として覚えておく
document.addEventListener("voice-pref-changed", (e) => {
  if (!state.settings) return;
  state.settings.voice_enabled = e.detail.enabled;
  persistSettings().catch(() => { });
});

function setupRestButton() {
  $("rest-btn").addEventListener("click", async () => {
    if (!state.log.rest && state.loggedToday.size > 0) {
      showToast("すでに記録があるため休養日にできません");
      return;
    }
    state.log = await storage.setRest(state.today, !state.log.rest);
    renderToday();
    await renderSide();
    showToast(state.log.rest
      ? "休養日にしました。継続日数は途切れません"
      : "休養日を取り消しました");
  });
}

function setupWeightInput() {
  const input = $("weight-input");
  if (state.log.weight_kg != null) input.value = state.log.weight_kg;
  else input.placeholder = `${state.fallbackWeight}`;

  $("save-weight-btn").addEventListener("click", async () => {
    const value = parseFloat(input.value);
    if (!value || value <= 0 || value > 400) {
      showToast("体重は正しい数値で入力してください");
      return;
    }
    state.log = await storage.saveLog(state.today, { weight_kg: value });
    state.fallbackWeight = value;
    renderToday();
    showToast("体重を保存しました");
  });
}

/* ---------------- 表示テーマ ---------------- */

const THEMES = [
  { key: "light", label: "ライト" },
  { key: "dark",  label: "ダーク" },
  { key: "auto",  label: "OSに合わせる" },
];

/**
 * テーマを適用する。
 * 既定は "light" で、OS のダークモードには追従しない。
 * "auto" を選んだときだけ CSS 側の prefers-color-scheme が効く。
 */
function applyTheme(theme) {
  const t = THEMES.some((x) => x.key === theme) ? theme : "light";
  if (t === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch (_) { /* 保存できなくても表示は成立する */ }

  // アドレスバーの色も合わせる
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = t === "dark" ||
      (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    meta.setAttribute("content", dark ? "#121815" : "#F5F8F5");
  }
}

/**
 * 体力レベル。ここを変えると出てくる種目そのものが変わるので、
 * 何件が対象になるのかをその場で示す（黙って変わると理由が分からない）。
 */
function renderLevelChips() {
  const current = () => clampLevel(state.settings.strength_level);
  buildValueChips("chips-level", STRENGTH_LEVELS.map((l) => l.key),
    current,
    async (key) => {
      state.settings.strength_level = key;
      await persistSettings();
      renderLevelChips();
      renderToday();
      if (typeof renderCatalog === "function") renderCatalog();
    },
    (key) => `${key}. ${(STRENGTH_LEVELS.find((l) => l.key === key) || {}).label}`);

  const lv = current();
  const meta = STRENGTH_LEVELS.find((l) => l.key === lv) || {};
  const [lo, hi] = levelRange(lv);
  const n = state.exercises.filter(
    (ex) => ex.type === "strength" && (ex.level || 3) >= lo && (ex.level || 3) <= hi).length;
  $("level-hint").textContent = `${meta.note} ・ 対象の筋トレ ${n}種目`;
}

function renderThemeChips() {
  buildValueChips("chips-theme", THEMES.map((t) => t.key),
    () => state.settings.theme || "light",
    async (key) => {
      state.settings.theme = key;
      applyTheme(key);
      await persistSettings();
      renderThemeChips();
    },
    (key) => (THEMES.find((t) => t.key === key) || {}).label);
}

/* ---------------- 設定 ---------------- */

function renderSettingsFilters() {
  buildValueChips("chips-default-time", TIME_PRESETS,
    () => state.settings.default_minutes, async (v) => {
      state.settings.default_minutes = v;
      await persistSettings();
      renderSettingsFilters();
      renderTimeChips();
      renderToday();
    }, (v) => `${v}分`);

  buildMultiChips("chips-strength-category",
    uniqueCategoriesByType(state.exercises, "strength"),
    state.filters.strengthCategory, onSettingsChange);
  buildMultiChips("chips-stretch-category",
    uniqueCategoriesByType(state.exercises, "stretch"),
    state.filters.stretchCategory, onSettingsChange);
  buildMultiChips("chips-purpose", PURPOSES, state.filters.purpose, onSettingsChange);
  buildMultiChips("chips-equipment", uniqueEquipment(state.exercises),
    state.filters.equipment, onSettingsChange);
}

async function onSettingsChange() {
  renderSettingsFilters();
  await persistSettings();
  renderToday();
}

async function persistSettings() {
  state.settings = await storage.saveSettings({
    strength_categories: Array.from(state.filters.strengthCategory),
    stretch_categories: Array.from(state.filters.stretchCategory),
    purposes: Array.from(state.filters.purpose),
    equipment: Array.from(state.filters.equipment),
    default_minutes: state.settings.default_minutes,
    theme: state.settings.theme,
    voice_enabled: state.settings.voice_enabled !== false,
    strength_level: clampLevel(state.settings.strength_level),
  });
}

/* ---------------- 人体図モーダル ---------------- */

function setupBodyMap() {
  const modal = $("body-modal");
  const hint = $("hover-label");

  $("open-body-map-btn").addEventListener("click", () => {
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    syncBodyMapSelection();
  });

  async function close() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    hint.textContent = "部位をタップして選択してください";
    await storage.saveLog(state.today, { pain_regions: state.log.pain_regions });
    renderPainChips();
    renderToday();
  }

  $("close-body-map-btn").addEventListener("click", close);
  $("body-modal-backdrop").addEventListener("click", close);

  document.querySelectorAll(".side-toggle__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.bodySide = btn.dataset.side;
      document.querySelectorAll(".side-toggle__btn")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      $("svg-front").classList.toggle("is-active", state.bodySide === "front");
      $("svg-back").classList.toggle("is-active", state.bodySide === "back");
    });
  });

  document.querySelectorAll(".body-svg .region").forEach((node) => {
    const region = node.dataset.region;
    node.addEventListener("mouseenter", () => { hint.textContent = region; });
    node.addEventListener("click", () => {
      const set = new Set(state.log.pain_regions || []);
      set.has(region) ? set.delete(region) : set.add(region);
      state.log.pain_regions = Array.from(set);
      hint.textContent = `${region} を${set.has(region) ? "選択" : "解除"}しました`;
      syncBodyMapSelection();
    });
  });
}

function syncBodyMapSelection() {
  const set = new Set(state.log.pain_regions || []);
  document.querySelectorAll(".body-svg .region").forEach((node) => {
    node.classList.toggle("is-selected", set.has(node.dataset.region));
  });
  const box = $("modal-selected");
  box.textContent = set.size === 0
    ? "選択中の部位はありません"
    : `選択中: ${Array.from(set).join("・")}`;
}

/* ---------------- 記録：カレンダー ---------------- */

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

async function renderCalendar() {
  const { y, m } = state.calMonth;
  $("cal-title").textContent = `${y}年${m + 1}月`;

  const last = new Date(y, m + 1, 0);
  const from = toDateKey(new Date(y, m, 1));
  const to = toDateKey(last);
  const logs = await storage.getLogs(from, to);
  const byDate = new Map(logs.map((l) => [l.date, l]));

  const box = $("calendar");
  box.innerHTML = "";

  DOW.forEach((d, i) => {
    const h = document.createElement("div");
    h.className = "cal__dow" + (i === 0 ? " cal__dow--sun" : i === 6 ? " cal__dow--sat" : "");
    h.textContent = d;
    box.appendChild(h);
  });

  const startDow = new Date(y, m, 1).getDay();
  for (let i = 0; i < startDow; i++) {
    const pad = document.createElement("div");
    pad.className = "cal__day cal__day--pad";
    box.appendChild(pad);
  }

  let trained = 0, rested = 0, calories = 0, weight = null;

  for (let d = 1; d <= last.getDate(); d++) {
    const key = toDateKey(new Date(y, m, d));
    const log = byDate.get(key);
    const cell = document.createElement("div");
    cell.className = "cal__day" + (key === state.today ? " cal__day--today" : "");

    const num = document.createElement("span");
    num.className = "cal__num";
    num.textContent = String(d);
    cell.appendChild(num);

    const dots = document.createElement("span");
    dots.className = "cal__dots";
    const marks = [];

    if (log) {
      const ex = log.exercises || [];
      if (ex.length > 0) {
        trained++;
        calories += ex.reduce((s, e) => s + (e.calories || 0), 0);
        const types = new Set(ex.map((e) => (EX_BY_ID.get(e.id) || {}).type));
        if (types.has("strength")) marks.push("strength");
        if (types.has("stretch")) marks.push("stretch");
      } else if (log.rest) {
        rested++;
        marks.push("rest");
      }
      if (log.pain_regions && log.pain_regions.length > 0) marks.push("pain");
      if (log.weight_kg != null) weight = log.weight_kg;
    }

    marks.forEach((mk) => {
      const dot = document.createElement("i");
      dot.className = `dot dot--${mk}`;
      dots.appendChild(dot);
    });
    cell.appendChild(dots);

    const labels = { strength: "筋トレ", stretch: "ストレッチ", rest: "休養日", pain: "痛みあり" };
    cell.title = `${y}/${m + 1}/${d}` +
      (marks.length ? ` — ${marks.map((k) => labels[k]).join("・")}` : " — 記録なし");
    box.appendChild(cell);
  }

  renderKpi({ trained, rested, calories, weight, days: last.getDate() });
}

function renderKpi({ trained, rested, calories, weight }) {
  const row = $("kpi-row");
  row.innerHTML = "";
  const items = [
    { label: "実施した日", value: trained, sub: "日" },
    { label: "休養日", value: rested, sub: "日" },
    { label: "消費カロリー", value: Math.round(calories).toLocaleString(), sub: "kcal" },
    { label: "体重（最新）", value: weight != null ? weight : "—", sub: weight != null ? "kg" : "" },
  ];
  items.forEach((it) => {
    const box = document.createElement("div");
    box.className = "kpi";
    box.innerHTML = `<div class="kpi__label"></div>
      <div class="kpi__value"></div><div class="kpi__sub"></div>`;
    box.querySelector(".kpi__label").textContent = it.label;
    box.querySelector(".kpi__value").textContent = String(it.value);
    box.querySelector(".kpi__sub").textContent = it.sub;
    row.appendChild(box);
  });
}

/* ---------------- 記録：グラフと履歴 ---------------- */

const RANGES = [
  { label: "2週間", days: 14 },
  { label: "1か月", days: 30 },
  { label: "3か月", days: 90 },
];

function renderRangeChips() {
  buildValueChips("chips-range", RANGES.map((r) => r.days),
    () => state.historyRange, (days) => {
      state.historyRange = days;
      renderRangeChips();
      renderCharts();
    }, (days) => (RANGES.find((r) => r.days === days) || {}).label);
}

async function renderCharts() {
  const data = await storage.getHistory(state.historyRange, state.today);
  renderWeightChart($("chart-weight"), data);
  renderCaloriesChart($("chart-calories"), data);

  // 部位バランス：期間内の実施種目をグループ単位で集計
  const logs = await storage.getLogs(data[0].date, data[data.length - 1].date);
  const counts = new Map();
  logs.forEach((l) => {
    (l.exercises || []).forEach((e) => {
      const ex = EX_BY_ID.get(e.id);
      if (!ex) return;
      const g = regionGroupOf(ex.category);
      counts.set(g, (counts.get(g) || 0) + 1);
    });
  });
  const items = Array.from(counts, ([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  renderBalanceChart($("chart-balance"), items);

  renderHistoryList(logs);
}

function renderHistoryList(logs) {
  const list = $("history-list");
  const rows = logs
    .filter((l) => (l.exercises || []).length > 0 || l.rest)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  list.innerHTML = "";
  if (rows.length === 0) {
    list.innerHTML = `<p class="chart-empty">この期間の記録はまだありません</p>`;
    return;
  }

  rows.forEach((l) => {
    const ex = l.exercises || [];
    const cal = ex.reduce((s, e) => s + (e.calories || 0), 0);
    const item = document.createElement("div");
    item.className = "history-item" + (ex.length === 0 ? " history-item--rest" : "");
    item.innerHTML = `
      <div class="history-item__head">
        <span class="history-item__date"></span>
        <span class="history-item__nums"></span>
      </div>
      <div class="history-item__names"></div>
    `;
    item.querySelector(".history-item__date").textContent = l.date;
    item.querySelector(".history-item__nums").textContent = ex.length === 0
      ? "休養日"
      : `${Math.round(cal)} kcal ・ ${ex.length}種目` +
        (l.weight_kg != null ? ` ・ ${l.weight_kg}kg` : "");
    item.querySelector(".history-item__names").textContent = ex.length === 0
      ? "しっかり休みました"
      : ex.map((e) => e.name).join("・");
    list.appendChild(item);
  });
}

function setupCalendarNav() {
  $("cal-prev").addEventListener("click", () => {
    const d = new Date(state.calMonth.y, state.calMonth.m - 1, 1);
    state.calMonth = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar();
  });
  $("cal-next").addEventListener("click", () => {
    const d = new Date(state.calMonth.y, state.calMonth.m + 1, 1);
    state.calMonth = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar();
  });
  $("cal-today").addEventListener("click", () => {
    const now = new Date();
    state.calMonth = { y: now.getFullYear(), m: now.getMonth() };
    renderCalendar();
  });
}

/* ---------------- データ管理 ---------------- */

function setupDataTools() {
  $("export-btn").addEventListener("click", async () => {
    const payload = await storage.exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `training-log-${state.today}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("エクスポートしました");
  });

  $("import-btn").addEventListener("click", () => $("import-file").click());

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const count = await storage.importAll(JSON.parse(text), "merge");
      showToast(`${count}日分を取り込みました。再読み込みします`);
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      showToast(`取り込みに失敗しました: ${err.message}`);
    } finally {
      e.target.value = "";
    }
  });
}

async function renderStorageInfo() {
  const parts = [];
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage != null) parts.push(`使用容量 約${Math.max(1, Math.round(usage / 1024))}KB`);
    }
    if (navigator.storage && navigator.storage.persisted) {
      parts.push(await navigator.storage.persisted()
        ? "永続化 有効"
        : "永続化 未許可（ブラウザの判断で削除される可能性があります）");
    }
  } catch (_) { /* 非対応環境 */ }
  $("storage-info").textContent = parts.join(" ・ ");
}

/* ---------------- ナビゲーション ---------------- */

/* ---------------- 種目一覧 ---------------- */

const catalogState = { q: "", type: "all", level: "all", equip: "all" };

function levelDot(level) {
  // 1〜5を目盛りで見せる。数字だけだと大小の感覚が掴めない
  const wrap = document.createElement("span");
  wrap.className = "lv";
  wrap.title = `負荷レベル ${level}`;
  for (let i = 1; i <= 5; i++) {
    const d = document.createElement("i");
    d.className = "lv__dot" + (i <= level ? " is-on" : "");
    wrap.appendChild(d);
  }
  return wrap;
}

function catalogMatches(ex) {
  const [lo, hi] = levelRange(clampLevel(state.settings.strength_level));
  const lv = ex.level || 3;
  if (catalogState.type !== "all" && ex.type !== catalogState.type) return false;
  if (catalogState.equip !== "all" && ex.equipment !== catalogState.equip) return false;
  if (catalogState.level === "mine") {
    if (ex.type === "stretch" ? lv > hi + 1 : (lv < lo || lv > hi)) return false;
  } else if (catalogState.level !== "all" && lv !== Number(catalogState.level)) {
    return false;
  }
  const q = catalogState.q.trim();
  if (q) {
    const hay = `${ex.name} ${ex.category} ${ex.equipment} ${(ex.purpose || []).join(" ")}`;
    if (!hay.toLowerCase().includes(q.toLowerCase())) return false;
  }
  return true;
}

function renderCatalog() {
  const box = $("ex-catalog");
  box.innerHTML = "";
  const list = state.exercises.filter(catalogMatches);

  $("ex-count").textContent = list.length === 0
    ? "条件に合う種目がありません"
    : `${list.length} / ${state.exercises.length} 種目`;

  if (list.length === 0) return;

  // 部位ごとにまとめる。フラットに並べると300件は読めない
  const byCategory = new Map();
  list.forEach((ex) => {
    if (!byCategory.has(ex.category)) byCategory.set(ex.category, []);
    byCategory.get(ex.category).push(ex);
  });

  for (const [cat, items] of byCategory) {
    const head = document.createElement("h4");
    head.className = "catalog__head";
    head.textContent = `${cat}（${items.length}）`;
    box.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "catalog";
    items.sort((a, b) => (a.level || 3) - (b.level || 3));
    items.forEach((ex) => {
      const li = document.createElement("li");
      li.className = "catalog__row" + (ex.type === "stretch" ? " catalog__row--stretch" : "");

      const art = document.createElement("span");
      art.className = "catalog__art";
      art.appendChild(poseArt(regionGroupOf(ex.category)));
      li.appendChild(art);

      const body = document.createElement("div");
      body.className = "catalog__body";
      const name = document.createElement("span");
      name.className = "catalog__name";
      name.textContent = ex.name;
      body.appendChild(name);
      const meta = document.createElement("span");
      meta.className = "catalog__meta";
      const amount = ex.default_duration_sec != null
        ? `${ex.default_duration_sec}秒`
        : `${ex.default_reps || 10}回`;
      const parts = [ex.type === "stretch" ? "ストレッチ" : "筋トレ",
                     `${amount} × ${ex.default_sets}セット`];
      if (ex.equipment && ex.equipment !== "なし") parts.push(ex.equipment);
      if (ex.daily_ok) parts.push("毎日OK");
      meta.textContent = parts.join(" ・ ");
      body.appendChild(meta);
      li.appendChild(body);

      li.appendChild(levelDot(ex.level || 3));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
}

function setupCatalog() {
  const rerender = () => renderCatalog();

  buildValueChips("ex-filter-type", ["all", "strength", "stretch"],
    () => catalogState.type,
    (v) => { catalogState.type = v; setupCatalogChips(); rerender(); },
    (v) => ({ all: "すべて", strength: "筋トレ", stretch: "ストレッチ" }[v]));

  buildValueChips("ex-filter-level", ["all", "mine", 1, 2, 3, 4, 5],
    () => catalogState.level,
    (v) => { catalogState.level = v; setupCatalogChips(); rerender(); },
    (v) => ({ all: "すべて", mine: "自分のレベル" }[v] || `レベル${v}`));

  const equips = ["all", ...uniqueEquipment(state.exercises)];
  buildValueChips("ex-filter-equip", equips,
    () => catalogState.equip,
    (v) => { catalogState.equip = v; setupCatalogChips(); rerender(); },
    (v) => (v === "all" ? "すべて" : v));

  const input = $("ex-search");
  input.addEventListener("input", () => { catalogState.q = input.value; rerender(); });

  renderCatalog();
}

// 選択状態を描き直すだけの再構築（buildValueChips は毎回作り直す作り）
function setupCatalogChips() {
  buildValueChips("ex-filter-type", ["all", "strength", "stretch"],
    () => catalogState.type,
    (v) => { catalogState.type = v; setupCatalogChips(); renderCatalog(); },
    (v) => ({ all: "すべて", strength: "筋トレ", stretch: "ストレッチ" }[v]));
  buildValueChips("ex-filter-level", ["all", "mine", 1, 2, 3, 4, 5],
    () => catalogState.level,
    (v) => { catalogState.level = v; setupCatalogChips(); renderCatalog(); },
    (v) => ({ all: "すべて", mine: "自分のレベル" }[v] || `レベル${v}`));
  const equips = ["all", ...uniqueEquipment(state.exercises)];
  buildValueChips("ex-filter-equip", equips,
    () => catalogState.equip,
    (v) => { catalogState.equip = v; setupCatalogChips(); renderCatalog(); },
    (v) => (v === "all" ? "すべて" : v));
}

function setupNav() {
  document.querySelectorAll(".nav__item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      document.querySelectorAll(".nav__item")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".view")
        .forEach((v) => v.classList.toggle("is-active", v.id === `view-${view}`));
      window.scrollTo({ top: 0, behavior: "instant" });
      if (view === "history") { renderCalendar(); renderCharts(); }
      if (view === "exercises") renderCatalog();
    });
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($("view-history").classList.contains("is-active")) renderCharts();
  }, 200);
});

/* ---------------- 起動 ---------------- */

async function init() {
  const [settings, log] = await Promise.all([
    storage.getSettings(),
    storage.getLog(todayKey()),
  ]);
  state.settings = settings;
  state.log = log;
  applyTheme(settings.theme);
  guide.settings = settings;   // 音声のオンオフは設定として持ち回る
  state.loggedToday = new Set((log.exercises || []).map((e) => e.id));

  state.filters.strengthCategory = new Set(settings.strength_categories);
  state.filters.stretchCategory = new Set(settings.stretch_categories);
  state.filters.purpose = new Set(settings.purposes);
  state.filters.equipment = new Set(settings.equipment);

  const now = new Date();
  state.calMonth = { y: now.getFullYear(), m: now.getMonth() };

  await Promise.all([loadFallbackWeight(), loadMediaIndex()]);
  state.lastTrained = await storage.getLastTrainedMap(state.today);

  setupNav();
  setupStartButton();
  setupRestButton();
  setupWeightInput();
  setupBodyMap();
  setupCalendarNav();
  setupDataTools();

  renderConditionFaces();
  renderTimeChips();
  renderPainChips();
  syncBodyMapSelection();
  renderSettingsFilters();
  renderLevelChips();
  renderThemeChips();
  setupCatalog();
  renderRangeChips();
  renderToday();

  const now2 = new Date();
  $("appbar-today").textContent =
    `${now2.getMonth() + 1}月${now2.getDate()}日（${DOW_SHORT[now2.getDay()]}）`;

  await renderSide();
  renderStorageInfo();

  requestPersistence().then(() => renderStorageInfo());

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
  }
}

// 日付をまたいだまま開きっぱなしのときに today がずれないようにする
setInterval(() => {
  if (todayKey() !== state.today) location.reload();
}, 60 * 1000);

/**
 * 起動失敗時の自動復旧。
 *
 * 古い Service Worker が古い app.js を配り続けていると、新しい index.html と
 * 組み合わさって「存在しない要素を触る」形で起動に失敗する。
 * 利用者に DevTools を開かせるわけにはいかないので、
 * 一度だけ SW とキャッシュを捨てて読み直す。
 * sessionStorage のフラグで、無限リロードにならないようにしている。
 */
const RECOVERY_FLAG = "sw-recovery-attempted";

async function recoverFromStaleCache() {
  if (sessionStorage.getItem(RECOVERY_FLAG)) return false;
  sessionStorage.setItem(RECOVERY_FLAG, "1");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) {
    console.warn("復旧処理に失敗:", e);
    return false;
  }
  return true;
}

init()
  .then(() => sessionStorage.removeItem(RECOVERY_FLAG))
  .catch(async (err) => {
    console.error(err);
    if (await recoverFromStaleCache()) {
      location.reload();
      return;
    }
    document.body.insertAdjacentHTML("afterbegin",
      `<div class="empty-state" style="margin:16px;text-align:left">
        <strong>起動に失敗しました</strong><br>${err.message}
        <pre style="white-space:pre-wrap;font-size:11px;opacity:.7;margin-top:8px">${
          (err.stack || "").split("\n").slice(0, 4).join("\n")
        }</pre>
      </div>`);
  });
