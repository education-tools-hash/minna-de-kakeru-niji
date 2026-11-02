// Security Rules の単体テスト（エミュレータ上で実行）。
// テスト番号は「Firebase 机上検証メモ v1.2」§3 と、11月2日に承認された追加分（A15〜A18・D7・D8）に対応する。
// C1〜C3 と A6 の表示部分は Rules では検証できないため tests/client.test.js で確認する。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';

const ROOM = 'room-7f3kq9xz2m';
const ROOM2 = 'room-p8w2nd5vty';
const OWNER = 'uid-teacher';
const A = 'uid-child-a';
const B = 'uid-child-b';
const X = 'uid-stranger';
const Y = 'uid-stranger-2';
const HOUR = 60 * 60 * 1000;
const TS = { '.sv': 'timestamp' };

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-niji',
    database: {
      rules: readFileSync('database.rules.json', 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearDatabase();
});

const db = (uid) =>
  uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database();
const ref = (uid, path) => db(uid).ref(path);
const roomPath = (p = '', room = ROOM) => `rooms/${room}${p ? `/${p}` : ''}`;

// Rules を無効にした状態で、テストの前提となる部屋を用意する。
function roomData({
  a = 0,
  b = 0,
  roles = { a: A, b: B },
  requests = {},
  createdAt = Date.now() - 60 * 1000,
  expiresAt = Date.now() + HOUR,
} = {}) {
  const members = {};
  for (const [role, uid] of Object.entries(roles)) members[uid] = role;
  const data = {
    meta: { ownerUid: OWNER, createdAt, expiresAt },
    counters: { a, b },
  };
  if (Object.keys(roles).length) {
    data.roles = roles;
    data.members = members;
  }
  if (Object.keys(requests).length) data.requests = requests;
  return data;
}

async function seed(rooms) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('rooms').set(rooms);
  });
}

async function readAsAdmin(path) {
  let value;
  await env.withSecurityRulesDisabled(async (ctx) => {
    value = (await ctx.database().ref(path).get()).val();
  });
  return value;
}

const expired = () => ({
  createdAt: Date.now() - 4 * HOUR,
  expiresAt: Date.now() - HOUR,
});

const newRoom = (overrides = {}) => ({
  meta: { ownerUid: OWNER, createdAt: TS, expiresAt: Date.now() + 3 * HOUR - 60 * 1000, ...overrides },
  counters: { a: 0, b: 0 },
});

describe('基準（正常系の前提確認）', () => {
  test('教員が新しい部屋を作成できる', async () => {
    await assertSucceeds(ref(OWNER, roomPath('', ROOM2)).set(newRoom()));
  });

  test('承認済みメンバーは自分の部屋の状態を読める', async () => {
    await seed({ [ROOM]: roomData() });
    await assertSucceeds(ref(A, roomPath('counters')).get());
    await assertSucceeds(ref(A, roomPath('roles')).get());
    await assertSucceeds(ref(A, roomPath('meta')).get());
  });
});

