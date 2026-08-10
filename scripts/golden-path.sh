#!/usr/bin/env bash
# EV 黄金路径回归（server-client-split 后）：
# - 全程 EV_HOME 临时目录隔离：不读写用户真实 ~/.ev，失败也不留垃圾
# - UI 旅程跑 server 服务的 Web 形态 renderer（agent-browser 自带浏览器），不启 Electron
# - CLI 旅程与 round-trip 全走 HTTP API
set -u
cd "$(dirname "$0")/.."
EV_HOME="$(mktemp -d /tmp/ev-golden-home.XXXXXX)"
export EV_HOME
RUN_START_MS=$(python3 -c "import time;print(int(time.time()*1000))")

cleanup() {
	SRV_PID=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['pid'])" 2>/dev/null || true)
	[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
	# 铁律：不 rm -rf，丢垃圾桶
	mv "$EV_HOME" "$HOME/.Trash/ev-golden-home.$(date +%s)" 2>/dev/null
	true
}
trap cleanup EXIT

fail() {
	echo "❌ GOLDEN FAIL: $1"
	exit 1
}
ok() { echo "✅ $1"; }

ev() {
	agent-browser eval "$1" 2>/dev/null
}
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac }

run_ev() {
	if [ -x "$HOME/.ev/bin/ev" ]; then "$HOME/.ev/bin/ev" "$@"; else bun "$(pwd)/apps/cli/dist/ev.js" "$@"; fi
}

click_item() {
	local ref
	for _try in 1 2 3 4 5 6; do
		ref=$(agent-browser snapshot -i 2>/dev/null | grep -F "$1" | sed -E 's/.*\[ref=([a-zA-Z0-9]+)\].*/\1/' | head -1)
		[ -n "$ref" ] && break
		agent-browser connect "$PORT" >/dev/null 2>&1
		sleep 1
	done
	[ -n "$ref" ] || fail "menu item not found: $1"
	agent-browser click "@$ref" >/dev/null || fail "click failed: $1"
}

jsclick() {
	ev "(() => { const t=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')=='$1'); if(!t) return 'NO'; t.click(); return 'ok'; })()" | tr -d '"'
}

jstext() {
	ev "(() => { const t=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(!t) return 'NO'; t.click(); return 'ok'; })()" | tr -d '"'
}

jsclose() {
	ev "(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); document.body.dispatchEvent(new MouseEvent('click', {bubbles:true})); return 'ok'; })()" >/dev/null
	sleep 0.3
}

openmenu() {
	for _try in 1 2 3 4 5 6; do
		[ "$(jsclick "$1")" = "ok" ] || return 1
		sleep 0.5
		[ "$(ev 'document.querySelectorAll("[role=menuitem]").length')" != "0" ] && return 0
		sleep 0.5
	done
	return 1
}

jsitem() {
	local out
	for _try in 1 2 3 4 5 6; do
		out=$(ev "(() => { const i=[...document.querySelectorAll('[role=menuitem]')].find(x=>x.textContent.includes('$1')); if(!i) return 'NO'; i.click(); return 'ok'; })()" | tr -d '"')
		[ "$out" = "ok" ] && break
		sleep 0.5
	done
	printf '%s' "$out"
}

echo "== build =="
(cd apps/desktop && bunx electron-vite build >/dev/null 2>&1) || fail "build"

echo "== build cli =="
(cd apps/cli && bun run build >/dev/null 2>&1) || fail "cli build"

