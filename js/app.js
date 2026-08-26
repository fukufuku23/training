/**
 * 画面制御。ストレージ層（storage.js）とドメインロジック（domain.js）だけに依存する。
 * フェーズ2で storage.js の中身が Supabase 同期付きに変わっても、このファイルは無変更。
 *
 * 設計方針:
 *  - モバイル＝「迷わず始める」。判断を「はじめる」の1つに絞る
 *  - PC＝「振り返る」。カレンダーと分析
 *  - 休養日を明示的に肯定する（継続日数を切らさない）
 */

import { EXERCISES } from "./exercises.js";
import { storage, todayKey, shiftDate, toDateKey, requestPersistence } from "./storage.js";
import {
  CONDITIONS, PAIN_REGIONS, PURPOSES, TIME_PRESETS,
  conditionByKey, calcCalories, filterExercises, curateForTime, warningFor,
  uniqueCategoriesByType, uniqueEquipment, youtubeUrl, imageSearchUrl,
  regionGroupOf, summarizeCourse,
} from "./domain.js";
import { renderWeightChart, renderCaloriesChart, renderBalanceChart } from "./chart.js";

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

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2600);
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

async function refreshStreak() {
  $("stat-streak").textContent = String(await storage.getStreak(state.today));
}

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

/** 今日のメニューを組み立てて、コースカードとカードリストを更新する */
function renderToday() {
  const card = $("course-card");
  const startBtn = $("start-btn");
  const restBtn = $("rest-btn");
  const list = $("card-list");

  // --- 休養日 ---
  if (state.log.rest) {
    card.classList.add("is-rest");
    $("course-title").textContent = "休養日";
    $("course-sub").textContent = "しっかり休むのもトレーニングのうちです。継続日数は途切れません。";
    $("course-steps").innerHTML = "";
    $("course-progress").style.width = "100%";
    $("course-progress-label").textContent = "休養";
    startBtn.disabled = true;
    startBtn.textContent = "今日はお休み";
    restBtn.textContent = "やっぱり運動する";
    restBtn.classList.add("is-on");
    list.innerHTML = "";
    $("menu-summary").textContent = "";
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
  });
  const { picked, totalMin } = curateForTime(filtered, currentMinutes(), state.log.condition);
  state.picked = picked;

  // 設定時間ではなく「実際に組めた時間」を出す。
  // 体調が悪い日はセット数が減って短くなるので、設定値を出すと嘘になる。
  $("course-title").textContent = picked.length
    ? `${Math.round(totalMin)}分コース`
    : "メニューなし";

  const steps = summarizeCourse(picked);
  const stepsBox = $("course-steps");
  stepsBox.innerHTML = "";
  steps.forEach((s, i) => {
    if (i > 0) {
      const arrow = document.createElement("li");
      arrow.className = "step__arrow";
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      stepsBox.appendChild(arrow);
    }
    const li = document.createElement("li");
    li.className = `step step--${s.key}`;
    const icon = document.createElement("span");
    icon.className = "step__icon";
    icon.appendChild(svg(STEP_ICON[s.key]));
    li.appendChild(icon);
    const label = document.createElement("span");
    label.className = "step__label";
    label.textContent = s.label;
    li.appendChild(label);
    const meta = document.createElement("span");
    meta.className = "step__meta";
    meta.textContent = `${s.count}種目 ・ ${s.minutes}分`;
    li.appendChild(meta);
    stepsBox.appendChild(li);
  });

  const done = picked.filter((p) => state.loggedToday.has(p.ex.id)).length;
  const pct = picked.length ? Math.round((done / picked.length) * 100) : 0;
  $("course-progress").style.width = `${pct}%`;
  $("course-progress-label").textContent = `${done} / ${picked.length} 完了`;

  if (picked.length === 0) {
    $("course-sub").textContent = filtered.length === 0
      ? "条件に合う種目がありません。設定を見直してください。"
      : "時間が短すぎます。使える時間を増やしてください。";
    startBtn.disabled = true;
  } else if (done === 0) {
    $("course-sub").textContent = conditionByKey(state.log.condition).note;
    startBtn.textContent = "はじめる";
  } else if (done < picked.length) {
    $("course-sub").textContent = `あと ${picked.length - done} 種目です。`;
    startBtn.textContent = "つづきから";
  } else {
    $("course-sub").textContent = "今日のメニューを完了しました。おつかれさまでした。";
    startBtn.textContent = "完了";
    startBtn.disabled = true;
  }

  renderCards();
}

function renderCards() {
  const list = $("card-list");
  const picked = state.picked;
  list.innerHTML = "";

  if (picked.length === 0) {
    $("menu-summary").textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "条件に合う種目がありません。設定タブで絞り込みを見直してください。";
    list.appendChild(empty);
    return;
  }

  const weight = effectiveWeight();
  const totalCal = picked.reduce((s, p) => s + calcCalories(p.ex, weight, p.sets), 0);
  $("menu-summary").textContent =
    `全${picked.length}種目 ・ 想定 約${Math.round(totalCal)}kcal`;

  const frag = document.createDocumentFragment();
  picked.forEach(({ ex, sets, durationMin }) => {
    frag.appendChild(buildCard(ex, sets, durationMin, weight));
  });
  list.appendChild(frag);
}

