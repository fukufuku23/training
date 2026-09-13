/**
 * 音声ガイドの画面。
 *
 * session.js（進行ロジック）と voice.js（音声）を画面につなぐだけの層。
 * 判断はここではしない。ここにあるのは「何をどう見せるか」だけ。
 */

import { voice } from "./voice.js?v=20260913160555";
import { buildSteps, SessionRunner, estimateTotalSec, isTimed } from "./session.js?v=20260913160555";
import { poseArt } from "./art.js?v=20260913160555";
import { regionGroupOf, PHASE_META } from "./domain.js?v=20260913160555";

const $ = (id) => document.getElementById(id);

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : String(s);
}

/** その種目の「量」の表記 */
function amountOf(ex) {
  return isTimed(ex) ? `${ex.default_duration_sec}秒` : `${ex.default_reps || 10}回`;
}

export class Guide {
  constructor({ onExerciseDone, onClose, settings }) {
    this.onExerciseDone = onExerciseDone;
    this.onClose = onClose;
    this.settings = settings || {};
    this.runner = null;
    this.wired = false;
  }

  get el() { return $("session"); }

  /** @param {Array} flat 未実施の種目だけを渡すこと */
  async open(flat) {
    if (!flat || flat.length === 0) return false;

    const steps = buildSteps(flat);
    this.wire();
    this.el.hidden = false;
    document.body.classList.add("is-session");

    voice.enabled = this.settings.voice_enabled !== false;
    this.renderVoiceState("音声を準備しています…");

    // 音声の解禁はユーザー操作（はじめる）の流れの中で行う必要がある
    await voice.unlock();
    // 何が使えるかは環境次第。居なければ黙ってブラウザ標準になる
    await voice.init({ preferVoicevox: true });
    this.renderVoiceState();
    // カウントダウンは「その瞬間」に鳴らないと意味がない。先に作っておく
    voice.prefetch(["3", "2", "1", "残り10秒", "スタート", "休憩"]);

    this.runner = new SessionRunner({
      steps,
      voice,
      on: {
        step: (st) => this.renderStep(st),
        tick: () => this.renderTime(),
        exerciseDone: (item) => this.onExerciseDone(item),
        finish: () => this.renderFinished(),
        state: () => this.renderControls(),
      },
    });

    const est = Math.round(estimateTotalSec(steps) / 60);
    $("session-count").textContent = `全${flat.length}種目・約${est}分`;
    this.acquireWakeLock();
    this.runner.start();
    return true;
  }

  close() {
    this.releaseWakeLock();
    if (this.runner) { this.runner.stop(); this.runner = null; }
    voice.stop();
    this.el.hidden = true;
    document.body.classList.remove("is-session");
    if (this.onClose) this.onClose();
  }

