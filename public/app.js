import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  connectAuthEmulator,
  initializeAuth,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import {
  approvalMessage,
  canContribute,
  classifyJoinError,
  createAnnouncer,
  endState,
  createCelebrationTracker,
  createInputGate,
  freeRole,
  MAX_LAYERS,
  otherRole,
  rainbowView,
  retryDelay,
  roleLossScreen,
  statusPhrase,
  viewState,
} from './logic.js';
import { createSpeaker } from './speech.js';
import { EMULATOR_CONFIG, PRODUCTION_CONFIG } from './firebase-config.js';

const ROOM_LIFETIME = 3 * 60 * 60 * 1000;
const EXPIRY_MARGIN = 60 * 1000;
const ROLE_LABEL = { a: 'A', b: 'B' };

// localhost ではエミュレータ（demo-niji）に、それ以外では本番に接続する
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

const app = initializeApp(isLocal ? EMULATOR_CONFIG : PRODUCTION_CONFIG);
// エミュレータではタブごとに別の匿名ユーザーにするためセッション単位で、
// 本番では再読み込みや再接続でも同じ uid を保てるよう端末に保持する
const auth = initializeAuth(app, {
  persistence: isLocal ? browserSessionPersistence : browserLocalPersistence,
});
const db = getDatabase(app);
if (isLocal) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
}

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== id;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connecting = (message = 'つないでいます…') => {
  $('connecting-message').textContent = message;
  show('connecting');
};

// 推測困難な部屋ID（英小文字＋数字24文字、約124ビット）
function newRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => (b % 36).toString(36)).join('');
}

let serverOffset = 0;
async function serverNow() {
  // .info は get() で読めないため、一度だけ購読して受け取る
  serverOffset = await new Promise((resolve) =>
    onValue(ref(db, '.info/serverTimeOffset'), (snap) => resolve(snap.val() ?? 0), { onlyOnce: true }),
  );
  return Date.now() + serverOffset;
}
// 直近に取得したずれを使った、同期的なサーバー時刻の見積もり（終了判定を同期的に行うため）
const nowEstimate = () => Date.now() + serverOffset;

// ---- 先生 ----

async function createRoom(uid) {
  const roomId = newRoomId();
  await set(ref(db, `rooms/${roomId}`), {
    meta: {
      ownerUid: uid,
      createdAt: serverTimestamp(),
      expiresAt: (await serverNow()) + ROOM_LIFETIME - EXPIRY_MARGIN,
      speech: true, // 読み上げは初期値オン（先生が切り替えられる）
    },
    counters: { a: 0, b: 0 },
  });
  history.replaceState(null, '', `?room=${roomId}&teacher=1`);
  return roomId;
}

