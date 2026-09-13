/**
 * セッション進行ロジック。DOM には触らない（テストできるようにするため）。
 *
 * 設計上の要点:
 *  1. 時間は「締切」で持つ。経過時間を足し込んでいくと、音声合成の待ちや
 *     タブの非アクティブ化でずれが累積する。各ステップの開始時に終了時刻を
 *     決め、読み上げの時刻もそこから逆算する。
 *  2. 自動で進むのは時間が決まっているものだけ。回数ベースの種目は
 *     終わる時刻を機械が知らないので、必ずタップで進める。
 *  3. 一時停止は締切そのものをずらす。止めている間の時間は無かったことにする。
 */

import { REST_SEC_STRENGTH } from "./domain.js?v=20260913160215";

/** その種目が時間で終わるか（＝自動で進めてよいか） */
export function isTimed(ex) {
  return ex.default_duration_sec != null;
}

/** 1セットあたりの秒数。回数ベースは目安（自動進行には使わない） */
export function workSeconds(ex) {
  if (isTimed(ex)) return ex.default_duration_sec;
  return (ex.default_reps || 10) * 3;
}

/**
 * 実施メニューを、進行できるステップ列に展開する。
 *
 * ステップの種類:
 *   phase    段の切り替え（ウォームアップ／筋トレ／ストレッチ）
 *   announce 次の種目の予告
 *   work     実施。timed は自動で進み、manual はタップ待ち
 *   rest     セット間の休憩（筋トレのみ。ストレッチは連続で行う）
 */
export function buildSteps(flat) {
  const steps = [];
  let lastPhase = null;

  flat.forEach((item) => {
    const ex = item.ex;
    const sets = item.sets;
    const timed = isTimed(ex);

    if (item.phaseKey !== lastPhase) {
      lastPhase = item.phaseKey;
      // 段の切り替えは一瞬で流れると読めないし、読み上げも間に合わない
      steps.push({ kind: "phase", phaseKey: item.phaseKey,
                   phaseLabel: item.phaseLabel, seconds: 3 });
    }

    steps.push({ kind: "announce", ex, sets, item, seconds: 4 });

    for (let s = 1; s <= sets; s++) {
      steps.push({
        kind: "work", ex, item, setNo: s, sets,
        mode: timed ? "timed" : "manual",
        seconds: timed ? ex.default_duration_sec : null,
        reps: timed ? null : (ex.default_reps || 10),
        // 最後のセットが終わった時点でその種目は完了
        completesExercise: s === sets,
      });
      // ストレッチは休憩を挟まず続ける。筋トレは最終セットの後に休憩を入れない
      if (!(ex.type === "stretch") && s < sets) {
        steps.push({ kind: "rest", ex, item, setNo: s, sets, seconds: REST_SEC_STRENGTH });
      }
    }
  });

  return steps;
}

/** 表示用の合計見込み時間（秒）。manual は目安値で数える */
export function estimateTotalSec(steps) {
  return steps.reduce((sum, st) => {
    if (st.kind === "work" && st.mode === "manual") return sum + workSeconds(st.ex);
    return sum + (st.seconds || 0);
  }, 0);
}

/** カウントダウンなど、事前に音声を作っておきたい語 */
export const PREFETCH_PHRASES = [
  "3", "2", "1", "残り10秒", "スタート", "休憩", "はい、交代",
  "お疲れさまでした", "次で最後です",
];

/**
 * 読み上げの予定を、そのステップの終了時刻から逆算して作る。
 * 「開始から何秒後」ではなく「終了の何秒前」で持つのがポイント。
 */
function cuesFor(step, endAt, now) {
  const cues = [];
  const sec = step.seconds || 0;
  if (step.kind === "work" && step.mode === "timed") {
    if (sec >= 25) cues.push({ at: endAt - 10000, text: "残り10秒" });
    if (sec >= 8) {
      cues.push({ at: endAt - 3000, text: "3" });
      cues.push({ at: endAt - 2000, text: "2" });
      cues.push({ at: endAt - 1000, text: "1" });
    }
  } else if (step.kind === "rest") {
    if (sec >= 20) cues.push({ at: endAt - 10000, text: "残り10秒" });
    cues.push({ at: endAt - 3000, text: "3" });
    cues.push({ at: endAt - 2000, text: "2" });
    cues.push({ at: endAt - 1000, text: "1" });
  }
  return cues.filter((c) => c.at > now + 200);
}

