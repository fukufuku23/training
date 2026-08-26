/**
 * 種目サムネイルの線画。
 *
 * 196種目分のイラストは用意できないので、部位グループごとに
 * 代表的な動作の棒人間を1つずつ描いて使い回す。
 * 写真やアイコンフォントに頼らず、依存ゼロ・オフライン動作・
 * ダークモード追従（currentColor）を満たす。
 */

const NS = "http://www.w3.org/2000/svg";

/* 各グループの代表動作。head は塗り、それ以外は線 */
const POSES = {
  // 腕立て伏せ
  "胸": {
    head: [11, 23, 3.4],
    lines: ["M14.4 24.4 L34 28.5", "M17 25 L17 37", "M34 28.5 L43 35", "M6 39 H44"],
  },
  // ローイング（前傾して引く）
  "背中": {
    head: [14, 13, 3.4],
    lines: ["M16.6 15.4 L27 27", "M17.6 18 L25.5 14", "M27 27 L23 40", "M27 27 L33 40"],
  },
  // スクワット
  "脚": {
    head: [24, 10, 3.4],
    lines: ["M24 13.6 V26", "M24 18 H35", "M24 26 L16 30", "M16 30 L18 40",
            "M24 26 L32 30", "M32 30 L30 40"],
  },
  // ショルダープレス（頭上へ）
  "肩・首": {
    head: [24, 12, 3.4],
    lines: ["M24 15.6 V30", "M24 19 L16.5 10", "M24 19 L31.5 10",
            "M24 30 L20 41", "M24 30 L28 41"],
  },
  // アームカール
  "腕": {
    head: [24, 11, 3.4],
    lines: ["M24 14.6 V29", "M24 18 L21 26", "M21 26 L30 21", "M24 18 L18 28",
            "M24 29 L21 41", "M24 29 L27 41"],
  },
  // プランク
  "体幹": {
    head: [11, 24, 3.4],
    lines: ["M14.4 25.6 L36 30", "M15 27 V34", "M15 34 H22", "M36 30 L43 36", "M6 38 H44"],
  },
  // ジャンプ（全身）
  "全身": {
    head: [24, 10, 3.4],
    lines: ["M24 13.6 V26", "M24 17 L14.5 9", "M24 17 L33.5 9",
            "M24 26 L16 38", "M24 26 L32 38"],
  },
};

/**
 * 部位グループの線画を返す。未知のグループは「全身」にフォールバックする。
 * 色は currentColor なので、置き場所のCSSで制御できる。
 */
export function poseArt(group) {
  const pose = POSES[group] || POSES["全身"];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "pose");

  const [cx, cy, r] = pose.head;
  const head = document.createElementNS(NS, "circle");
  head.setAttribute("cx", cx);
  head.setAttribute("cy", cy);
  head.setAttribute("r", r);
  head.setAttribute("class", "pose__head");
  svg.appendChild(head);

  pose.lines.forEach((d) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("class", "pose__line");
    svg.appendChild(p);
  });

  return svg;
}

/**
 * 「鍛えた部位」用のミニ人体図。
 * 実施した部位グループを塗って、偏りをひと目で見せる。
 *
 * 正面向きの1体しか描かないので「胸」と「背中」は同じ上半身を塗る。
 * 厳密な区別は隣のタグ一覧が担い、この図はあくまで俯瞰用。
 */
function rect(x, y, w, h, r, cls) {
  const e = document.createElementNS(NS, "rect");
  e.setAttribute("x", x); e.setAttribute("y", y);
  e.setAttribute("width", w); e.setAttribute("height", h);
  e.setAttribute("rx", r); e.setAttribute("class", cls);
  return e;
}
function circle(cx, cy, r, cls) {
  const e = document.createElementNS(NS, "circle");
  e.setAttribute("cx", cx); e.setAttribute("cy", cy);
  e.setAttribute("r", r); e.setAttribute("class", cls);
  return e;
}

/** 体のパーツ定義（描画順） */
const BODY_SHAPES = [
  { id: "head",  make: (c) => circle(22, 6.5, 5, c) },
  { id: "torsoU", make: (c) => rect(14, 13, 16, 13, 4, c) },
  { id: "torsoL", make: (c) => rect(14.5, 26.5, 15, 13, 4, c) },
  { id: "armL",  make: (c) => rect(5, 14, 7, 21, 3.5, c) },
  { id: "armR",  make: (c) => rect(32, 14, 7, 21, 3.5, c) },
  { id: "legL",  make: (c) => rect(14.5, 41, 6.5, 24, 3.2, c) },
  { id: "legR",  make: (c) => rect(23, 41, 6.5, 24, 3.2, c) },
];

/** 部位グループ -> 塗るパーツ */
const GROUP_SHAPES = {
  "肩・首":  ["head"],
  "胸":     ["torsoU"],
  "背中":   ["torsoU"],
  "腕":     ["armL", "armR"],
  "体幹":   ["torsoL"],
  "脚":     ["legL", "legR"],
  "全身":   ["head", "torsoU", "torsoL", "armL", "armR", "legL", "legR"],
};

/** activeGroups: Set<string> — 実施した部位グループ */
export function bodyMap(activeGroups) {
  const on = new Set();
  (activeGroups || new Set()).forEach((g) => {
    (GROUP_SHAPES[g] || []).forEach((s) => on.add(s));
  });

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 44 68");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "bodymap");

  BODY_SHAPES.forEach((s) => {
    svg.appendChild(s.make(on.has(s.id) ? "bodymap__on" : "bodymap__base"));
  });
  return svg;
}

/** 継続日数を囲む月桂樹の片側（左右で反転して使う） */
export function laurel() {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 44");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "laurel");
  [
    "M15 41C7 36 4 27 6 17c0 0 1 6 4 10",
    "M9 33c-3-1-4-3-4-6 2 0 4 2 5 5",
    "M8 26c-3-1-4-3-4-6 2 0 4 2 5 5",
    "M9 19c-2-2-3-4-2-7 2 1 3 3 3 6",
  ].forEach((d) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  });
  return svg;
}