describe('A. 役割と承認', () => {
  test('A1 A が自分のカウンタを 0→1 に書ける', async () => {
    await seed({ [ROOM]: roomData() });
    await assertSucceeds(ref(A, roomPath('counters/a')).set(1));
  });

  test('A2 A は B のカウンタを書けない', async () => {
    await seed({ [ROOM]: roomData() });
    await assertFails(ref(A, roomPath('counters/b')).set(1));
    expect(await readAsAdmin(roomPath('counters/b'))).toBe(0);
  });

  test('A3 未承認の第三者は部屋データを読めない', async () => {
    await seed({ [ROOM]: roomData() });
    await assertFails(ref(X, roomPath()).get());
    await assertFails(ref(X, roomPath('counters')).get());
    await assertFails(ref(X, roomPath('roles')).get());
    await assertFails(ref(X, roomPath('meta')).get());
    await assertFails(ref(X, 'rooms').get());
  });

  test('A4 未承認の第三者は参加希望を書けるが、活動データは読めない', async () => {
    await seed({ [ROOM]: roomData({ roles: {} }) });
    await assertSucceeds(ref(X, roomPath(`requests/${X}`)).set({ requestedAt: TS }));
    await assertFails(ref(X, roomPath('counters')).get());
  });

  test('A5 教員は参加希望を承認し、空き役割 a に割り当てられる', async () => {
    await seed({ [ROOM]: roomData({ roles: {}, requests: { [X]: { requestedAt: Date.now() } } }) });
    await assertSucceeds(
      ref(OWNER, roomPath()).update({
        [`requests/${X}`]: null,
        'roles/a': X,
        [`members/${X}`]: 'a',
      }),
    );
    expect(await readAsAdmin(roomPath('roles/a'))).toBe(X);
    expect(await readAsAdmin(roomPath(`members/${X}`))).toBe('a');
  });

  test('A6 満員のとき、教員は第三者を承認できない', async () => {
    await seed({ [ROOM]: roomData({ requests: { [X]: { requestedAt: Date.now() } } }) });
    for (const role of ['a', 'b']) {
      await assertFails(
        ref(OWNER, roomPath()).update({
          [`requests/${X}`]: null,
          [`roles/${role}`]: X,
          [`members/${X}`]: role,
        }),
      );
    }
  });

  test('A7 未ログインでは何も読み書きできない', async () => {
    await seed({ [ROOM]: roomData({ roles: {} }) });
    await assertFails(ref(null, roomPath()).get());
    await assertFails(ref(null, roomPath('counters')).get());
    await assertFails(ref(null, roomPath('requests/anon')).set({ requestedAt: TS }));
    await assertFails(ref(null, roomPath('counters/a')).set(1));
    await assertFails(ref(null, roomPath('', ROOM2)).set(newRoom({ ownerUid: 'anon' })));
  });

  test('A8 作成者 uid の記録は誰も書き換えられない', async () => {
    await seed({ [ROOM]: roomData() });
    for (const uid of [A, X, OWNER]) {
      await assertFails(ref(uid, roomPath('meta/ownerUid')).set(uid));
    }
  });

  test('A9 子ども A は他者の参加希望を承認できない', async () => {
    await seed({ [ROOM]: roomData({ roles: { a: A }, requests: { [X]: { requestedAt: Date.now() } } }) });
    await assertFails(
      ref(A, roomPath()).update({
        [`requests/${X}`]: null,
        'roles/b': X,
        [`members/${X}`]: 'b',
      }),
    );
  });

  test('A10 子ども B は管理操作（期限の変更・参加希望の削除・役割の解除）を実行できない', async () => {
    await seed({ [ROOM]: roomData({ requests: { [X]: { requestedAt: Date.now() } } }) });
    await assertFails(ref(B, roomPath('meta/expiresAt')).set(Date.now() + 2 * HOUR));
    await assertFails(ref(B, roomPath(`requests/${X}`)).remove());
    await assertFails(ref(B, roomPath('roles/a')).remove());
  });

  test('A11 既存の部屋を同じ部屋IDで上書きできない', async () => {
    await seed({ [ROOM]: roomData() });
    await assertFails(ref(X, roomPath()).set(newRoom({ ownerUid: X })));
    expect(await readAsAdmin(roomPath('meta/ownerUid'))).toBe(OWNER);
  });

  test('A12 作成者 uid に自分以外の uid を入れて部屋を作れない', async () => {
    await assertFails(ref(X, roomPath('', ROOM2)).set(newRoom({ ownerUid: OWNER })));
  });

  test('A13 参加希望者は自分を承認済みにできない', async () => {
    await seed({ [ROOM]: roomData({ roles: {}, requests: { [X]: { requestedAt: Date.now() } } }) });
    await assertFails(ref(X, roomPath('roles/a')).set(X));
    await assertFails(ref(X, roomPath(`members/${X}`)).set('a'));
    await assertFails(
      ref(X, roomPath()).update({
        [`requests/${X}`]: null,
        'roles/a': X,
        [`members/${X}`]: 'a',
      }),
    );
  });

  test('A14 他人名義の参加希望は書けず、他人の参加希望は読めない（自分のものは読める）', async () => {
    await seed({ [ROOM]: roomData({ roles: {}, requests: { [Y]: { requestedAt: Date.now() } } }) });
    await assertFails(ref(X, roomPath(`requests/${A}`)).set({ requestedAt: TS }));
    await assertFails(ref(X, roomPath(`requests/${Y}`)).get());
    await assertFails(ref(X, roomPath('requests')).get());
    await assertSucceeds(ref(X, roomPath(`requests/${X}`)).set({ requestedAt: TS }));
    await assertSucceeds(ref(X, roomPath(`requests/${X}`)).get());
    await assertSucceeds(ref(X, roomPath(`members/${X}`)).get());
  });

  test('A15 カウンタに数値以外・小数を書けない', async () => {
    await seed({ [ROOM]: roomData() });
    await assertFails(ref(A, roomPath('counters/a')).set('1'));
    await assertFails(ref(A, roomPath('counters/a')).set(0.5));
    await assertFails(ref(A, roomPath('counters/a')).set(true));
    await assertFails(ref(A, roomPath('counters/a')).set({ value: 1 }));
  });

  test('A16 別の部屋の状態は読み書きできない', async () => {
    await seed({ [ROOM]: roomData(), [ROOM2]: roomData({ roles: { a: X, b: Y } }) });
    await assertFails(ref(A, roomPath('counters/a', ROOM2)).set(1));
    await assertFails(ref(A, roomPath('counters', ROOM2)).get());
  });

  test('A17 教員は自分自身を役割に割り当てられない', async () => {
    await seed({ [ROOM]: roomData({ roles: {} }) });
    await assertFails(ref(OWNER, roomPath(`requests/${OWNER}`)).set({ requestedAt: TS }));
    // 参加希望が（Rules の外で）存在したとしても、教員自身の割り当ては拒否されること
    await seed({ [ROOM]: roomData({ roles: {}, requests: { [OWNER]: { requestedAt: Date.now() } } }) });
    await assertFails(
      ref(OWNER, roomPath()).update({
        [`requests/${OWNER}`]: null,
        'roles/a': OWNER,
        [`members/${OWNER}`]: 'a',
      }),
    );
  });

  test('A18 教員は役割 a を解除して新しい uid を再承認でき、カウンタは保持される', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await assertSucceeds(ref(OWNER, roomPath()).update({ 'roles/a': null, [`members/${A}`]: null }));
    await assertSucceeds(ref(X, roomPath(`requests/${X}`)).set({ requestedAt: TS }));
    await assertSucceeds(
      ref(OWNER, roomPath()).update({
        [`requests/${X}`]: null,
        'roles/a': X,
        [`members/${X}`]: 'a',
      }),
    );
    expect(await readAsAdmin(roomPath('counters/a'))).toBe(1);
    await assertFails(ref(A, roomPath('counters/a')).set(2));
    await assertSucceeds(ref(X, roomPath('counters/a')).set(2));
  });
});

