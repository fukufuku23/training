/**
 * ドメインロジック — 既存 www/script.js から移植した純粋関数群。
 * DOM にもストレージにも依存しないので、そのままテストできる。
 */

export const REST_SEC_STRENGTH = 45;
export const SEC_PER_REP = 3;
export const MIN_MINUTES = 10;
/** 種目の切り替え・準備にかかる実時間。合計時間の見積もりに含める */
export const TRANSITION_MIN = 0.5;
/**
 * 1回のメニューに入れる種目数の上限。
 * 固定値にすると、短い日は多すぎ・長い日は時間が余る。時間に比例させる。
 * 多すぎると「迷わず始める」が壊れるので上限16で頭打ちにする。
 */
export function maxPicksFor(minutes) {
  return Math.min(16, Math.max(4, Math.round(minutes / 3.5)));
}
export const MAX_MINUTES = 120;

export const PURPOSES = ["筋肥大", "筋力向上", "引き締め", "柔軟性向上"];

/**
 * 体力レベル（負荷の目安）。
 * 種目側の level と突き合わせて、こなせない種目を最初から出さないようにする。
 * 「できない種目が並ぶ」のは続かない一番の理由なので、ここは強めに効かせる。
 */
export const STRENGTH_LEVELS = [
  { key: 1, label: "かなりやさしい", note: "壁や椅子を使う。運動から離れていた人向け" },
  { key: 2, label: "やさしい", note: "膝つき腕立てなど。自重の入り口" },
  { key: 3, label: "標準", note: "通常の腕立て・スクワットができる" },
  { key: 4, label: "強い", note: "片脚・足上げなど、体重以上の負荷を扱える" },
  { key: 5, label: "かなり強い", note: "片手や跳ぶ種目に挑める" },
];

export const DEFAULT_LEVEL = 3;

export function clampLevel(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return DEFAULT_LEVEL;
  return Math.min(5, Math.max(1, n));
}

/**
 * そのレベルの人に出してよい種目の範囲。
 *
 * 自分のレベルだけに絞ると種目が偏るので、ひとつ下も混ぜる。
 * レベル5は該当種目が少ないため、ふたつ下まで広げる。
 */
export function levelRange(userLevel) {
  const lv = clampLevel(userLevel);
  const lo = lv >= 5 ? lv - 2 : lv - 1;
  return [Math.max(1, lo), lv];
}

export const CONDITIONS = [
  { key: "good", label: "絶好調", face: "◕‿◕", setsDelta: 1, lightOnly: false,
    note: "いつもより少し多めの負荷にします。" },
  { key: "normal", label: "普通", face: "•‿•", setsDelta: 0, lightOnly: false,
    note: "通常メニューです。" },
  { key: "tired", label: "やや疲れ", face: "•︵•", setsDelta: -1, lightOnly: false,
    note: "セット数を少し減らして負荷を下げます。" },
  { key: "exhausted", label: "お疲れ", face: "×︵×", setsDelta: -2, lightOnly: true,
    note: "毎日OKな軽めの種目・ストレッチ中心にしぼります。" },
];

/** 時間選択の候補（数値入力よりチップのほうが片手で選びやすい） */
export const TIME_PRESETS = [10, 15, 20, 30, 45, 60];

/**
 * 部位バランス用のグループ分け。
 * 種目カテゴリは細かいので、振り返るときに意味のある粒度へ丸める。
 */
export const REGION_GROUPS = ["胸", "背中", "脚", "肩・首", "腕", "体幹", "全身"];

export function regionGroupOf(category) {
  const c = String(category || "");
  if (c.includes("全身")) return "全身";
  if (c.includes("胸")) return "胸";
  if (c.includes("背中")) return "背中";
  if (c.includes("腹")) return "体幹";
  if (c.includes("腕")) return "腕";
  if (c.includes("肩") || c.includes("首")) return "肩・首";
  if (c.includes("脚") || c.includes("もも") || c.includes("ふくらはぎ")
      || c.includes("股関節") || c.includes("お尻") || c.includes("足首")) return "脚";
  return "全身";
}

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

/**
 * 厳選結果を「ウォームアップ → 筋トレ → ストレッチ」の3段構成に組み直す。
 *
 * 単なる見た目の演出ではない。カテゴリを巡回して拾っただけの並びは順序が
 * 意味を持たないが、実際のトレーニングは
 *   軽いストレッチで温める → 主要な筋トレ → 静的ストレッチで整える
 * という流れが正しい。並びに意味を持たせることで、
 * 利用者は「何をどの順でやるか」を考えなくてよくなる。
 */
export const PHASE_META = {
  warmup:   { label: "ウォームアップ", note: "体を温めます" },
  strength: { label: "筋トレ",         note: "今日のメイン" },
  cooldown: { label: "ストレッチ",     note: "疲れを残しません" },
};