echo "== server + CLI journey（desktop 关闭状态）=="
run_ev server start >/dev/null || fail "server start"
run_ev settings set '{"language":"zh"}' >/dev/null || fail "pin language zh"
CID=$(run_ev task create --runtime pi | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") || fail "cli create"
run_ev task set-runtime "$CID" qoder >/dev/null || fail "cli set-runtime"
run_ev task prompt "$CID" "回复 ok" >/dev/null || fail "cli prompt"
FOLLOW=$(run_ev task follow "$CID" --until-idle) || fail "cli follow exit"
echo "$FOLLOW" | grep -q '"kind":"assistant"' || fail "cli follow no assistant"
ok "CLI journey create→set-runtime→prompt→follow（desktop closed）"

echo "== 重启持久化（SQLite）=="
RID2=$(run_ev task create --runtime pi | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") || fail "cli create for restart"
run_ev server stop >/dev/null || fail "server stop"
sleep 1
run_ev server start >/dev/null || fail "server restart"
GOT=$(run_ev task get "$RID2" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") || fail "task lost after restart"
[ "$GOT" = "$RID2" ] || fail "task id mismatch after restart"
[ -f "$EV_HOME/ev.db" ] || fail "ev.db missing"
ok "restart persistence: task survives server restart (SQLite)"

echo "== launch renderer（Web 形态，agent-browser 自带浏览器）=="
SP=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['port'])")
ST=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['token'])")
agent-browser set viewport 1440 900 >/dev/null 2>&1 || true
agent-browser open "http://127.0.0.1:$SP/?port=$SP&token=$ST&lang=zh" >/dev/null || fail "open web renderer"
READY=""
for _ in $(seq 1 20); do
	READY=$(ev "JSON.stringify({ready: !!window.agentDesktop, t: document.title})" | tr -d '\\' || true)
	contains "$READY" '"ready":true' && break
	sleep 1
done
contains "$READY" '"ready":true' || fail "renderer not ready: $READY"
HAS_SIDEBAR=""
for _ in $(seq 1 30); do
	HAS_SIDEBAR=$(ev "!!document.querySelector('.sidebar')" || true)
	[ "$HAS_SIDEBAR" = "true" ] && break
	sleep 1
done
[ "$HAS_SIDEBAR" = "true" ] || fail "renderer DOM not rendered"
sleep 1

echo "== 设置控件存在性（data-testid，locale 无关，不点击）=="
[ "$(ev "(() => { const b=document.querySelector('[data-testid=settings-open]'); if(!b) return 'NO'; b.click(); return 'ok'; })()" | tr -d '"')" = "ok" ] || fail "open settings"
sleep 1
for TID in picker-theme picker-runtime picker-thinking picker-model picker-language; do
	[ "$(ev "!!document.querySelector('[data-testid=$TID]')")" = "true" ] || fail "settings control missing: $TID"
done
[ "$(ev "(() => { const b=document.querySelector('[data-testid=settings-close]'); if(!b) return 'NO'; b.click(); return 'ok'; })()" | tr -d '"')" = "ok" ] || fail "close settings"
sleep 0.5
ok "settings controls present (theme/runtime/thinking/model/language)"

echo "== Runtime 行列表+抽屉（重设计断言，语义不放松）=="
[ "$(jsclick '设置')" = "ok" ] || fail "reopen settings"
sleep 1
[ "$(jstext 'Runtime')" = "ok" ] || fail "open runtime tab"
sleep 1
ROWS=$(ev "JSON.stringify({rows: document.querySelectorAll('.runtime-row').length, logged: document.querySelectorAll('.runtime-row .auth-status.logged_in').length})" | tr -d '\\')
contains "$ROWS" '"rows":4' || fail "runtime rows != 4 ($ROWS)"
[ "$(ev "document.querySelectorAll('.runtime-row .auth-status.logged_in').length")" -ge 3 ] || fail "expected >=3 logged_in"
[ "$(ev "(async () => { const r=[...document.querySelectorAll('.runtime-row')][0]; r.click(); await new Promise(x => setTimeout(x, 300)); return r.getAttribute('aria-expanded'); })()" | tr -d '"')" = "true" ] || fail "row click opens drawer"
sleep 0.5
DRAWER=$(ev "JSON.stringify({drawer: !!document.querySelector('.runtime-drawer'), paths: document.querySelectorAll('.runtime-drawer .auth-path').length, res: !!document.querySelector('.runtime-drawer .resource-settings'), status: document.querySelector('.runtime-drawer .auth-status')?.textContent?.slice(0,3) ?? ''})" | tr -d '\\')
echo "$DRAWER" | grep -q '"drawer":true' || fail "drawer not open ($DRAWER)"
echo "$DRAWER" | grep -q '"paths":0' && fail "drawer config paths missing"
echo "$DRAWER" | grep -q '"res":true' || fail "pi drawer lacks resource settings"
echo "$DRAWER" | grep -q '已登录' || fail "drawer login status missing"
ok "runtime rows + drawer assertions passed"

echo "== UI 打磨断言（2026-08-09 巡查修复点）=="
[ "$(jstext 'Browser')" = "ok" ] || fail "open browser tab"
sleep 0.5
[ "$(jstext 'Runtime')" = "ok" ] || fail "back to runtime tab"
sleep 0.5
POLISH=$(ev "JSON.stringify({
  chipH: [...document.querySelectorAll('.composer-actions .ui-picker-trigger, .composer-actions .config-chip-static')].map(c => Math.round(c.getBoundingClientRect().height)),
  bridgeFlex: [...document.querySelectorAll('.bridge-actions button')].every(b => getComputedStyle(b).display.includes('flex')),
  rowStatusInside: [...document.querySelectorAll('.runtime-row')].every(r => { const s = r.querySelector('.auth-status')?.getBoundingClientRect(); return s ? s.right <= r.getBoundingClientRect().right : true; }),
  hscroll: (() => { const t = document.querySelector('.transcript-c'); return t ? t.scrollWidth > t.clientWidth : false; })()
})" | tr -d '\\')
echo "$POLISH" | grep -q '"bridgeFlex":true' || fail "bridge buttons not flex"
echo "$POLISH" | grep -q '"rowStatusInside":true' || fail "row status overflows row"
for H in $(echo "$POLISH" | sed -E 's/.*"chipH":\[([0-9,]*)\].*/\1/' | tr ',' ' '); do
	[ "$H" -ge 28 ] && [ "$H" -le 32 ] || fail "composer chip wrapped (h=$H)"
done
ok "polish assertions: chips nowrap / bridge flex / no auth overlap"
jsclose
jsclick '关闭设置' >/dev/null
sleep 0.5
jsclose

echo "== runtime 往返切换（UI，fresh 连接）=="
jsclose
[ "$(ev "(() => { const t=document.querySelector('.new-task-button'); if(!t) return 'NO'; t.click(); return 'ok'; })()" | tr -d '"')" = "ok" ] || fail "new task"
sleep 2
openmenu "选择 Runtime" || fail "open runtime menu"
[ "$(jsitem "Codex CLI")" = "ok" ] || fail "click Codex CLI"
sleep 2
B=$(ev "document.querySelector('.runtime-badge')?.textContent")
contains "$B" "Codex" || fail "switch to codex (badge=$B)"
ok "switch pi→codex"
openmenu "选择 Runtime" || fail "open runtime menu 2"
[ "$(jsitem "Pi0")" = "ok" ] || fail "click Pi0"
sleep 2
B=$(ev "document.querySelector('.runtime-badge')?.textContent")
contains "$B" "Pi" || fail "switch back to pi (badge=$B)"
ok "switch codex→pi"

echo "== qoder 任务切模型/思考各一次（UI）=="
[ "$(ev "(() => { const t=document.querySelector('.new-task-button'); if(!t) return 'NO'; t.click(); return 'ok'; })()" | tr -d '"')" = "ok" ] || fail "new task 2"
sleep 2
openmenu "选择 Runtime" || fail "open runtime menu 3"
[ "$(jsitem "Qoder")" = "ok" ] || fail "click Qoder"
sleep 2
openmenu "选择模型" || fail "open model menu"
[ "$(jsitem "Ultimate")" = "ok" ] || fail "click Ultimate"
sleep 2
M=$(ev "[...document.querySelectorAll('button[aria-label=\"选择模型\"]')].map(b=>b.textContent.trim())[0]")
contains "$M" "Ultimate" || fail "model switch (trigger=$M)"
ok "model switch on qoder"
[ "$(jsclick '思考强度')" = "ok" ] || fail "open thinking menu"
sleep 1
STOP=$(agent-browser snapshot -i 2>/dev/null | grep -F 'aria-label="高"' | sed -E 's/.*\[ref=([a-zA-Z0-9]+)\].*/\1/' | head -1)
if [ -n "$STOP" ]; then agent-browser click "@$STOP" >/dev/null; else
	ev "[...document.querySelectorAll('.effort-slider .stop')].find(s=>s.getAttribute('aria-label')==='高')?.click()" >/dev/null
fi
sleep 1
T=$(ev "[...document.querySelectorAll('button[aria-label=\"思考强度\"]')].map(b=>b.textContent.trim())[0]")
contains "$T" "高" || fail "thinking switch (trigger=$T)"
ok "thinking switch on qoder"

echo "== 双 locale 冒烟（Web 形态，lang 参数固定）=="
SP=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['port'])")
ST=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['token'])")
agent-browser open "http://127.0.0.1:$SP/?port=$SP&token=$ST&lang=en" >/dev/null || fail "open en web"
sleep 3
ENSMOKE=$(ev "document.body.textContent")
contains "$ENSMOKE" "New task" || fail "en locale smoke missing 'New task'"
ENARIA=$(ev "document.querySelector('.sidebar-footer [aria-label], nav[aria-label]')?.getAttribute('aria-label') ?? document.querySelector('[aria-label=Settings]')?.getAttribute('aria-label') ?? ''")
contains "$ENARIA" "Settings" || contains "$ENSMOKE" "Thinking:" || fail "en locale smoke missing Settings/Thinking"
agent-browser open "http://127.0.0.1:$SP/?port=$SP&token=$ST&lang=zh" >/dev/null || fail "open zh web"
sleep 3
ZHSMOKE=$(ev "document.body.textContent")
contains "$ZHSMOKE" "新任务" || fail "zh locale smoke missing 新任务"
ZHARIA=$(ev "document.querySelector('[aria-label=设置]')?.getAttribute('aria-label') ?? ''")
contains "$ZHARIA" "设置" || contains "$ZHSMOKE" "思考" || fail "zh locale smoke missing 设置/思考"
ok "dual locale smoke: en + zh key strings visible"

echo "== 四 runtime round-trip（纯 CLI，desktop 可关）=="
for RT in pi codex claude-code qoder; do
	ID=$(run_ev task create --runtime $RT | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") || fail "$RT create"
	run_ev task prompt "$ID" "回复 ok" >/dev/null || fail "$RT prompt"
	OK=""
	for _ in $(seq 1 45); do
		OK=$(run_ev task get "$ID" | python3 -c "import json,sys; d=json.load(sys.stdin); print('REPLY' if any(m['kind']=='assistant' and m['content'] for m in d['messages']) else ('ERR' if d['status']=='error' else 'WAIT'))")
		[ "$OK" = "REPLY" ] && break
		[ "$OK" = "ERR" ] && fail "$RT round-trip error"
		sleep 2
	done
	[ "$OK" = "REPLY" ] || fail "$RT round-trip timeout"
	ok "$RT round-trip"
done

echo "== mobile /m（390×844 独立入口）=="
MPORT=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['port'])")
MTOKEN=$(python3 -c "import json;print(json.load(open('$EV_HOME/server.json'))['token'])")
agent-browser set viewport 390 844 >/dev/null 2>&1 || fail "mobile viewport"
MID=$(run_ev task create --runtime pi | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") || fail "mobile test task"
run_ev task prompt "$MID" "回复 ok" >/dev/null || fail "mobile seed prompt"
sleep 5
agent-browser open "http://127.0.0.1:$MPORT/m/?port=$MPORT&token=$MTOKEN&lang=zh" >/dev/null || fail "mobile open"
sleep 3
MLIST=$(ev "JSON.stringify({rows: document.querySelectorAll('.m-task').length, status: document.querySelector('.m-status')?.textContent ?? ''})" | tr -d '\\')
echo "$MLIST" | grep -q '"rows"' || fail "mobile list missing"
echo "$MLIST" | grep -q 'Pi' || fail "mobile status line missing runtime"
ev "(() => { const r=document.querySelector('[data-task=\"$MID\"]'); if(!r) return 'NO'; r.click(); return 'ok'; })()" | grep -q ok || fail "mobile open detail"
DETAILRDY=""
for _ in $(seq 1 20); do
	DETAILRDY=$(ev "!!document.querySelector('#m-input')")
	contains "$DETAILRDY" true && break
	sleep 0.5
done
contains "$DETAILRDY" true || fail "mobile detail mount"
MDET=$(ev "JSON.stringify({transcript: !!document.querySelector('.m-transcript'), bar: !!document.querySelector('.m-bar'), assistants: document.querySelectorAll('.m-msg.assistant').length})" | tr -d '\\')
echo "$MDET" | grep -q '"transcript":true' || fail "mobile detail missing ($MDET)"
echo "$MDET" | grep -q '"bar":true' || fail "mobile composer missing"
cat >/tmp/ev-golden-ws.ts <<'TS'
const [,, port, token, taskId] = process.argv;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { channel: string; payload: any };
  if (m.channel !== 'tasks:update' || m.payload?.id !== taskId) return;
  const msgs = m.payload.messages ?? [];
  if (msgs.some((x: any) => x.kind === 'user' && String(x.content ?? '').includes('mobile 追问'))) {
    console.log('WS-SYNC-OK');
    process.exit(0);
  }
};
setTimeout(() => { console.log('WS-SYNC-TIMEOUT'); process.exit(1); }, 25000);
TS
bun /tmp/ev-golden-ws.ts "$MPORT" "$MTOKEN" "$MID" >/tmp/ev-golden-ws.out 2>&1 &
WSPID=$!
A0=$(echo "$MDET" | sed 's/^"//; s/"$//' | python3 -c "import json,sys; print(json.load(sys.stdin)['assistants'])")
ev "(() => { const i=document.querySelector('#m-input'); i.value='mobile 追问'; document.querySelector('[data-send]').click(); return 'ok'; })()" | grep -q ok || fail "mobile send"
BUBBLE=""
for _ in $(seq 1 10); do
	BUBBLE=$(ev "[...document.querySelectorAll('.m-msg.user')].some(m => m.textContent.includes('mobile 追问'))")
	contains "$BUBBLE" true && break
	sleep 1
done
contains "$BUBBLE" true || fail "mobile user bubble"
MREPLY="$A0"
for _ in $(seq 1 30); do
	MREPLY=$(ev "document.querySelectorAll('.m-msg.assistant').length")
	[ "${MREPLY:-0}" -gt "$A0" ] 2>/dev/null && break
	sleep 2
done
[ "${MREPLY:-0}" -gt "$A0" ] || fail "mobile live assistant reply missing"
ev "document.querySelector('[data-sheet=model]').click()" >/dev/null
sleep 0.5
MSHEET=$(ev "document.querySelectorAll('.m-sheet-item').length")
[ "${MSHEET:-0}" -ge 1 ] || fail "mobile model sheet empty"
ev "document.querySelector('.m-sheet-item')?.click()" >/dev/null
sleep 0.5
ev "!document.querySelector('.m-sheet')" | grep -q true || fail "mobile sheet not closed"
WSOK=""
for _ in $(seq 1 10); do
	WSOK=$(cat /tmp/ev-golden-ws.out 2>/dev/null)
	contains "$WSOK" WS-SYNC-OK && break
	sleep 1
done
kill "$WSPID" 2>/dev/null
contains "$WSOK" WS-SYNC-OK || fail "second client WS sync missing ($WSOK)"
agent-browser open "http://127.0.0.1:$MPORT/m/?port=$MPORT&token=$MTOKEN&lang=en" >/dev/null || fail "mobile en open"
sleep 3
MEN=$(ev "document.querySelector('.m-status')?.textContent ?? ''")
contains "$MEN" "Available" || fail "mobile en status line missing 'Available'"
ok "mobile /m: list→detail→send(WS 上屏)→live reply→model sheet→第二客户端同步→en 冒烟"

echo "== 清理测试任务 =="
run_ev task list >/tmp/ev-golden-tasks.json 2>/dev/null || true
python3 - "$RUN_START_MS" /tmp/ev-golden-cleanup.txt <<'PY'
import json, sys
start = int(sys.argv[1])
try:
    ts = json.load(open('/tmp/ev-golden-tasks.json'))
except Exception:
    ts = []
ids = [t['id'] for t in ts if t['createdAt'] >= start and t['title'] in ('回复 ok', '新任务', 'New task')]
open(sys.argv[2], 'w').write('\n'.join(ids))
PY
while read id; do [ -n "$id" ] && run_ev task remove "$id" >/dev/null 2>&1; done </tmp/ev-golden-cleanup.txt

echo "== ALL GOLDEN PASSED =="
exit 0