/** そのステップに入ったときに話す言葉。短い機能語に寄せる */
function openingLine(step) {
  switch (step.kind) {
    case "phase":
      return step.phaseLabel;
    case "announce": {
      const ex = step.ex;
      const amount = isTimed(ex)
        ? `${ex.default_duration_sec}秒`
        : `${ex.default_reps || 10}回`;
      return step.sets > 1
        ? `次は${ex.name}。${amount}を${step.sets}セット`
        : `次は${ex.name}。${amount}`;
    }
    case "work":
      if (step.mode === "timed") return step.setNo === 1 ? "スタート" : `${step.setNo}セット目`;
      return step.setNo === 1
        ? "どうぞ。終わったらタップしてください"
        : `${step.setNo}セット目`;
    case "rest":
      return "休憩";
    default:
      return "";
  }
}

export class SessionRunner {
  /**
   * @param {object} o
   * @param {Array}  o.steps
   * @param {object} o.voice   voice.js の voice
   * @param {object} o.on      { step, tick, exerciseDone, finish, state }
   * @param {function} o.now   時刻取得（テストで差し替える）
   */
  constructor({ steps, voice, on = {}, now = () => Date.now() }) {
    this.steps = steps;
    this.voice = voice;
    this.on = on;
    this.now = now;
    this.i = -1;
    this.endAt = null;
    this.cues = [];
    this.paused = false;
    this.pausedAt = null;
    this.finished = false;
    this.timer = null;
  }

  get current() { return this.i >= 0 ? this.steps[this.i] : null; }

  get remainingMs() {
    if (this.endAt == null) return null;
    const base = this.paused ? this.pausedAt : this.now();
    return Math.max(0, this.endAt - base);
  }

  start() {
    this.finished = false;
    this.i = -1;
    this.advance();
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.voice) this.voice.stop();
  }

  pause() {
    if (this.paused || this.finished) return;
    this.paused = true;
    this.pausedAt = this.now();
    if (this.voice) this.voice.stop();
    this.emitState();
  }

  resume() {
    if (!this.paused) return;
    // 止めていた分だけ締切を後ろへずらす。読み上げの予定も同じだけずらす
    const delta = this.now() - this.pausedAt;
    if (this.endAt != null) this.endAt += delta;
    this.cues.forEach((c) => { c.at += delta; });
    this.paused = false;
    this.pausedAt = null;
    if (this.voice) this.voice.resume();
    this.emitState();
  }

  /** 回数ベースの「終わった」タップ、および手動スキップ */
  advanceManually() {
    if (this.finished) return;
    if (this.voice) { this.voice.stop(); this.voice.resume(); }
    this.completeCurrent();
    this.advance();
  }

  /** ひとつ前の種目の頭に戻る */
  back() {
    if (this.finished) return;
    let j = this.i - 1;
    while (j > 0 && this.steps[j].kind !== "announce") j--;
    this.i = Math.max(-1, j - 1);
    if (this.voice) { this.voice.stop(); this.voice.resume(); }
    this.advance();
  }

  /** 今の種目を飛ばして次の種目へ */
  skipExercise() {
    if (this.finished) return;
    let j = this.i + 1;
    while (j < this.steps.length
           && this.steps[j].kind !== "announce" && this.steps[j].kind !== "phase") j++;
    this.i = j - 1;
    if (this.voice) { this.voice.stop(); this.voice.resume(); }
    this.advance();
  }

  completeCurrent() {
    const st = this.current;
    if (st && st.kind === "work" && st.completesExercise && this.on.exerciseDone) {
      this.on.exerciseDone(st.item);
    }
  }

  advance() {
    this.i += 1;
    if (this.i >= this.steps.length) return this.finish();

    const st = this.steps[this.i];
    const line = openingLine(st);

    if (st.kind === "work" && st.mode === "manual") {
      // 機械には終わる時刻が分からない。タップされるまで待つ
      this.endAt = null;
      this.cues = [];
    } else {
      const sec = st.seconds || 0;
      const t = this.now();
      this.endAt = t + sec * 1000;
      this.cues = cuesFor(st, this.endAt, t);
    }

    if (this.voice && line) this.voice.say(line);
    if (this.on.step) this.on.step(st, this.i, this.steps.length);
    this.emitState();
  }

  tick() {
    if (this.paused || this.finished) return;
    const now = this.now();

    for (const c of this.cues) {
      if (!c.spoken && now >= c.at) {
        c.spoken = true;
        if (this.voice) this.voice.say(c.text, { rate: 1.15 });
      }
    }

    if (this.endAt != null && now >= this.endAt) {
      this.completeCurrent();
      this.advance();
      return;
    }
    if (this.on.tick) this.on.tick(this.remainingMs, this.current);
  }

  finish() {
    this.finished = true;
    this.endAt = null;
    this.stop();
    if (this.voice) { this.voice.resume(); this.voice.say("お疲れさまでした"); }
    if (this.on.finish) this.on.finish();
    this.emitState();
  }

  emitState() {
    if (this.on.state) {
      this.on.state({
        index: this.i, total: this.steps.length,
        paused: this.paused, finished: this.finished,
        step: this.current, remainingMs: this.remainingMs,
      });
    }
  }
}
