/**
 * 軽量チャート — 依存ライブラリなし、インラインSVGで描画。
 *
 * 体重＝折れ線（欠測日は線を切る）、消費カロリー＝縦棒。
 * 単一系列なので凡例は置かず、タイトルが系列名を兼ねる。
 * 2軸グラフは作らない（別々のチャートに分ける）。
 *
 * 色は data-viz の検証済みパレットから採用し、ライト/ダーク双方で
 * コントラスト・CVD 分離ともに検証済み。
 *   体重     : blue   #2a78d6 (light) / #3987e5 (dark)
 *   カロリー : orange #eb6834 (light) / #d95926 (dark)
 */

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  return node;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 目盛りをきりのよい数値に丸める */
function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step * 0.001; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return { ticks, min: start, max: end };
}

function fmtDateShort(key) {
  const [, m, d] = key.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function fmtDateFull(key) {
  const [y, m, d] = key.split("-");
  const wd = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(Number(y), Number(m) - 1, Number(d)).getDay()
  ];
  return `${Number(m)}月${Number(d)}日(${wd})`;
}

/* ---------------- 共通の描画土台 ---------------- */

function baseFrame(container, opts) {
  container.innerHTML = "";
  const width = Math.max(240, container.clientWidth || 320);
  const height = opts.height || (width < 480 ? 180 : 220);
  const pad = { top: 16, right: 18, bottom: 26, left: 40 };

  const svg = el("svg", {
    width, height, viewBox: `0 0 ${width} ${height}`,
    role: "img", "aria-label": opts.ariaLabel || "",
    class: "chart-svg",
  });
  container.appendChild(svg);

  const plot = {
    svg, width, height, pad,
    w: width - pad.left - pad.right,
    h: height - pad.top - pad.bottom,
  };
  return plot;
}

function drawGrid(plot, scaleY, ticks, colors, formatter) {
  const { svg, pad, w } = plot;
  ticks.forEach((t) => {
    const y = scaleY(t);
    svg.appendChild(el("line", {
      x1: pad.left, y1: y, x2: pad.left + w, y2: y,
      stroke: colors.grid, "stroke-width": 1, "shape-rendering": "crispEdges",
    }));
    const label = el("text", {
      x: pad.left - 8, y: y + 4, "text-anchor": "end",
      class: "chart-tick", fill: colors.muted,
    });
    label.textContent = formatter ? formatter(t) : String(t);
    svg.appendChild(label);
  });
}

function drawXLabels(plot, data, colors) {
  const { svg, pad, w, h } = plot;
  const n = data.length;
  if (n === 0) return;
  const step = Math.max(1, Math.ceil(n / (plot.width < 420 ? 4 : 7)));
  const bandW = w / n;
  for (let i = 0; i < n; i += step) {
    const x = pad.left + bandW * (i + 0.5);
    const label = el("text", {
      x, y: pad.top + h + 18, "text-anchor": "middle",
      class: "chart-tick", fill: colors.muted,
    });
    label.textContent = fmtDateShort(data[i].date);
    svg.appendChild(label);
  }
}

function makeTooltip(container) {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  container.appendChild(tip);
  return tip;
}

/** ホバー/タップ用の当たり判定レイヤー */
function attachHover(plot, container, data, onIndex) {
  const { svg, pad, w, h } = plot;
  const bandW = w / data.length;
  const overlay = el("rect", {
    x: pad.left, y: pad.top, width: w, height: h,
    fill: "transparent", style: "cursor:crosshair",
  });
  svg.appendChild(overlay);

  function handle(evt) {
    const rect = svg.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const localX = clientX - rect.left - pad.left;
    let idx = Math.floor(localX / bandW);
    idx = Math.max(0, Math.min(data.length - 1, idx));
    onIndex(idx, evt);
  }

  overlay.addEventListener("pointermove", handle);
  overlay.addEventListener("pointerdown", handle);
  overlay.addEventListener("pointerleave", () => onIndex(null));
  container.addEventListener("pointerleave", () => onIndex(null));
}

function palette() {
  return {
    weight: cssVar("--viz-weight", "#2a78d6"),
    calories: cssVar("--viz-calories", "#eb6834"),
    grid: cssVar("--viz-grid", "#E4E8EF"),
    muted: cssVar("--ink-muted", "#6B7280"),
    surface: cssVar("--surface", "#FFFFFF"),
    ink: cssVar("--ink", "#1B1D29"),
  };
}

function emptyState(container, message) {
  container.innerHTML = `<p class="chart-empty">${message}</p>`;
}

/* ---------------- 体重：折れ線 ---------------- */

