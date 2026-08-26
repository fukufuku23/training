/**
 * ストレージ層 — フェーズ2で差し替わる唯一の場所。
 *
 * 呼び出し側はこのモジュールの外側インターフェースだけに依存する。
 * フェーズ2ではこのファイルの内部を Supabase 同期付きの実装に置き換えるが、
 * 関数シグネチャは変えないため app.js は無変更で済む。
 *
 * すべて非同期（Promise）にしてあるのはそのため。localStorage の同期APIで
 * 書くと、Supabase 接続時に全呼び出し箇所の書き換えが発生する。
 */

const DB_NAME = "training-log";
const DB_VERSION = 1;
const STORE_LOGS = "logs";   // key: 'YYYY-MM-DD'
const STORE_META = "meta";   // key: 'settings' など

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        db.createObjectStore(STORE_LOGS, { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function wrap(req) {
  return { __req: req };
}

/* ---------------- 日付ユーティリティ ---------------- */

export function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayKey() {
  return toDateKey(new Date());
}

export function shiftDate(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toDateKey(dt);
}

/* ---------------- 既定値 ---------------- */

export const DEFAULT_SETTINGS = {
  strength_categories: [],
  stretch_categories: [],
  purposes: [],
  equipment: [],
  default_minutes: 30,
};

export function emptyLog(date) {
  return {
    date,
    weight_kg: null,
    condition: "normal",
    pain_regions: [],
    minutes: null,
    rest: false,     // 「今日は休養日」と本人が宣言した日
    exercises: [],   // { id, name, calories, at }
    updated_at: null,
  };
}

/* ---------------- 公開インターフェース ---------------- */

export const storage = {
  async getSettings() {
    const row = await tx(STORE_META, "readonly", (s) => wrap(s.get("settings")));
    return { ...DEFAULT_SETTINGS, ...(row ? row.value : {}) };
  },

  async saveSettings(settings) {
    const value = { ...DEFAULT_SETTINGS, ...settings };
    await tx(STORE_META, "readwrite", (s) =>
      s.put({ key: "settings", value, updated_at: new Date().toISOString() })
    );
    return value;
  },

  async getLog(date) {
    const row = await tx(STORE_LOGS, "readonly", (s) => wrap(s.get(date)));
    return row || emptyLog(date);
  },

  /** from/to を含む範囲。存在しない日は返さない（詰めるのは呼び出し側） */
  async getLogs(fromDate, toDate) {
    const range = IDBKeyRange.bound(fromDate, toDate);
    const rows = await tx(STORE_LOGS, "readonly", (s) => wrap(s.getAll(range)));
    return rows || [];
  },

  async getAllLogs() {
    const rows = await tx(STORE_LOGS, "readonly", (s) => wrap(s.getAll()));
    return rows || [];
  },

  /** 既存レコードに patch をマージして保存 */
  async saveLog(date, patch) {
    const current = await this.getLog(date);
    const next = { ...current, ...patch, date, updated_at: new Date().toISOString() };
    await tx(STORE_LOGS, "readwrite", (s) => s.put(next));
    return next;
  },

  /** 種目を1件「実施済み」として追加。同一種目の重複は無視する */
  async addExercise(date, entry) {
    const log = await this.getLog(date);
    if (log.exercises.some((e) => e.id === entry.id)) return log;
    const next = {
      ...log,
      exercises: [...log.exercises, { ...entry, at: new Date().toISOString() }],
      updated_at: new Date().toISOString(),
    };
    await tx(STORE_LOGS, "readwrite", (s) => s.put(next));
    return next;
  },

  /** 休養日フラグの切り替え。実施記録がある日は休養日にできない */
  async setRest(date, isRest) {
    const log = await this.getLog(date);
    if (isRest && log.exercises && log.exercises.length > 0) return log;
    return this.saveLog(date, { rest: !!isRest });
  },

  async removeExercise(date, exerciseId) {
    const log = await this.getLog(date);
    const next = {
      ...log,
      exercises: log.exercises.filter((e) => e.id !== exerciseId),
      updated_at: new Date().toISOString(),
    };
    await tx(STORE_LOGS, "readwrite", (s) => s.put(next));
    return next;
  },

  /**
   * 継続日数。
   *
   * 「実施した日」だけでなく「休養日と宣言した日」も継続として数える。
   * 連続記録が途切れる恐怖で無理をさせない／体調が悪い日に休むことを
   * 否定しない、というこのアプリの方針をここで表現している。
   * 何も記録しなかった日だけが継続を切る。
   *
   * 今日まだ何もしていなければ昨日を起点に遡る（今日はこれからかもしれない）。
   */
  async getStreak(today = todayKey()) {
    const logs = await this.getAllLogs();
    const done = new Set(
      logs
        .filter((l) => (l.exercises && l.exercises.length > 0) || l.rest === true)
        .map((l) => l.date)
    );
    if (done.size === 0) return 0;
    let cursor = done.has(today) ? today : shiftDate(today, -1);
    let streak = 0;
    while (done.has(cursor)) {
      streak += 1;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  },

  /** 種目ID -> before より前の最終実施日（なければ null） */
  async getLastTrainedMap(before = todayKey()) {
    const logs = await this.getAllLogs();
    const map = {};
    logs
      .filter((l) => l.date < before)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .forEach((l) => {
        (l.exercises || []).forEach((e) => { map[e.id] = l.date; });
      });
    return map;
  },

  /** 直近 days 日分を日付で詰めて返す（グラフ用） */
  async getHistory(days = 30, today = todayKey()) {
    const from = shiftDate(today, -(days - 1));
    const rows = await this.getLogs(from, today);
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const key = shiftDate(from, i);
      const row = byDate.get(key);
      out.push({
        date: key,
        weight: row && row.weight_kg != null ? row.weight_kg : null,
        calories: row ? (row.exercises || []).reduce((s, e) => s + (e.calories || 0), 0) : 0,
        count: row ? (row.exercises || []).length : 0,
        rest: !!(row && row.rest),
        pain: !!(row && row.pain_regions && row.pain_regions.length > 0),
      });
    }
    return out;
  },

  async getTotalCalories(date) {
    const log = await this.getLog(date);
    return (log.exercises || []).reduce((s, e) => s + (e.calories || 0), 0);
  },

  /* ---------------- バックアップ ---------------- */

  async exportAll() {
    const [settings, logs] = await Promise.all([this.getSettings(), this.getAllLogs()]);
    return {
      format: "training-log-export",
      version: 1,
      exported_at: new Date().toISOString(),
      settings,
      logs: logs.sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
  },

  /** mode: 'merge'（既定・和集合） | 'replace' */
  async importAll(payload, mode = "merge") {
    if (!payload || payload.format !== "training-log-export") {
      throw new Error("対応していないファイル形式です");
    }
    if (payload.settings) await this.saveSettings(payload.settings);

    let imported = 0;
    for (const incoming of payload.logs || []) {
      if (!incoming.date) continue;
      if (mode === "replace") {
        await tx(STORE_LOGS, "readwrite", (s) => s.put(incoming));
        imported++;
        continue;
      }
      const current = await this.getLog(incoming.date);
      // 実施種目は和集合、スカラー値は updated_at の新しい方を採用
      const ids = new Set((current.exercises || []).map((e) => e.id));
      const mergedExercises = [
        ...(current.exercises || []),
        ...(incoming.exercises || []).filter((e) => !ids.has(e.id)),
      ];
      const incomingIsNewer =
        (incoming.updated_at || "") > (current.updated_at || "");
      const merged = {
        ...current,
        weight_kg: incomingIsNewer && incoming.weight_kg != null
          ? incoming.weight_kg : current.weight_kg,
        condition: incomingIsNewer && incoming.condition
          ? incoming.condition : current.condition,
        pain_regions: incomingIsNewer && incoming.pain_regions
          ? incoming.pain_regions : current.pain_regions,
        minutes: incomingIsNewer && incoming.minutes != null
          ? incoming.minutes : current.minutes,
        exercises: mergedExercises,
        date: incoming.date,
        updated_at: new Date().toISOString(),
      };
      await tx(STORE_LOGS, "readwrite", (s) => s.put(merged));
      imported++;
    }
    return imported;
  },

  async clearAll() {
    await tx(STORE_LOGS, "readwrite", (s) => s.clear());
    await tx(STORE_META, "readwrite", (s) => s.clear());
  },
};

/**
 * iOS Safari はしばらく操作のないサイトのストレージを削除する。
 * ホーム画面に追加された Web App は許可されやすい。
 */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* 対応していない環境は黙って無視 */ }
  return false;
}
