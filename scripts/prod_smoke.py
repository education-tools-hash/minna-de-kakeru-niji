import json, time, urllib.request, urllib.error, secrets
KEY = 'AIzaSyCsSriTSSK2dzge-KNRrFpyOiWnE3EWPCk'
DB = 'https://minna-de-kakeru-niji-default-rtdb.asia-southeast1.firebasedatabase.app'

def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=15) as res:
            return res.status, json.loads(res.read() or 'null')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:80]

def anon():
    _, d = req('POST', f'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={KEY}', {'returnSecureToken': True})
    return d['localId'], d['idToken']

def db(method, path, token=None, body=None):
    q = f'?auth={token}' if token else ''
    return req(method, f'{DB}/{path}.json{q}', body)[0]

results = []
def check(label, code, expect_ok):
    ok = (code == 200) == expect_ok
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), label, f'(HTTP {code}, expected {"allow" if expect_ok else "deny"})')

owner_uid, owner = anon()
x_uid, stranger = anon()
room = ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(24))
check('未ログインで rooms を読む', db('GET', 'rooms'), False)
check('ログイン済みでも rooms 一覧は読めない', db('GET', 'rooms', stranger), False)
check('教員が部屋を作成（期限 now+3h-1min）', db('PUT', f'rooms/{room}', owner, {
    'meta': {'ownerUid': owner_uid, 'createdAt': {'.sv': 'timestamp'}, 'expiresAt': int(time.time()*1000) + 3*3600*1000 - 60000},
    'counters': {'a': 0, 'b': 0}}), True)
check('期限 now+24h の部屋は作れない（D5）', db('PUT', f'rooms/{room}x', owner, {
    'meta': {'ownerUid': owner_uid, 'createdAt': {'.sv': 'timestamp'}, 'expiresAt': int(time.time()*1000) + 24*3600*1000},
    'counters': {'a': 0, 'b': 0}}), False)
check('第三者は部屋を読めない（A3）', db('GET', f'rooms/{room}', stranger), False)
check('第三者はカウンタを書けない', db('PUT', f'rooms/{room}/counters/a', stranger, 1), False)
check('第三者は部屋を上書きできない（A11）', db('PUT', f'rooms/{room}', stranger, {
    'meta': {'ownerUid': x_uid, 'createdAt': {'.sv': 'timestamp'}, 'expiresAt': int(time.time()*1000) + 3600000},
    'counters': {'a': 0, 'b': 0}}), False)
check('第三者は参加希望を書ける（A4）', db('PUT', f'rooms/{room}/requests/{x_uid}', stranger, {'requestedAt': {'.sv': 'timestamp'}}), True)
check('教員は子どものカウンタを書けない（A19）', db('PUT', f'rooms/{room}/counters/a', owner, 1), False)
check('第三者は部屋を削除できない（D4 相当）', db('DELETE', f'rooms/{room}', stranger), False)
check('教員は部屋を削除できる（D3）', db('DELETE', f'rooms/{room}', owner), True)
print(f'{sum(results)}/{len(results)} passed')
