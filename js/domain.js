/**
 * ドメインロジック — 既存 www/script.js から移植した純粋関数群。
 * DOM にもストレージにも依存しないので、そのままテストできる。
 */

export const REST_SEC_STRENGTH = 45;
export const SEC_PER_REP = 3;
export const MIN_MINUTES = 10;
export const MAX_MINUTES = 120;

export const PURPOSES = ["筋肥大", "筋力向上", "引き締め", "柔軟性向上"];

export const CONDITIONS = [
  { key: "good", label: "絶好調", setsDelta: 1, lightOnly: false,
    note: "いつもより少し多めの負荷にします。" },
  { key: "normal", label: "普通", setsDelta: 0, lightOnly: false,
    note: "通常メニューです。" },
  { key: "tired", label: "やや疲れ気味", setsDelta: -1, lightOnly: false,
    note: "セット数を少し減らして負荷を下げます。" },
  { key: "exhausted", label: "お疲れ気味", setsDelta: -2, lightOnly: true,
    note: "毎日OKな軽めの種目・ストレッチ中心にしぼります。" },
];

export const PAIN_REGIONS = [
  "首", "肩", "胸", "二の腕", "前腕", "背中", "腰",
  "腹部", "お尻", "太もも前", "太もも裏", "膝", "ふくらはぎ", "足首",
];

/** 痛い部位 -> 除外する種目カテゴリ */
export const PAIN_CATEGORY_MAP = {
  "首": ["首"],
  "肩": ["肩"],
  "胸": ["胸"],
  "二の腕": ["腕(力こぶ)", "腕(二の腕)"],
  "前腕": ["前腕", "前腕・手首"],
  "背中": ["背中", "背中・腰"],
  "腰": ["背中・腰"],
  "腹部": ["腹筋"],
  "お尻": ["脚(裏もも・お尻)", "股関節・お尻"],
  "太もも前": ["脚(前もも)"],
  "太もも裏": ["脚(裏もも・お尻)", "脚(裏もも)"],
  "膝": ["脚(前もも)", "脚(裏もも・お尻)", "脚(裏もも)"],
  "ふくらはぎ": ["ふくらはぎ"],
  "足首": ["足首"],
};

export function conditionByKey(key) {
  return CONDITIONS.find((c) => c.key === key) || CONDITIONS[1];
}

export function clampMinutes(value, fallback = 30) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
}

/** 1種目あたりの所要時間（分） */
export function estimateDurationMin(ex, setsOverride) {
  const sets = setsOverride != null ? setsOverride : (ex.default_sets || 1);
  let totalSec;
  if (ex.type === "stretch") {
    const perSetSec = ex.default_duration_sec || 30;
    totalSec = sets * perSetSec;
  } else {
    const perSetSec = ex.default_duration_sec != null
      ? ex.default_duration_sec
      : (ex.default_reps || 10) * SEC_PER_REP;
    totalSec = sets * (perSetSec + REST_SEC_STRENGTH);
  }
  return totalSec / 60;
}

/** METs × 体重 × 時間 */
export function calcCalories(ex, weightKg, setsOverride) {
  const durationMin = estimateDurationMin(ex, setsOverride);
  const hours = durationMin / 60;
  return Math.round(ex.mets * weightKg * hours * 10) / 10;
}

/** コンディションによるセット数調整（最低1セット） */
export function adjustedSets(ex, conditionKey) {
  const cond = conditionByKey(conditionKey);
  const base = ex.default_sets || 1;
  return Math.max(1, base + cond.setsDelta);
}

export function excludedCategoriesForPain(painRegions) {
  const excluded = new Set();
  painRegions.forEach((region) => {
    (PAIN_CATEGORY_MAP[region] || []).forEach((cat) => excluded.add(cat));
  });
  // 痛い部位がある日は負荷の高い全身種目も避ける
  if (painRegions.length > 0) excluded.add("全身");
  return excluded;
}

export function warningFor(ex, lastTrainedMap, yesterday) {
  if (ex.daily_ok) return "";
  if (lastTrainedMap[ex.id] === yesterday) return "昨日実施済み・回復を優先";
  return "";
}

/**
 * 設定（部位・目的・道具）・痛い部位・コンディションで候補を絞り込む。
 * 未選択の項目は絞り込みなし。
 */
export function filterExercises(exercises, opts) {
  const {
    strengthCategory = new Set(),
    stretchCategory = new Set(),
    purpose = new Set(),
    equipment = new Set(),
    painRegions = [],
    conditionKey = "normal",
  } = opts;

  const painExcluded = excludedCategoriesForPain(painRegions);
  const cond = conditionByKey(conditionKey);

  return exercises.filter((ex) => {
    if (ex.type === "strength" && strengthCategory.size > 0
        && !strengthCategory.has(ex.category)) return false;
    if (ex.type === "stretch" && stretchCategory.size > 0
        && !stretchCategory.has(ex.category)) return false;
    if (purpose.size > 0 && !ex.purpose.some((p) => purpose.has(p))) return false;
    if (equipment.size > 0 && !equipment.has(ex.equipment)) return false;
    if (painExcluded.has(ex.category)) return false;
    if (cond.lightOnly && !ex.daily_ok) return false;
    return true;
  });
}

/**
 * 設定時間に収まるようカテゴリ横断でバランスよく厳選する。
 * カテゴリごとに順番に1種目ずつ拾い、合計時間が上限を超えない限り続ける。
 */
export function curateForTime(list, minutes, conditionKey) {
  const byCategory = new Map();
  list.forEach((ex) => {
    if (!byCategory.has(ex.category)) byCategory.set(ex.category, []);
    byCategory.get(ex.category).push(ex);
  });
  const categories = Array.from(byCategory.keys());
  const cursors = new Map(categories.map((c) => [c, 0]));

  const picked = [];
  let totalMin = 0;
  let addedAny = true;

  while (addedAny) {
    addedAny = false;
    for (const cat of categories) {
      const arr = byCategory.get(cat);
      const idx = cursors.get(cat);
      if (idx >= arr.length) continue;
      const ex = arr[idx];
      cursors.set(cat, idx + 1);
      const sets = adjustedSets(ex, conditionKey);
      const durationMin = estimateDurationMin(ex, sets);
      if (totalMin + durationMin <= minutes) {
        picked.push({ ex, sets, durationMin });
        totalMin += durationMin;
        addedAny = true;
      }
    }
  }
  return { picked, totalMin };
}

export function uniqueCategoriesByType(exercises, type) {
  const seen = [];
  exercises.forEach((ex) => {
    if (ex.type === type && !seen.includes(ex.category)) seen.push(ex.category);
  });
  return seen;
}

export function uniqueEquipment(exercises) {
  const seen = [];
  exercises.forEach((ex) => {
    if (!seen.includes(ex.equipment)) seen.push(ex.equipment);
  });
  return seen;
}

/** 検索クエリを外部サイトで開く（旧 app.py の open_youtube / open_image_search） */
export function youtubeUrl(query) {
  return "https://www.youtube.com/results?search_query=" +
    encodeURIComponent(query);
}

export function imageSearchUrl(query) {
  return "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(query);
}
