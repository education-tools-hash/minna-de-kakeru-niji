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
  createCelebrationTracker,
  createInputGate,
  freeRole,
  otherRole,
  viewState,
} from './logic.js';
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

// 推測困難な部屋ID（英小文字＋数字24文字、約124ビット）
function newRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => (b % 36).toString(36)).join('');
}

async function serverNow() {
  // .info は get() で読めないため、一度だけ購読して受け取る
  const offset = await new Promise((resolve) =>
    onValue(ref(db, '.info/serverTimeOffset'), (snap) => resolve(snap.val() ?? 0), { onlyOnce: true }),
  );
  return Date.now() + offset;
}

// ---- 先生 ----

async function createRoom(uid) {
  const roomId = newRoomId();
  await set(ref(db, `rooms/${roomId}`), {
    meta: {
      ownerUid: uid,
      createdAt: serverTimestamp(),
      expiresAt: (await serverNow()) + ROOM_LIFETIME - EXPIRY_MARGIN,
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

  onValue(
    ref(db, `rooms/${roomId}`),
    (snap) => {
      const room = snap.val();
      if (!room) return show('closed');
      const roles = room.roles ?? {};
      const requests = Object.keys(room.requests ?? {});
      const counters = room.counters ?? { a: 0, b: 0 };
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
    () => show('closed'),
  );

  $('end-room').onclick = async () => {
    if (!confirm('活動を終えて、部屋のデータを削除しますか？')) return;
    await remove(ref(db, `rooms/${roomId}`));
    show('closed');
  };
}

// ---- 子ども ----

// 参加希望を出す（出していなければ）。部屋が削除・期限切れなら Rules に拒否されるので false を返す。
async function requestToJoin(roomId, uid) {
  try {
    const mine = await get(ref(db, `rooms/${roomId}/requests/${uid}`));
    const member = await get(ref(db, `rooms/${roomId}/members/${uid}`));
    if (!mine.exists() && !member.exists()) {
      await set(ref(db, `rooms/${roomId}/requests/${uid}`), { requestedAt: serverTimestamp() });
    }
    return true;
  } catch (e) {
    // 実機確認用：拒否・失敗の理由を終了画面に小さく出す（個人情報は含まない）
    $('closed-detail').textContent = `確認用：${e.code ?? e.name ?? ''} ${e.message ?? ''}／部屋 ${roomId.length}文字`;
    return false;
  }
}

async function runChild(roomId, uid) {
  show('waiting');
  if (!(await requestToJoin(roomId, uid))) return show('closed');

  let stopActivity = null;
  let hadRole = false;
  onValue(ref(db, `rooms/${roomId}/members/${uid}`), async (snap) => {
    stopActivity?.();
    stopActivity = null;
    const role = snap.val();
    if (role) {
      hadRole = true;
      stopActivity = runActivity(roomId, role);
      return;
    }
    if (!hadRole) return show('waiting');
    // 役割を失った：先生による解除なら参加希望を出し直して再承認を待つ。部屋の終了なら拒否される。
    hadRole = false;
    show((await requestToJoin(roomId, uid)) ? 'waiting' : 'closed');
  });
}

function runActivity(roomId, role) {
  show('child');
  const stage = $('stage');
  const other = otherRole(role);
  const mineLight = $(`light-${role}`);
  const theirLight = $(`light-${other}`);
  const spark = $(`spark-${role}`);
  const rainbow = $('rainbow');
  const pulse = $('pulse');
  stage.setAttribute('aria-label', `${ROLE_LABEL[role]} の光を出す`);
  // 役割が変わって再開した場合に備え、前の表示状態を消しておく
  for (const light of [mineLight, theirLight]) light.classList.remove('held', 'inviting');

  let counters = null;
  let tracker = null;
  let writing = false;
  const gate = createInputGate();

  function render(animate) {
    const state = viewState(counters, role);
    // 自分の光は呼吸（明るさ）、相手の光は揺れ（位置）で、動きの種類を分ける
    mineLight.classList.toggle('held', state.mineWaiting);
    theirLight.classList.toggle('inviting', state.theirsWaiting);
    rainbow.classList.toggle('no-anim', !animate);
    rainbow.classList.toggle('complete', state.rainbowComplete);
    $('child-status').textContent = state.mineWaiting
      ? 'あなたの光が待っています'
      : state.theirsWaiting
        ? 'ともだちの光が待っています'
        : state.rainbowComplete
          ? `虹ができました（${state.joint}）`
          : '光を出してみよう';
  }

  const unsubscribe = onValue(
    ref(db, `rooms/${roomId}/counters`),
    (snap) => {
      const next = snap.val();
      if (!next) return show('closed');
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
    () => show('closed'),
  );

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
    unsubscribe();
    sparkAnimation?.cancel();
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKeyDown);
  };
}

// ---- 起動 ----

const { user } = await signInAnonymously(auth);
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
