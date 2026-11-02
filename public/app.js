import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
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
  freeRole,
  otherRole,
  viewState,
} from './logic.js';

const ROOM_LIFETIME = 3 * 60 * 60 * 1000;
const EXPIRY_MARGIN = 60 * 1000;
const ROLE_LABEL = { a: 'A', b: 'B' };

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if (!isLocal) {
  document.body.textContent = '本番環境の設定はまだありません（エミュレータでのみ動作します）。';
  throw new Error('production config not set');
}

const app = initializeApp({
  apiKey: 'demo-key',
  authDomain: 'demo-niji.firebaseapp.com',
  projectId: 'demo-niji',
  databaseURL: 'http://127.0.0.1:9000?ns=demo-niji-default-rtdb',
});
// エミュレータではタブごとに別の匿名ユーザーにするため、セッション単位で保持する
const auth = initializeAuth(app, { persistence: browserSessionPersistence });
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getDatabase(app);
connectDatabaseEmulator(db, '127.0.0.1', 9000);

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
  } catch {
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
  const mineLight = $(`light-${role}`);
  const rainbow = $('rainbow');
  const pulse = $('pulse');
  stage.setAttribute('aria-label', `${ROLE_LABEL[role]} の光を出す`);

  let counters = null;
  let tracker = null;
  let writing = false;

  function render(animate) {
    const state = viewState(counters, role);
    $(`light-${role}`).classList.toggle('held', state.mineWaiting);
    $(`light-${otherRole(role)}`).classList.toggle('held', state.theirsWaiting);
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

  // 一人ひとりの入力には、毎回すぐに個別反応を返す
  function feedback() {
    mineLight.classList.remove('flash');
    void mineLight.offsetWidth;
    mineLight.classList.add('flash');
    setTimeout(() => mineLight.classList.remove('flash'), 400);
  }

  async function act() {
    feedback();
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

  // タップ・スワイプ・マウス：1回のジェスチャー（指やボタンを離した時点）を1回の参加とする
  const onPointerUp = (e) => {
    e.preventDefault();
    act();
  };
  // キーボード・外部スイッチ（Space／Enter）。押しっぱなしの自動リピートは数えない
  const onKeyDown = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) act();
  };
  stage.addEventListener('pointerup', onPointerUp);
  // フォーカスが外れていても外部スイッチが効くよう、ウィンドウ全体で受ける（Space のスクロールも抑止）
  window.addEventListener('keydown', onKeyDown);
  stage.focus();

  return () => {
    unsubscribe();
    stage.removeEventListener('pointerup', onPointerUp);
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
