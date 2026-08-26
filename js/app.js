/**
 * 画面制御。ストレージ層（storage.js）とドメインロジック（domain.js）だけに依存する。
 * フェーズ2で storage.js の中身が Supabase 同期付きに変わっても、このファイルは無変更。
 */

import { EXERCISES } from "./exercises.js";
import {
  storage, todayKey, shiftDate, requestPersistence,
} from "./storage.js";
import {
  CONDITIONS, PAIN_REGIONS, PURPOSES,
  conditionByKey, clampMinutes, estimateDurationMin, calcCalories, adjustedSets,
  filterExercises, curateForTime, warningFor,
  uniqueCategoriesByType, uniqueEquipment, youtubeUrl, imageSearchUrl,
} from "./domain.js";
import { renderWeightChart, renderCaloriesChart } from "./chart.js";

const state = {
  exercises: EXERCISES,
  today: todayKey(),
  yesterday: shiftDate(todayKey(), -1),
  log: null,
  settings: null,
  lastTrained: {},
  fallbackWeight: 60,
  loggedToday: new Set(),
  historyRange: 30,
  mediaIndex: null,
  bodySide: "front",
  filters: {
    strengthCategory: new Set(),
    stretchCategory: new Set(),
    purpose: new Set(),
    equipment: new Set(),
  },
};

const $ = (id) => document.getElementById(id);

/* ---------------- 汎用UI ---------------- */

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2400);
}

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

function buildSingleChips(containerId, values, activeGetter, onSelect, extraClass) {
  const box = $(containerId);
  box.innerHTML = "";
  values.forEach((v) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (extraClass ? ` ${extraClass}` : "") +
      (activeGetter() === v ? " is-active" : "");
    chip.textContent = v;
    chip.addEventListener("click", () => onSelect(v));
    box.appendChild(chip);
  });
}

/* ---------------- 体重の解決 ---------------- */

/** 今日の体重 → 直近の記録 → 既定値60kg の順で採用 */
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

/* ---------------- 統計 ---------------- */

async function refreshStats() {
  const [streak, yLog] = await Promise.all([
    storage.getStreak(state.today),
    storage.getLog(state.yesterday),
  ]);
  const todayCal = (state.log.exercises || []).reduce((s, e) => s + (e.calories || 0), 0);
  const yCal = (yLog.exercises || []).reduce((s, e) => s + (e.calories || 0), 0);

  $("stat-streak").textContent = String(streak);
  $("stat-today").textContent = String(Math.round(todayCal));
  $("stat-yesterday").textContent =
    `${yLog.weight_kg != null ? `${yLog.weight_kg}kg` : "-"} / ${Math.round(yCal)}`;
}

/* ---------------- 今日のメニュー ---------------- */

function renderConditionChips() {
  buildSingleChips(
    "chips-condition",
    CONDITIONS.map((c) => c.label),
    () => conditionByKey(state.log.condition).label,
    (label) => {
      const found = CONDITIONS.find((c) => c.label === label);
      if (found) state.log.condition = found.key;
      onConditionOrPainChange();
    },
    "chip--condition"
  );
  $("condition-hint").textContent = conditionByKey(state.log.condition).note;
}

function renderPainChips() {
  const set = new Set(state.log.pain_regions || []);
  buildMultiChips("chips-pain", PAIN_REGIONS, set, () => {
    state.log.pain_regions = Array.from(set);
    onConditionOrPainChange();
  }, "chip--pain");
}

async function onConditionOrPainChange() {
  renderConditionChips();
  renderPainChips();
  syncBodyMapSelection();
  await storage.saveLog(state.today, {
    condition: state.log.condition,
    pain_regions: state.log.pain_regions,
    minutes: state.log.minutes,
  });
  renderCards();
}

function currentMinutes() {
  return state.log.minutes != null
    ? state.log.minutes
    : state.settings.default_minutes;
}