function buildMediaSlot(ex) {
  if (!state.mediaIndex || !state.mediaIndex.has(ex.id)) return null;
  const img = document.createElement("img");
  img.className = "card__media-img";
  img.alt = "";
  img.loading = "lazy";
  img.src = `media/images/${ex.id}.jpg`;
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

async function loadMediaIndex() {
  try {
    const res = await fetch("media/index.json", { cache: "no-cache" });
    if (!res.ok) return;
    const ids = await res.json();
    if (Array.isArray(ids)) state.mediaIndex = new Set(ids);
  } catch (_) { /* 未配置なら画像機能は無効のまま */ }
}

function checkSvg() {
  return svg(["M5 12.5 L10 17 L19 7.5"]);
}

function buildCard(ex, sets, durationMin, weight) {
  const warnText = warningFor(ex, state.lastTrained, state.yesterday);
  const calories = calcCalories(ex, weight, sets);
  const done = state.loggedToday.has(ex.id);
  const setsChanged = sets !== (ex.default_sets || 1);

  const card = document.createElement("article");
  card.className = "card" + (warnText ? " is-warn" : "") + (done ? " is-done" : "");
  card.dataset.id = ex.id;

  const setsLabel = ex.type === "stretch"
    ? `${sets}セット`
    : (setsChanged ? `${ex.default_sets}→${sets}セット` : `${sets}セット`);

  card.innerHTML = `
    <div class="${done ? "stamp stamp--static" : "stamp"}"></div>
    <div class="card__info">
      <div class="card__name-row">
        <span class="card__name"></span>
        ${warnText ? `<span class="card__warn">${warnText}</span>` : ""}
      </div>
      <div class="card__meta">${ex.category} ・ 道具 ${ex.equipment}</div>
      <div class="card__meta">${setsLabel} ・ 約${Math.round(durationMin)}分</div>
      <div class="card__chip">想定 ${calories} kcal</div>
      ${ex.source ? `<div class="card__source">出典 ${ex.source}</div>` : ""}
    </div>
    <div class="card__actions">
      <button class="btn btn--outline btn-video" type="button">動画</button>
      <button class="btn btn--outline btn-image" type="button">画像</button>
      <button class="btn btn--done btn-done" type="button" ${done ? "disabled" : ""}>
        ${done ? "記録済み" : "完了"}
      </button>
    </div>
  `;
  card.querySelector(".card__name").textContent = ex.name;
  card.querySelector(".stamp").appendChild(checkSvg());
  const media = buildMediaSlot(ex);
  if (media) card.querySelector(".card__info").prepend(media);

  card.querySelector(".btn-video").addEventListener("click", () => {
    window.open(youtubeUrl(ex.youtube_query), "_blank", "noopener");
  });
  card.querySelector(".btn-image").addEventListener("click", () => {
    window.open(imageSearchUrl(ex.image_query), "_blank", "noopener");
  });
  card.querySelector(".btn-done").addEventListener("click", (e) => {
    handleLogDone(ex, calories, card, e.currentTarget);
  });

  return card;
}

async function handleLogDone(ex, calories, cardEl, buttonEl) {
  buttonEl.disabled = true;
  try {
    state.log = await storage.addExercise(state.today, {
      id: ex.id, name: ex.name, calories,
    });
    state.loggedToday.add(ex.id);
    cardEl.classList.add("is-done");
    cardEl.classList.remove("is-next");
    buttonEl.textContent = "記録済み";
    cardEl.querySelector(".stamp").classList.add("show");

    // 進捗だけ更新する（カードを作り直すとスタンプの演出が消えるため）
    const done = state.picked.filter((p) => state.loggedToday.has(p.ex.id)).length;
    const pct = state.picked.length ? Math.round((done / state.picked.length) * 100) : 0;
    $("course-progress").style.width = `${pct}%`;
    $("course-progress-label").textContent = `${done} / ${state.picked.length} 完了`;
    if (done === state.picked.length) {
      $("course-sub").textContent = "今日のメニューを完了しました。おつかれさまでした。";
      $("start-btn").textContent = "完了";
      $("start-btn").disabled = true;
      showToast("今日のメニューを完了しました");
    } else {
      $("course-sub").textContent = `あと ${state.picked.length - done} 種目です。`;
      $("start-btn").textContent = "つづきから";
    }
    await refreshStreak();
  } catch (err) {
    buttonEl.disabled = false;
    showToast("記録に失敗しました。もう一度お試しください。");
    console.error(err);
  }
}

/** 「はじめる」= 次にやる種目まで運んで強調するだけ。判断を増やさない */
function setupStartButton() {
  $("start-btn").addEventListener("click", () => {
    const next = state.picked.find((p) => !state.loggedToday.has(p.ex.id));
    if (!next) return;
    const el = document.querySelector(`.card[data-id="${next.ex.id}"]`);
    if (!el) return;
    document.querySelectorAll(".card.is-next").forEach((c) => c.classList.remove("is-next"));
    el.classList.add("is-next");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function setupRestButton() {
  $("rest-btn").addEventListener("click", async () => {
    if (!state.log.rest && state.loggedToday.size > 0) {
      showToast("すでに記録があるため休養日にできません");
      return;
    }
    state.log = await storage.setRest(state.today, !state.log.rest);
    await refreshStreak();
    renderToday();
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
  renderRangeChips();
  renderToday();

  await refreshStreak();
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

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<div class="empty-state" style="margin:16px">起動に失敗しました: ${err.message}</div>`);
});