describe('B. min 方式の増分条件', () => {
  test('B1 A=0,B=0 で A が 0→1', async () => {
    await seed({ [ROOM]: roomData() });
    await assertSucceeds(ref(A, roomPath('counters/a')).set(1));
  });

  test('B2 A=1,B=0 で B が 0→1（虹が完成）', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 0 }) });
    await assertSucceeds(ref(B, roomPath('counters/b')).set(1));
  });

  test('B3 A=1,B=1 で A が 1→2（次の共同変化を待機）', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await assertSucceeds(ref(A, roomPath('counters/a')).set(2));
  });

  test('B4 A=2,B=1 で A が 2→3（先行中の連打）は拒否', async () => {
    await seed({ [ROOM]: roomData({ a: 2, b: 1 }) });
    await assertFails(ref(A, roomPath('counters/a')).set(3));
    expect(await readAsAdmin(roomPath('counters/a'))).toBe(2);
  });

  test('B5 A=1,B=1 で A が 1→3（飛ばし）は拒否', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await assertFails(ref(A, roomPath('counters/a')).set(3));
  });

  test('B6 A=1,B=1 で A が 1→0（後退）は拒否', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await assertFails(ref(A, roomPath('counters/a')).set(0));
    await assertFails(ref(A, roomPath('counters/a')).remove());
  });

  test('B7 A=1,B=0 で A が古い状態のまま 0→1 を再送すると拒否', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 0 }) });
    await assertFails(ref(A, roomPath('counters/a')).set(1));
  });

  test('B8 A=1,B=1 で A と B が同時に次の参加を書くと両方許可され、min=2', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await Promise.all([
      assertSucceeds(ref(A, roomPath('counters/a')).set(2)),
      assertSucceeds(ref(B, roomPath('counters/b')).set(2)),
    ]);
    const { a, b } = await readAsAdmin(roomPath('counters'));
    expect(Math.min(a, b)).toBe(2);
  });
});