function renderCards() {
  const list = $("card-list");
  const summary = $("menu-summary");
  const filtered = filterExercises(state.exercises, {
    ...state.filters,
    painRegions: state.log.pain_regions || [],
    conditionKey: state.log.condition,
  });
  const { picked, totalMin } = curateForTime(
    filtered, currentMinutes(), state.log.condition
  );

  list.innerHTML = "";
  if (picked.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = filtered.length === 0
      ? "条件に合う種目がありません。設定タブで絞り込みを見直してください。"
      : "設定時間が短すぎて表示できる種目がありません。時間を増やしてみてください。";
    list.appendChild(empty);
    summary.textContent = "";
    return;
  }

  const weight = effectiveWeight();
  const totalCal = picked.reduce((s, p) => s + calcCalories(p.ex, weight, p.sets), 0);
  summary.textContent =
    `厳選 ${picked.length}種目 ・ 合計 約${Math.round(totalMin)}分 ・ 約${Math.round(totalCal)}kcal`;

  const frag = document.createDocumentFragment();
  picked.forEach(({ ex, sets, durationMin }) => {
    frag.appendChild(buildCard(ex, sets, durationMin, weight));
  });
  list.appendChild(frag);
}

function buildMediaSlot(ex) {
  // media/index.json に載っている種目だけ画像を出す。
  // マニフェストが無ければ画像は一切要求しない（196件分の404を防ぐ）。
  if (!state.mediaIndex || !state.mediaIndex.has(ex.id)) return null;
  const img = document.createElement("img");
  img.className = "card__media-img";
  img.alt = "";
  img.loading = "lazy";
  img.src = `media/images/${ex.id}.jpg`;
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

/**
 * 画像を追加したら media/index.json を置く（種目IDの配列）。
 *   ["chest_01", "back_03"]
 * ファイルが無ければ画像機能は自動的に無効になる。
 */
async function loadMediaIndex() {
  try {
    const res = await fetch("media/index.json", { cache: "no-cache" });
    if (!res.ok) return;
    const ids = await res.json();
    if (Array.isArray(ids)) state.mediaIndex = new Set(ids);
  } catch (_) { /* 未配置なら何もしない */ }
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
    <div class="${done ? "stamp stamp--static" : "stamp"}">済</div>
    <div class="card__info">
      <div class="card__name-row">
        <span class="card__name"></span>
        ${warnText ? `<span class="card__warn">${warnText}</span>` : ""}
      </div>
      <div class="card__meta">部位 ${ex.category} ・ 道具 ${ex.equipment}</div>
      <div class="card__meta">${setsLabel} ・ 約${Math.round(durationMin)}分</div>
      <div class="card__chip">想定消費 ${calories} kcal</div>
      ${ex.source ? `<div class="card__source">出典 ${ex.source}</div>` : ""}
    </div>
    <div class="card__actions">
      <button class="btn btn--outline btn-video" type="button">動画</button>
      <button class="btn btn--outline btn-image" type="button">画像</button>
      <button class="btn btn--stamp btn-done" type="button" ${done ? "disabled" : ""}>
        ${done ? "記録済み" : "完了"}
      </button>
    </div>
  `;
  // 種目名はテキストとして設定（HTMLとして解釈させない）
  card.querySelector(".card__name").textContent = ex.name;
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
    buttonEl.textContent = "記録済み";
    cardEl.querySelector(".stamp").classList.add("show");
    await refreshStats();
    showToast(`「${ex.name}」を記録しました（+${calories}kcal）`);
  } catch (err) {
    buttonEl.disabled = false;
    showToast("記録に失敗しました。もう一度お試しください。");
    console.error(err);
  }
}

/* ---------------- 体重入力 ---------------- */

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
    await refreshStats();
    renderCards();
    showToast("体重を保存しました");
  });
}

/* ---------------- 時間入力 ---------------- */

function setupTimeInputs() {
  const todayInput = $("today-time-input");
  todayInput.value = currentMinutes();
  todayInput.addEventListener("change", async () => {
    const v = clampMinutes(todayInput.value, currentMinutes());
    todayInput.value = v;
    state.log.minutes = v;
    await storage.saveLog(state.today, { minutes: v });
    renderCards();
  });

  const settingsInput = $("settings-time-input");
  settingsInput.value = state.settings.default_minutes;
  settingsInput.addEventListener("change", async () => {
    const v = clampMinutes(settingsInput.value, state.settings.default_minutes);
    settingsInput.value = v;
    state.settings.default_minutes = v;
    await persistSettings();
  });
}

/* ---------------- 設定タブ ---------------- */

function renderSettingsFilters() {
  buildMultiChips("chips-strength-category",
    uniqueCategoriesByType(state.exercises, "strength"),
    state.filters.strengthCategory, onSettingsChange);
  buildMultiChips("chips-stretch-category",
    uniqueCategoriesByType(state.exercises, "stretch"),
    state.filters.stretchCategory, onSettingsChange);
  buildMultiChips("chips-purpose", PURPOSES,
    state.filters.purpose, onSettingsChange);
  buildMultiChips("chips-equipment", uniqueEquipment(state.exercises),
    state.filters.equipment, onSettingsChange);
}

async function onSettingsChange() {
  renderSettingsFilters();
  await persistSettings();
  renderCards();
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
    renderPainChips();
    await storage.saveLog(state.today, { pain_regions: state.log.pain_regions });
    renderCards();
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

/* ---------------- 記録タブ ---------------- */

const RANGES = [
  { label: "2週間", days: 14 },
  { label: "1か月", days: 30 },
  { label: "3か月", days: 90 },
];

function renderRangeChips() {
  buildSingleChips(
    "chips-range",
    RANGES.map((r) => r.label),
    () => (RANGES.find((r) => r.days === state.historyRange) || {}).label,
    (label) => {
      const found = RANGES.find((r) => r.label === label);
      if (found) state.historyRange = found.days;
      renderRangeChips();
      renderHistory();
    }
  );
}

async function renderHistory() {
  const data = await storage.getHistory(state.historyRange, state.today);
  renderWeightChart($("chart-weight"), data);
  renderCaloriesChart($("chart-calories"), data);

  const list = $("history-list");
  const done = data.filter((d) => d.count > 0).reverse();
  if (done.length === 0) {
    list.innerHTML = `<p class="chart-empty">この期間の実施記録はまだありません</p>`;
    return;
  }

  const logs = await storage.getLogs(data[0].date, data[data.length - 1].date);
  const byDate = new Map(logs.map((l) => [l.date, l]));

  list.innerHTML = "";
  done.forEach((d) => {
    const log = byDate.get(d.date);
    const item = document.createElement("div");
    item.className = "history-item";
    const names = (log.exercises || []).map((e) => e.name).join("・");
    item.innerHTML = `
      <div class="history-item__head">
        <span class="history-item__date"></span>
        <span class="history-item__nums">${Math.round(d.calories)} kcal ・ ${d.count}種目${
          d.weight != null ? ` ・ ${d.weight}kg` : ""
        }</span>
      </div>
      <div class="history-item__names"></div>
    `;
    item.querySelector(".history-item__date").textContent = d.date;
    item.querySelector(".history-item__names").textContent = names;
    list.appendChild(item);
  });
}

/* ---------------- データ管理 ---------------- */

function setupDataTools() {
  $("export-btn").addEventListener("click", async () => {
    const payload = await storage.exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
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
      if (view === "history") renderHistory();
    });
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($("view-history").classList.contains("is-active")) renderHistory();
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

  await Promise.all([loadFallbackWeight(), loadMediaIndex()]);
  state.lastTrained = await storage.getLastTrainedMap(state.today);

  setupNav();
  setupWeightInput();
  setupTimeInputs();
  setupBodyMap();
  setupDataTools();

  renderSettingsFilters();
  renderConditionChips();
  renderPainChips();
  syncBodyMapSelection();
  renderRangeChips();
  renderCards();

  await refreshStats();
  renderStorageInfo();

  // iOS のストレージ削除対策（ホーム画面追加時に許可されやすい）
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
