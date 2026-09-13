/**
 * 音声エンジン層。
 *
 * 方針:
 *  - 既定は Web Speech。追加インストールが要らず、モバイルでもPCでも動く。
 *    VOICEVOX は PC でエンジンを起動しているときだけ使える「音質の上乗せ」であり、
 *    これに依存した設計にはしない。
 *  - VOICEVOX が途中で失敗したら黙って Web Speech に戻す。
 *    声が止まるより、多少質が落ちても進行が続くほうがよい。
 *  - 発話は必ずキューで直列化する。重なると何を言っているか分からなくなる。
 */

/* --------------------------------------------------------------- VOICEVOX */

// 接続方法は決め打ちにしない。実測（Chrome 152 / Windows）では
//   localhost:50021 … 公開版からもローカル版からも通る
//   127.0.0.1:50021 … 公開版からはタイムアウトする
//   targetAddressSpace: 'local' … 付けると両方とも失敗する（付けてはいけない）
// 環境差があるので、通った順に採用する。
const VV_BASES = ["http://localhost:50021", "http://127.0.0.1:50021"];
const VV_TIMEOUT_MS = 2500;

/** 既定の話者。見つからなければ最初の話者にする */
const VV_PREFERRED_SPEAKER = "四国めたん";

function fetchWithTimeout(url, opts = {}, ms = VV_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal })
    .finally(() => clearTimeout(timer));
}

class VoicevoxVoice {
  constructor(base, speakerId, speakerLabel) {
    this.base = base;
    this.speakerId = speakerId;
    this.label = `VOICEVOX（${speakerLabel}）`;
    this.cache = new Map();   // text -> AudioBuffer
    this.ctx = null;
    this.source = null;
  }

  /** エンジンが居るかを調べ、居れば使える実体を返す。居なければ null */
  static async detect() {
    for (const base of VV_BASES) {
      try {
        const res = await fetchWithTimeout(base + "/version", { cache: "no-store" });
        if (!res.ok) continue;
        const speakers = await (await fetchWithTimeout(base + "/speakers")).json();
        const flat = [];
        speakers.forEach((s) => s.styles.forEach((st) =>
          flat.push({ id: st.id, label: `${s.name}（${st.name}）`, name: s.name })));
        if (flat.length === 0) continue;
        const pick = flat.find((v) => v.name === VV_PREFERRED_SPEAKER) || flat[0];
        return new VoicevoxVoice(base, pick.id, pick.label);
      } catch (_) { /* 次の候補へ */ }
    }
    return null;
  }