function runTeacher(roomId) {
  show('teacher');
  const joinUrl = `${location.origin}${location.pathname}?room=${roomId}`;
  $('join-url').href = joinUrl;
  $('join-url').textContent = joinUrl;

  let hadRoom = false;
  onValue(
    ref(db, `rooms/${roomId}`),
    (snap) => {
      const room = snap.val();
      // 部屋が消えた：先生自身の終了操作（ended）。期限切れは読み取り拒否として下のエラー側に来る
      if (!room) return show('ended');
      hadRoom = true;
      const roles = room.roles ?? {};
      const requests = Object.keys(room.requests ?? {});
      const counters = room.counters ?? { a: 0, b: 0 };
      // 読み上げ設定（未設定の古い部屋はオン扱い）
      $('speech-toggle').checked = room.meta.speech !== false;
      $('expires').textContent = `有効期限：${new Date(room.meta.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで`;

      $('role-list').replaceChildren(
        ...['a', 'b'].map((role) => {
          const li = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = roles[role] ? `${ROLE_LABEL[role]}：参加中` : `${ROLE_LABEL[role]}：空き`;
          li.append(label);
          if (roles[role]) {
            const release = document.createElement('button');
            release.textContent = `${ROLE_LABEL[role]} を解除`;
            release.onclick = () =>
              update(ref(db, `rooms/${roomId}`), { [`roles/${role}`]: null, [`members/${roles[role]}`]: null });
            li.append(release);
          }
          return li;
        }),
      );

      const message = approvalMessage(roles);
      $('full-message').hidden = !message || requests.length === 0;
      $('full-message').textContent = message ?? '';
      $('no-requests').hidden = requests.length > 0;
      $('request-list').replaceChildren(
        ...requests.map((uid, i) => {
          const li = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = `参加希望 ${i + 1}`;
          const approve = document.createElement('button');
          const role = freeRole(roles);
          approve.textContent = role ? `承認して ${ROLE_LABEL[role]} にする` : '満員';
          approve.disabled = !role;
          approve.onclick = () =>
            update(ref(db, `rooms/${roomId}`), {
              [`requests/${uid}`]: null,
              [`roles/${role}`]: uid,
              [`members/${uid}`]: role,
            });
          const reject = document.createElement('button');
          reject.textContent = '見送る';
          reject.onclick = () => remove(ref(db, `rooms/${roomId}/requests/${uid}`));
          li.append(label, approve, reject);
          return li;
        }),
      );

      const state = viewState(counters, 'a');
      $('teacher-status').textContent =
        `共同成立 ${state.joint} 回` +
        (state.mineWaiting ? '・A が B を待っています' : '') +
        (state.theirsWaiting ? '・B が A を待っています' : '');
    },
    () => {
      // 読み取り拒否：一度も読めていなければ作成者ではない（先生用アドレスを別の端末で開いた）。
      // 読めていた部屋が拒否されたなら期限切れ。
      if (hadRoom) return show('expired');
      const childUrl = `${location.origin}${location.pathname}?room=${roomId}`;
      $('child-link').href = childUrl;
      $('child-link').textContent = childUrl;
      show('not-teacher');
    },
  );

  $('speech-toggle').onchange = (e) => set(ref(db, `rooms/${roomId}/meta/speech`), e.target.checked);

  $('end-room').onclick = async () => {
    if (!confirm('活動を終えて、部屋のデータを削除しますか？')) return;
    // 先に「終えた」合図（meta/endedAt）を書いてから削除する。承認済みの子どもは削除より先にこの合図を受け取る。
    // 期限切れ後は合図を書けない（Rules）が、削除はできるので続ける
    try {
      await set(ref(db, `rooms/${roomId}/meta/endedAt`), serverTimestamp());
    } catch {
      // 期限切れなど。子どもの画面は期限から「時間切れ」を判定する
    }
    await remove(ref(db, `rooms/${roomId}`));
    show('ended');
  };
}

// ---- 子ども ----