export function renderWeightChart(container, data) {
  const points = data.filter((d) => d.weight != null);
  if (points.length === 0) {
    emptyState(container, "体重の記録がまだありません");
    return;
  }

  const colors = palette();
  const plot = baseFrame(container, { ariaLabel: "体重の推移" });
  const { svg, pad, w, h } = plot;

  const values = points.map((d) => d.weight);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const margin = Math.max(0.5, (rawMax - rawMin) * 0.25);
  const { ticks, min, max } = niceTicks(rawMin - margin, rawMax + margin, 4);

  const bandW = w / data.length;
  const scaleX = (i) => pad.left + bandW * (i + 0.5);
  const scaleY = (v) => pad.top + h - ((v - min) / (max - min)) * h;

  drawGrid(plot, scaleY, ticks, colors, (t) => `${t}`);
  drawXLabels(plot, data, colors);

  // 欠測日で線を切る（存在しない値を勝手に補間しない）
  let d = "";
  let penDown = false;
  data.forEach((row, i) => {
    if (row.weight == null) { penDown = false; return; }
    d += `${penDown ? "L" : "M"}${scaleX(i)} ${scaleY(row.weight)} `;
    penDown = true;
  });
  svg.appendChild(el("path", {
    d: d.trim(), fill: "none", stroke: colors.weight,
    "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
  }));

  // 終端マーカー（サーフェス色の2pxリング付き）
  const lastIdx = data.reduce((acc, r, i) => (r.weight != null ? i : acc), -1);
  if (lastIdx >= 0) {
    const cx = scaleX(lastIdx);
    const cy = scaleY(data[lastIdx].weight);
    svg.appendChild(el("circle", {
      cx, cy, r: 5, fill: colors.weight,
      stroke: colors.surface, "stroke-width": 2,
    }));
    // 直接ラベルは終端のみ（全点には付けない）
    const label = el("text", {
      x: cx - 8, y: cy - 10, "text-anchor": "end",
      class: "chart-endlabel", fill: colors.ink,
    });
    label.textContent = `${data[lastIdx].weight}kg`;
    svg.appendChild(label);
  }

  // ホバー：クロスヘア＋ツールチップ
  const tip = makeTooltip(container);
  const cross = el("line", {
    y1: pad.top, y2: pad.top + h, stroke: colors.muted,
    "stroke-width": 1, opacity: 0,
  });
  svg.appendChild(cross);
  const focus = el("circle", {
    r: 5, fill: colors.weight, stroke: colors.surface,
    "stroke-width": 2, opacity: 0,
  });
  svg.appendChild(focus);

  attachHover(plot, container, data, (idx) => {
    if (idx == null) {
      cross.setAttribute("opacity", 0);
      focus.setAttribute("opacity", 0);
      tip.hidden = true;
      return;
    }
    const row = data[idx];
    const x = scaleX(idx);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("opacity", 0.35);
    if (row.weight != null) {
      focus.setAttribute("cx", x);
      focus.setAttribute("cy", scaleY(row.weight));
      focus.setAttribute("opacity", 1);
    } else {
      focus.setAttribute("opacity", 0);
    }
    tip.hidden = false;
    tip.innerHTML =
      `<strong>${fmtDateFull(row.date)}</strong>` +
      `<span>${row.weight != null ? `${row.weight} kg` : "体重の記録なし"}</span>`;
    const left = Math.min(Math.max(x - 60, 4), plot.width - 124);
    tip.style.left = `${left}px`;
    tip.style.top = `${pad.top}px`;
  });
}

/* ---------------- 消費カロリー：縦棒 ---------------- */

export function renderCaloriesChart(container, data) {
  const total = data.reduce((s, d) => s + (d.calories || 0), 0);
  if (total === 0) {
    emptyState(container, "消費カロリーの記録がまだありません");
    return;
  }

  const colors = palette();
  const plot = baseFrame(container, { ariaLabel: "消費カロリーの推移" });
  const { svg, pad, w, h } = plot;

  const rawMax = Math.max(...data.map((d) => d.calories || 0));
  const { ticks, min, max } = niceTicks(0, rawMax * 1.1, 4);

  const bandW = w / data.length;
  const scaleY = (v) => pad.top + h - ((v - min) / (max - min)) * h;

  drawGrid(plot, scaleY, ticks, colors, (t) => `${Math.round(t)}`);
  drawXLabels(plot, data, colors);

  // 棒は最大24px、隣接棒のあいだにサーフェス色の2pxギャップ
  const barW = Math.max(1, Math.min(24, bandW - 2));

  data.forEach((row, i) => {
    const v = row.calories || 0;
    if (v <= 0) return;
    const x = pad.left + bandW * (i + 0.5) - barW / 2;
    const y = scaleY(v);
    const barH = pad.top + h - y;
    // 上端のみ角丸、ベースライン側は直角
    const r = Math.min(4, barW / 2, barH);
    const path =
      `M${x} ${y + barH} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} ` +
      `L${x + barW - r} ${y} Q${x + barW} ${y} ${x + barW} ${y + r} ` +
      `L${x + barW} ${y + barH} Z`;
    svg.appendChild(el("path", { d: path, fill: colors.calories }));
  });

  // ベースライン
  svg.appendChild(el("line", {
    x1: pad.left, y1: pad.top + h, x2: pad.left + w, y2: pad.top + h,
    stroke: colors.grid, "stroke-width": 1, "shape-rendering": "crispEdges",
  }));

  const tip = makeTooltip(container);
  const highlight = el("rect", {
    fill: colors.ink, opacity: 0, width: bandW, y: pad.top, height: h,
  });
  svg.insertBefore(highlight, svg.firstChild);

  attachHover(plot, container, data, (idx) => {
    if (idx == null) {
      highlight.setAttribute("opacity", 0);
      tip.hidden = true;
      return;
    }
    const row = data[idx];
    highlight.setAttribute("x", pad.left + bandW * idx);
    highlight.setAttribute("opacity", 0.06);
    tip.hidden = false;
    tip.innerHTML =
      `<strong>${fmtDateFull(row.date)}</strong>` +
      `<span>${Math.round(row.calories)} kcal ・ ${row.count}種目</span>`;
    const x = pad.left + bandW * (idx + 0.5);
    const left = Math.min(Math.max(x - 60, 4), plot.width - 124);
    tip.style.left = `${left}px`;
    tip.style.top = `${pad.top}px`;
  });
}