const WARMUP_MAX = 2;

export function buildSession(picked) {
  const strength = picked.filter((p) => p.ex.type === "strength");
  const stretch = picked.filter((p) => p.ex.type === "stretch");

  // 筋トレが無い日はストレッチだけの1段構成にする
  if (strength.length === 0) {
    if (stretch.length === 0) return [];
    return [makePhase("cooldown", stretch)];
  }
  // ストレッチが無い日は筋トレだけ
  if (stretch.length === 0) return [makePhase("strength", strength)];

  const warmupCount = Math.min(WARMUP_MAX, Math.max(1, Math.floor(stretch.length / 3)));
  const warmup = stretch.slice(0, warmupCount);
  const cooldown = stretch.slice(warmupCount);

  const phases = [makePhase("warmup", warmup), makePhase("strength", strength)];
  if (cooldown.length > 0) phases.push(makePhase("cooldown", cooldown));
  return phases;
}

function makePhase(key, items) {
  return {
    key,
    label: PHASE_META[key].label,
    note: PHASE_META[key].note,
    items,
    count: items.length,
    minutes: Math.max(1, Math.round(items.reduce((s, p) => s + p.durationMin, 0))),
  };
}

/** セッションを、通し番号付きの平坦な並びに展開する */
export function flattenSession(phases) {
  const out = [];
  let n = 0;
  phases.forEach((ph) => {
    ph.items.forEach((item) => {
      n += 1;
      out.push({ ...item, phaseKey: ph.key, phaseLabel: ph.label, index: n });
    });
  });
  return out;
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

export function filterExercises(exercises, opts) {
  const {
    strengthCategory = new Set(),
    stretchCategory = new Set(),
    purpose = new Set(),
    equipment = new Set(),
    painRegions = [],
    conditionKey = "normal",
    strengthLevel = DEFAULT_LEVEL,
  } = opts;

  const painExcluded = excludedCategoriesForPain(painRegions);
  const cond = conditionByKey(conditionKey);
  const [loLv, hiLv] = levelRange(strengthLevel);

  return exercises.filter((ex) => {
    // 負荷レベル。筋トレは範囲で絞り、ストレッチは柔らかく上限だけ見る
    // （ストレッチは筋力ではなく可動域の話なので、下限で切ると無意味に減る）
    const lv = ex.level || 3;
    if (ex.type === "stretch") {
      if (lv > hiLv + 1) return false;
    } else if (lv < loLv || lv > hiLv) {
      return false;
    }
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
 *
 * 設計上の要点が3つある。
 *  1. 筋トレとストレッチのカテゴリを交互に並べる。
 *     単純にカテゴリ順で回すと、1種目5分の筋トレが先に時間を使い切って
 *     ストレッチが1つも入らない（＝コースが1ステップになる）
 *  2. 種目の切り替え時間（TRANSITION_MIN）を見積もりに含める。
 *     含めないとストレッチが極端に安く見え、何十種目も詰め込まれる
 *  3. 種目数の上限を時間に比例させる。固定値だと短い日は多すぎ、長い日は余る
 */
export function curateForTime(list, minutes, conditionKey) {
  const byCategory = new Map();
  list.forEach((ex) => {
    if (!byCategory.has(ex.category)) byCategory.set(ex.category, []);
    byCategory.get(ex.category).push(ex);
  });

  // 筋トレ系とストレッチ系のカテゴリを交互に並べ替える
  const strengthCats = [];
  const stretchCats = [];
  for (const [cat, arr] of byCategory) {
    (arr[0].type === "stretch" ? stretchCats : strengthCats).push(cat);
  }
  const categories = [];
  for (let i = 0; i < Math.max(strengthCats.length, stretchCats.length); i++) {
    if (i < strengthCats.length) categories.push(strengthCats[i]);
    if (i < stretchCats.length) categories.push(stretchCats[i]);
  }

  const cursors = new Map(categories.map((c) => [c, 0]));
  const maxPicks = maxPicksFor(minutes);
  const picked = [];
  let totalMin = 0;
  let addedAny = true;

  while (addedAny && picked.length < maxPicks) {
    addedAny = false;
    for (const cat of categories) {
      if (picked.length >= maxPicks) break;
      const arr = byCategory.get(cat);
      const idx = cursors.get(cat);
      if (idx >= arr.length) continue;
      const ex = arr[idx];
      cursors.set(cat, idx + 1);
      const sets = adjustedSets(ex, conditionKey);
      const durationMin = estimateDurationMin(ex, sets);
      const slotMin = durationMin + TRANSITION_MIN;
      if (totalMin + slotMin <= minutes) {
        picked.push({ ex, sets, durationMin });
        totalMin += slotMin;
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