// 読み上げ。iPad Safari では一度ユーザー操作の中で有効化が必要なので、
// 待機画面も含め、ページ上のどの操作（タップ・click・Space／Enter）でも解除する。
const speaker = createSpeaker();
const unlockSpeech = (e) => {
  if (e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return;
  speaker.unlock();
};
for (const type of ['pointerup', 'click', 'keydown']) document.addEventListener(type, unlockSpeech, true);

// 参加希望を出す（出していなければ）。
// Rules に拒否された（部屋が無い・期限切れ・削除済み・先生自身の uid）ときだけ 'unavailable' を返す。
// 通信の失敗は「つながっていない」として、つながるまで自動で再試行する（終了とは判定しない）。
async function requestToJoin(roomId, uid) {
  for (let attempt = 0; ; attempt++) {
    try {
      const mine = await get(ref(db, `rooms/${roomId}/requests/${uid}`));
      const member = await get(ref(db, `rooms/${roomId}/members/${uid}`));
      if (!mine.exists() && !member.exists()) {
        await set(ref(db, `rooms/${roomId}/requests/${uid}`), { requestedAt: serverTimestamp() });
      }
      return 'ok';
    } catch (e) {
      if (classifyJoinError(e) === 'unavailable') return 'unavailable';
      connecting('つながっていません。そのままお待ちください…');
      await sleep(retryDelay(attempt));
    }
  }
}

async function runChild(roomId, uid) {
  connecting();
  if ((await requestToJoin(roomId, uid)) !== 'ok') return show('unavailable');
  show('waiting');

  let stopActivity = null;
  let hadRole = false;
  let hadRequest = false;
  const shared = { expiresAt: null, endedAt: null }; // 活動中に読めた有効期限と「終えた」合図（終了の区別に使う）
  onValue(ref(db, `rooms/${roomId}/members/${uid}`), async (snap) => {
    stopActivity?.();
    stopActivity = null;
    const role = snap.val();
    if (role) {
      hadRole = true;
      stopActivity = runActivity(roomId, role, shared);
      return;
    }
    if (!hadRole) return show('waiting');
    // 役割を失った：先生の「終えた」合図を受け取っていれば終了。なければ参加希望を出し直し、
    // 通れば解除（再承認を待つ）、拒否されたら期限から「先生が終えた」か「時間切れ」かを決める
    hadRole = false;
    const rejoin = shared.endedAt == null ? await requestToJoin(roomId, uid) : undefined;
    show(roleLossScreen({ endedAt: shared.endedAt, rejoin, expiresAt: shared.expiresAt, now: nowEstimate() }));
  });
  // 参加希望が消えたのに役割が付かない：先生が見送ったか、部屋が消えた。承認待ちのまま止まらないようにする
  onValue(
    ref(db, `rooms/${roomId}/requests/${uid}`),
    (snap) => {
      if (snap.exists()) {
        hadRequest = true;
        return;
      }
      if (!hadRequest) return;
      hadRequest = false;
      // 承認待ちの画面のときだけ切り替える（終了・時間切れの表示を上書きしない。
      // 拒否された書き込みも一瞬ローカルに現れてから消えるため、ここに来ることがある）
      setTimeout(() => {
        if (!hadRole && !stopActivity && (!$('waiting').hidden || !$('released').hidden)) show('unavailable');
      }, 1500);
    },
    () => {},
  );
}

function runActivity(roomId, role, shared = {}) {
  show('child');
  const stage = $('stage');
  const other = otherRole(role);
  const mineLight = $(`light-${role}`);
  const theirLight = $(`light-${other}`);
  const spark = $(`spark-${role}`);
  const rainbows = $('rainbows');
  const pulse = $('pulse');
  stage.setAttribute('aria-label', `${ROLE_LABEL[role]} の光を出す`);
  // 役割が変わって再開した場合に備え、前の表示状態を消しておく
  for (const light of [mineLight, theirLight]) light.classList.remove('held', 'inviting');

  let counters = null;
  let tracker = null;
  let announcer = null;
  let writing = false;
  let stopped = false;
  let expiresAt = null;
  let expiryTimer = null;
  const gate = createInputGate();

  // 終了の区別：有効期限（meta、承認後は読める）を過ぎたら「時間切れ」、部屋が消えたら「先生が終えた」
  function finish(kind) {
    if (stopped) return;
    show(kind);
  }
  function checkEnd(nextCounters) {
    const kind = endState({ counters: nextCounters, expiresAt, now: nowEstimate() });
    if (kind) finish(kind);
  }
  serverNow(); // 時刻のずれを更新しておく
  // 先生の「終えた」合図。削除より先に届くので、役割が消えたときの判定に使う
  const unsubscribeEnded = onValue(
    ref(db, `rooms/${roomId}/meta/endedAt`),
    (snap) => { shared.endedAt = snap.val(); },
    () => {},
  );
  const unsubscribeExpiry = onValue(
    ref(db, `rooms/${roomId}/meta/expiresAt`),
    async (snap) => {
      expiresAt = snap.val();
      shared.expiresAt = expiresAt;
      clearTimeout(expiryTimer);
      if (expiresAt == null) return;
      const remaining = expiresAt - (await serverNow());
      expiryTimer = setTimeout(() => checkEnd(counters), Math.max(0, remaining) + 500);
    },
    () => {}, // 読めなくなった理由は counters 側で判定する
  );

  // 先生側の読み上げオン／オフに従う
  const unsubscribeSpeech = onValue(
    ref(db, `rooms/${roomId}/meta/speech`),
    (snap) => speaker.setEnabled(snap.val() !== false),
    () => {}, // 役割の解除や終了で読めなくなった場合は counters 側の購読が画面を切り替える
  );

  function render(animate) {
    const state = viewState(counters, role);
    // 自分の光は呼吸（明るさ）、相手の光は揺れ（位置）で、動きの種類を分ける
    mineLight.classList.toggle('held', state.mineWaiting);
    theirLight.classList.toggle('inviting', state.theirsWaiting);
    renderRainbow(rainbowView(counters), animate);
    const phrase = statusPhrase(state);
    $('child-status').textContent = phrase;
    // 読み上げは状態が変わったときに1回だけ。読み込み時点の言葉は読まない
    if (!announcer) announcer = createAnnouncer(phrase);
    else speaker.say(announcer.next(phrase));
  }

  const unsubscribe = onValue(
    ref(db, `rooms/${roomId}/counters`),
    (snap) => {
      const next = snap.val();
      if (!next) return checkEnd(null);
      counters = next;
      const joint = Math.min(counters.a, counters.b);
      if (!tracker) {
        // 読み込み時点の状態は静止表示し、演出は再演しない
        tracker = createCelebrationTracker(joint);
        render(false);
        return;
      }
      const fresh = tracker.update(joint);
      render(true);
      if (fresh > 0 && joint > 1) playPulse();
    },
    // 読み取り拒否：承認済みの読み取りが拒否されるのは期限切れのとき。役割の解除なら members 側の購読が先に
    // 活動を止める（stopped）ので、少し待ってから判定する
    () => setTimeout(() => checkEnd(counters), 800),
  );

  // 虹の弧（SVG）。暖色の3本は左から、寒色の4本は右から描く。pathLength=1 なので dashoffset 1→0 で描かれる
  const ARCS = [
    ['warm', 95, '#e85d5d'], ['warm', 85, '#f0a03c'], ['warm', 75, '#f0d23c'],
    ['cool', 65, '#5dc26a'], ['cool', 55, '#3cb0f0'], ['cool', 45, '#4a6ee0'], ['cool', 35, '#9a5de0'],
  ];
  function newRainbow() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 100');
    svg.classList.add('rainbow');
    for (const [side, r, color] of ARCS) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = side === 'warm'
        ? `M ${100 - r} 100 A ${r} ${r} 0 0 1 ${100 + r} 100`
        : `M ${100 + r} 100 A ${r} ${r} 0 0 0 ${100 - r} 100`;
      path.setAttribute('d', d);
      path.setAttribute('pathLength', '1');
      path.setAttribute('stroke', color);
      path.classList.add(side);
      svg.append(path);
    }
    return svg;
  }

  // 案A：描き直し＋積み重ね。counters から決まる見た目（rainbowView）に DOM を合わせる。
  // animate=false（読み込み時）は完成した状態を一度に作り、描く動きを再演しない。
  let layers = []; // 新しい順
  let current = null;
  function renderRainbow(view, animate) {
    rainbows.classList.toggle('no-anim', !animate);
    if (!animate || !current || view.layers < layers.length) {
      rainbows.replaceChildren();
      layers = [];
      for (let i = 0; i < view.layers; i++) {
        const layer = newRainbow();
        layer.classList.add('layer');
        layers.push(layer);
        rainbows.append(layer);
      }
      current = newRainbow();
      rainbows.append(current);
    }
    // 虹が完成して次が始まった：今の虹を層に降ろし、新しい虹を描き始める
    while (layers.length < view.layers) {
      current.classList.add('layer');
      layers.unshift(current);
      current = newRainbow();
      rainbows.append(current);
    }
    while (layers.length > MAX_LAYERS) {
      const oldest = layers.pop();
      oldest.classList.add('fading');
      setTimeout(() => oldest.remove(), 2500);
    }
    layers.forEach((layer, i) => layer.setAttribute('data-depth', String(i + 1)));
    current.classList.toggle('warm', view.warm);
    current.classList.toggle('cool', view.cool);
  }

  function playPulse() {
    pulse.classList.remove('play');
    void pulse.offsetWidth;
    pulse.classList.add('play');
  }

  // 対応表 4：入力の瞬間に、自分の光の位置へ必ず小さな光を返す（参加として数えるかとは無関係）。
  // 連続入力では、消えかけの光を今の明るさから明るくし直すだけで、暗転を挟まない（対応表 8）。
  let sparkAnimation = null;
  function feedback() {
    const from = Number(getComputedStyle(spark).opacity) || 0;
    sparkAnimation?.cancel();
    sparkAnimation = spark.animate(
      [{ opacity: from }, { opacity: 1, offset: 0.12 }, { opacity: 0 }],
      { duration: 700, easing: 'ease-out' },
    );
  }

  async function contribute() {
    if (!counters || writing || !canContribute(counters, role)) return;
    writing = true;
    try {
      await set(ref(db, `rooms/${roomId}/counters/${role}`), counters[role] + 1);
    } catch {
      // Rules に拒否された場合（古い状態を見ていた等）も、個別反応は返しているので何もしない
    } finally {
      writing = false;
    }
  }

  // タップ・スワイプ・マウス・スイッチコントロール：押した瞬間に反応し、離した時点で1回の参加とする
  const onPointerDown = (e) => {
    e.preventDefault();
    feedback();
  };
  const onPointerUp = (e) => {
    e.preventDefault();
    if (gate.pointerUp(e.timeStamp)) contribute();
  };
  // click だけを送る入力（VoiceOver のダブルタップ、一部の注視クリック・スキャン）。
  // タッチ直後の click は gate が除くので、二重には数えない。
  const onClick = (e) => {
    if (!gate.click(e.timeStamp)) return;
    feedback();
    contribute();
  };
  // キーボード・外部スイッチ（Space／Enter）。押しっぱなしの自動リピートは反応も参加も1回だけ
  const onKeyDown = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!gate.key(e.repeat)) return;
    feedback();
    contribute();
  };
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('click', onClick);
  // フォーカスが外れていても外部スイッチが効くよう、ウィンドウ全体で受ける（Space のスクロールも抑止）
  window.addEventListener('keydown', onKeyDown);
  stage.focus();

  return () => {
    stopped = true;
    clearTimeout(expiryTimer);
    unsubscribe();
    unsubscribeEnded();
    unsubscribeExpiry();
    unsubscribeSpeech();
    speaker.stop();
    sparkAnimation?.cancel();
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKeyDown);
  };
}

// ---- 起動 ----

// 匿名ログイン。失敗（通信）したら「つないでいます」のまま再試行する（今までは真っ白だった）
async function signIn() {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await signInAnonymously(auth)).user;
    } catch {
      connecting('つながっていません。そのままお待ちください…');
      await sleep(retryDelay(attempt));
    }
  }
}
connecting();
const user = await signIn();
const params = new URLSearchParams(location.search);
const roomId = params.get('room');

if (!roomId) {
  show('home');
  $('create-room').onclick = async () => {
    $('create-room').disabled = true;
    runTeacher(await createRoom(user.uid));
  };
} else if (params.get('teacher')) {
  runTeacher(roomId);
} else {
  runChild(roomId, user.uid);
}