describe('D. 期限と終了', () => {
  test('D1 期限切れの部屋ではカウンタを書けない', async () => {
    await seed({ [ROOM]: roomData(expired()) });
    await assertFails(ref(A, roomPath('counters/a')).set(1));
  });

  test('D2 期限切れの部屋は読めない', async () => {
    await seed({ [ROOM]: roomData(expired()) });
    await assertFails(ref(A, roomPath('counters')).get());
    await assertFails(ref(A, roomPath('meta')).get());
    await assertFails(ref(OWNER, roomPath()).get());
  });

  test('D3 教員は終了操作で部屋を削除でき、削除後は読み書きできない', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await assertSucceeds(ref(OWNER, roomPath()).remove());
    expect(await readAsAdmin(roomPath())).toBeNull();
    await assertFails(ref(A, roomPath('counters')).get());
    await assertFails(ref(A, roomPath('counters/a')).set(2));
  });

  test('D4 子ども A は部屋を削除できない', async () => {
    await seed({ [ROOM]: roomData() });
    await assertFails(ref(A, roomPath()).remove());
    await assertFails(ref(A, roomPath('counters')).remove());
  });

  test('D5 有効期限を作成時刻＋3時間より先に設定できない', async () => {
    await assertFails(ref(OWNER, roomPath('', ROOM2)).set(newRoom({ expiresAt: Date.now() + 24 * HOUR })));
    await assertFails(ref(OWNER, roomPath('', ROOM2)).set(newRoom({ expiresAt: Date.now() + 3 * HOUR + 60 * 1000 })));
  });

  test('D6 期限切れの部屋でも教員は削除できる', async () => {
    await seed({ [ROOM]: roomData(expired()) });
    await assertSucceeds(ref(OWNER, roomPath()).remove());
  });

  test('D7 作成時刻の偽装や過去の期限では部屋を作れない', async () => {
    await assertFails(
      ref(OWNER, roomPath('', ROOM2)).set(newRoom({ createdAt: Date.now() + 21 * HOUR, expiresAt: Date.now() + 24 * HOUR })),
    );
    await assertFails(ref(OWNER, roomPath('', ROOM2)).set(newRoom({ expiresAt: Date.now() - 1000 })));
  });

  test('D8 削除された部屋には旧メンバーが書き込めない', async () => {
    await seed({ [ROOM]: roomData({ a: 1, b: 1 }) });
    await assertSucceeds(ref(OWNER, roomPath()).remove());
    await assertFails(ref(A, roomPath('counters/a')).set(2));
    await assertFails(ref(A, roomPath('counters/a')).set(0));
  });
});