  /** 再生用の AudioContext はユーザー操作のあとでないと開始できない */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("AudioContext 非対応");
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") return this.ctx.resume();
    return Promise.resolve();
  }

  async synth(text) {
    if (this.cache.has(text)) return this.cache.get(text);
    const q = await fetchWithTimeout(
      `${this.base}/audio_query?text=${encodeURIComponent(text)}&speaker=${this.speakerId}`,
      { method: "POST" }, 8000);
    if (!q.ok) throw new Error(`audio_query ${q.status}`);
    const query = await q.json();
    const w = await fetchWithTimeout(`${this.base}/synthesis?speaker=${this.speakerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    }, 15000);
    if (!w.ok) throw new Error(`synthesis ${w.status}`);
    const wav = await w.arrayBuffer();
    await this.unlock();
    const buf = await this.ctx.decodeAudioData(wav);
    this.cache.set(text, buf);
    return buf;
  }

  /**
   * 合成には 500ms 前後かかる。カウントダウンのような
   * 「その瞬間に鳴らないと意味がない」語は先に作って持っておく。
   */
  async prefetch(texts) {
    for (const t of texts) {
      try { await this.synth(t); } catch (_) { /* 失敗しても本番で作り直す */ }
    }
  }

  async speak(text, { rate = 1 } = {}) {
    const buf = await this.synth(text);
    await this.unlock();
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(this.ctx.destination);
      src.onended = () => { this.source = null; resolve(); };
      this.source = src;
      src.start();
    });
  }

  cancel() {
    if (this.source) { try { this.source.stop(); } catch (_) { } this.source = null; }
  }
}

/* ------------------------------------------------------------ Web Speech */

function japaneseVoices() {
  return speechSynthesis.getVoices().filter(
    (v) => /^ja(-|_|$)/i.test(v.lang) || /japan/i.test(v.name));
}

/** getVoices() は初回が空のことがある。voiceschanged を待つ */
function waitForVoices(ms = 1500) {
  return new Promise((resolve) => {
    if (japaneseVoices().length > 0) return resolve();
    const done = () => { clearTimeout(timer); speechSynthesis.onvoiceschanged = null; resolve(); };
    const timer = setTimeout(done, ms);
    speechSynthesis.onvoiceschanged = done;
  });
}

class WebSpeechVoice {
  constructor() {
    this.label = "ブラウザ標準";
    this.voice = null;
  }

  static isAvailable() {
    return typeof window !== "undefined"
      && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  async init() {
    await waitForVoices();
    const ja = japaneseVoices();
    // ネットワーク合成より端末内蔵を優先する。オフラインでも切れない
    this.voice = ja.find((v) => v.localService) || ja[0] || null;
    if (this.voice) this.label = `ブラウザ標準（${this.voice.name}）`;
    return true;
  }

  unlock() {
    // 無音を1回流して、ユーザー操作のうちに発話を解禁しておく（iOS対策）
    try {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (_) { }
    return Promise.resolve();
  }

  async prefetch() { /* 事前生成は不要 */ }

  speak(text, { rate = 1.05, pitch = 1 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      try {
        const u = new SpeechSynthesisUtterance(text);
        if (this.voice) u.voice = this.voice;
        u.lang = "ja-JP";
        u.rate = rate;
        u.pitch = pitch;
        u.onend = finish;
        u.onerror = finish;
        speechSynthesis.speak(u);
        // onend が来ない端末がある。長さから概算した保険をかける
        setTimeout(finish, 1200 + text.length * 180);
      } catch (_) { finish(); }
    });
  }

  cancel() { try { speechSynthesis.cancel(); } catch (_) { } }
}

/* -------------------------------------------------------- 発話キュー本体 */

class Voice {
  constructor() {
    this.engine = null;
    this.fallback = null;
    this.enabled = true;
    this.queue = Promise.resolve();
    this.stopped = false;
  }

  get label() {
    if (!this.engine) return "音声なし";
    return this.engine.label;
  }

  get usingVoicevox() { return this.engine instanceof VoicevoxVoice; }

  /** 使えるエンジンを決める。VOICEVOX が居ればそちら、居なければ Web Speech */
  async init({ preferVoicevox = true } = {}) {
    if (WebSpeechVoice.isAvailable()) {
      this.fallback = new WebSpeechVoice();
      await this.fallback.init();
    }
    if (preferVoicevox) {
      try {
        const vv = await VoicevoxVoice.detect();
        if (vv) { this.engine = vv; return this.label; }
      } catch (_) { /* 居ないだけ。何も言わない */ }
    }
    this.engine = this.fallback;
    return this.label;
  }

  /** ユーザー操作の中で1回呼ぶ。これをしないと端末によっては音が出ない */
  async unlock() {
    this.stopped = false;
    try { if (this.engine) await this.engine.unlock(); } catch (_) { }
    try { if (this.fallback && this.fallback !== this.engine) await this.fallback.unlock(); }
    catch (_) { }
  }

  async prefetch(texts) {
    if (!this.engine) return;
    try { await this.engine.prefetch(texts); } catch (_) { }
  }

  /**
   * 発話をキューに積む。前の発話が終わってから次を話す。
   * VOICEVOX が失敗したらその場で Web Speech に切り替えて言い直す。
   */
  say(text, opts = {}) {
    if (!text) return this.queue;
    this.queue = this.queue.then(async () => {
      if (!this.enabled || this.stopped || !this.engine) return;
      try {
        await this.engine.speak(text, opts);
      } catch (err) {
        if (this.engine !== this.fallback && this.fallback) {
          console.warn("音声エンジンを切り替えます:", err && err.message);
          this.engine = this.fallback;
          try { await this.engine.speak(text, opts); } catch (_) { }
        }
      }
    }).catch(() => { });
    return this.queue;
  }

  /** 今の発話を止め、積まれている分も捨てる */
  stop() {
    this.stopped = true;
    if (this.engine) this.engine.cancel();
    if (this.fallback && this.fallback !== this.engine) this.fallback.cancel();
    this.queue = Promise.resolve();
  }

  resume() { this.stopped = false; }
}

export const voice = new Voice();
export { VoicevoxVoice, WebSpeechVoice };