  wire() {
    if (this.wired) return;
    this.wired = true;

    $("session-close").addEventListener("click", () => this.close());
    $("session-back").addEventListener("click", () => this.runner && this.runner.back());
    $("session-skip").addEventListener("click", () => this.runner && this.runner.skipExercise());

    $("session-main").addEventListener("click", () => {
      const r = this.runner;
      if (!r) return;
      if (r.finished) return this.close();
      const st = r.current;
      if (st && st.kind === "work" && st.mode === "manual") r.advanceManually();
      else if (r.paused) r.resume();
      else r.pause();
    });

    $("session-mute").addEventListener("click", () => {
      voice.enabled = !voice.enabled;
      if (!voice.enabled) voice.stop(); else voice.resume();
      this.settings.voice_enabled = voice.enabled;
      this.renderVoiceState();
      document.dispatchEvent(new CustomEvent("voice-pref-changed",
        { detail: { enabled: voice.enabled } }));
    });

    // 画面が消えると進行が止まるので、見ている間は点灯を維持する
    this.wakeLock = null;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.el.hidden) this.acquireWakeLock();
    });
  }

  async acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try { this.wakeLock = await navigator.wakeLock.request("screen"); }
    catch (_) { /* 取れなくても進行はできる */ }
  }

  releaseWakeLock() {
    if (this.wakeLock) { try { this.wakeLock.release(); } catch (_) { } this.wakeLock = null; }
  }

  renderVoiceState(override) {
    const on = voice.enabled;
    $("session-voice").textContent = override || (on ? `音声: ${voice.label}` : "音声: オフ");
    $("session-mute").textContent = on ? "音声を止める" : "音声を出す";
    $("session-mute").setAttribute("aria-pressed", String(!on));
  }

  renderStep(st) {
    const kindEl = $("session-kind");
    const nameEl = $("session-name");
    const detailEl = $("session-detail");
    const artEl = $("session-art");
    const stage = $("session-stage");

    stage.dataset.kind = st.kind;

    if (st.kind === "phase") {
      $("session-phase").textContent = st.phaseLabel;
      kindEl.textContent = "";
      nameEl.textContent = st.phaseLabel;
      detailEl.textContent = (PHASE_META[st.phaseKey] || {}).note || "";
      artEl.replaceChildren();
      this.renderTime();
      return;
    }

    const ex = st.ex;
    nameEl.textContent = ex.name;
    artEl.replaceChildren(poseArt(regionGroupOf(ex.category)));

    if (st.kind === "announce") {
      kindEl.textContent = "次の種目";
      detailEl.textContent = st.sets > 1
        ? `${amountOf(ex)} × ${st.sets}セット`
        : amountOf(ex);
    } else if (st.kind === "work") {
      kindEl.textContent = st.sets > 1 ? `${st.setNo} / ${st.sets} セット目` : "実施中";
      detailEl.textContent = st.mode === "manual"
        ? `${st.reps}回 — 終わったら「完了」`
        : `${st.seconds}秒`;
    } else if (st.kind === "rest") {
      kindEl.textContent = "休憩";
      detailEl.textContent = `次は ${st.setNo + 1} / ${st.sets} セット目`;
    }

    this.renderTime();
    this.renderProgress();
  }

  renderTime() {
    const r = this.runner;
    if (!r) return;
    const st = r.current;
    const el = $("session-timer");
    if (!st || (st.kind === "work" && st.mode === "manual")) {
      el.textContent = st && st.reps ? `${st.reps}回` : "—";
      el.classList.remove("is-urgent");
      return;
    }
    const ms = r.remainingMs;
    el.textContent = ms == null ? "—" : mmss(ms);
    el.classList.toggle("is-urgent", ms != null && ms <= 3200);
  }

  renderProgress() {
    const r = this.runner;
    if (!r) return;
    const pct = Math.round((r.i / Math.max(1, r.steps.length)) * 100);
    $("session-progress").style.width = `${pct}%`;
  }

  renderControls() {
    const r = this.runner;
    if (!r) return;
    const main = $("session-main");
    const setMain = (label, variant) => {
      main.textContent = label;
      // session__main を落とすとグリッド配置が崩れるので必ず残す
      main.className = `btn session__main ${variant}`;
    };
    if (r.finished) { setMain("閉じる", "btn--cta"); return; }
    const st = r.current;
    if (st && st.kind === "work" && st.mode === "manual") setMain("完了", "btn--cta");
    else if (r.paused) setMain("再開", "btn--cta");
    else setMain("一時停止", "session__main--pause");
    this.el.classList.toggle("is-paused", r.paused);
    this.renderProgress();
  }

  renderFinished() {
    this.releaseWakeLock();
    const stage = $("session-stage");
    stage.dataset.kind = "finished";
    $("session-phase").textContent = "完了";
    $("session-kind").textContent = "";
    $("session-name").textContent = "お疲れさまでした";
    $("session-detail").textContent = "今日のメニューを通しました";
    $("session-timer").textContent = "";
    $("session-art").replaceChildren();
    $("session-progress").style.width = "100%";
  }
}
