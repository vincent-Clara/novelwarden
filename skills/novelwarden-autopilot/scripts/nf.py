"""Novelwarden 自動駕駛：經 drv.mjs 的狀態目錄操作獨立版服務。

前提：drv.mjs 已在後臺跑著（同一個 --state）。所有子命令只讀寫狀態目錄裡的檔案，
真正的收發由 drv.mjs 完成。

  python nf.py [--state DIR] status
  python nf.py send '<json>'                  # 原樣發一條 InMessage
  python nf.py answer [proceed|skip]          # 回答全部未決的彈窗 / 許可權卡片
  python nf.py next                           # 按一下主按鈕（發 pipeline.next 那一步）
  python nf.py idea "一句話" [--chapters 100] [--words 3000]
  python nf.py settings                       # 工程頁「補齊架構」：前提 / 角色圖譜 / 世界觀
  python nf.py outline                        # 情節大綱一段段續寫，直到覆蓋全書
  python nf.py plots [--from 1] [--to N]      # 工程頁「批次拆細綱」
  python nf.py write [--to N] [--review]      # 批次寫章（寫完即同步），停了就補、接著下一批
  python nf.py wait                           # 等工程頁的長任務跑完
"""
import argparse, json, os, re, sys, time

STATE = None
MODEL = None


def P(f):
    return os.path.join(STATE, f)


def load(f, dflt=None):
    try:
        with open(P(f), encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return dflt


def send(m):
    with open(P('cmd.jsonl'), 'a', encoding='utf8') as fh:
        fh.write(json.dumps(m, ensure_ascii=False) + '\n')


def say(*a):
    print(time.strftime('%X'), *a, flush=True)


def project_root():
    ws = load('last-workspaces.json') or {}
    root = ws.get('currentId')
    if not root:
        sys.exit('服務裡沒有開啟的工程：先在網頁裡開啟資料夾，或 send {"type":"openFolder","path":"..."}')
    return root


META_DIRS = ('.novelwarden', '.novelforge', '.novel')


def meta_dir(root):
    """新工程用 .novelwarden/；舊工程的 .novelforge/、更早的 .novel/ 繼續認。"""
    for name in META_DIRS:
        p = os.path.join(root, name)
        if os.path.isdir(p):
            return p
    return os.path.join(root, '.novelwarden')


def nf(*parts):
    return os.path.join(meta_dir(project_root()), *parts)


def config_path():
    """全域性配置：新裝 ~/.novelwarden/，舊機器 ~/.novelforge/ 繼續 fallback。"""
    for p in (os.path.expanduser('~/.novelwarden/config.json'), os.path.expanduser('~/.novelforge/config.json')):
        if os.path.isfile(p):
            return p
    return os.path.expanduser('~/.novelwarden/config.json')


def book_config():
    """config.md 的 frontmatter：totalChapters / wordsPerChapter。"""
    try:
        text = open(nf('config.md'), encoding='utf8').read()
    except OSError:
        return {}
    m = re.match(r'---\n(.*?)\n---', text, re.S)
    out = {}
    for line in (m.group(1).splitlines() if m else []):
        k, _, v = line.partition(':')
        if v.strip().isdigit():
            out[k.strip()] = int(v.strip())
    return out


def chapters_dir():
    # 章節根預設 chapters/；設定裡改過的話以 ~/.novelwarden/config.json 的 chaptersDir 為準。
    cfg = {}
    try:
        cfg = json.load(open(config_path(), encoding='utf8'))
    except Exception:
        pass
    return os.path.join(project_root(), cfg.get('chaptersDir') or 'chapters')


def numbered_files(root, pattern):
    """`root` 下各級子目錄裡檔名匹配 `pattern` 的檔案，按章號再按路徑排，給出相對 `root` 的路徑（正斜槓）。
    分卷的書章節在卷目錄裡，細綱映象正文的相對路徑也在同名的卷目錄裡。"""
    out = []
    for cur, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for name in files:
            if re.match(pattern, name):
                out.append(os.path.relpath(os.path.join(cur, name), root).replace('\\', '/'))
    return sorted(out, key=lambda r: (int(re.match(r'\d+', os.path.basename(r)).group()), r))


def chapter_files():
    d = chapters_dir()
    return numbered_files(d, r'\d+') if os.path.isdir(d) else []


def chapter_no(rel):
    return int(re.match(r'\d+', os.path.basename(rel)).group())


def next_chapter_no():
    nos = {chapter_no(f) for f in chapter_files()}
    n = 1
    while n in nos:
        n += 1
    return n


def plot_files():
    """細綱：`summaries/` 下各級子目錄裡數字開頭的 .md，一章一份（根下的 `global.md` 是全書摘要，不算）。"""
    d = nf('summaries')
    return numbered_files(d, r'\d+.*\.md$') if os.path.isdir(d) else []


def plot_of(chapter_file):
    """這一章的細綱：映象正文在章節根下的相對路徑，副檔名換成 .md（`第一卷/003-深處.txt` → `第一卷/003-深處.md`）。
    還沒有就是 None。"""
    rel = os.path.splitext(chapter_file)[0] + '.md'
    return rel if os.path.isfile(nf('summaries', rel)) else None


def finalized(chapter_file):
    """這一章同步過沒有：它映象的那份細綱的 frontmatter 裡記了 `sourceHash`（同步時記的正文指紋）。
    細綱拆好之後檔案就在，不能拿「檔案在不在」判斷。這裡也不核對正文後來改沒改——那要復刻
    服務端的 contentHash；批次寫章停下來的那幾章都是從沒同步過的，這一條就夠用。"""
    plot = plot_of(chapter_file)
    if not plot:
        return False
    head = open(nf('summaries', plot), encoding='utf8', errors='replace').read(2000)
    m = re.match(r'^---\n(.*?)\n---', head, re.S)
    return bool(m and re.search(r'^sourceHash:\s*\S', m.group(1), re.M))


def outline_coverage():
    """情節大綱覆蓋到第幾章。磁碟上沒有 outline.md：大綱是各章細綱「梗概」的彙總，覆蓋到的就是梗概非空的最大章號。"""
    best = 0
    for dirpath, _, files in os.walk(nf('summaries')):
        for name in files:
            m = re.match(r'^(\d{1,5})[-_.\s]*.*\.(md|markdown)$', name, re.I)
            if not m or int(m.group(1)) <= best:
                continue
            text = open(os.path.join(dirpath, name), encoding='utf8', errors='replace').read()
            body = re.search(r'^#{2,3}\s*梗概\s*\n(.*?)(?=^#{1,3}\s|\Z)', text, re.M | re.S)
            synopsis = body.group(1).strip() if body else ''
            if synopsis and synopsis not in ('（待補充）', '(待補充)'):
                best = int(m.group(1))
    return best


def char_count(path):
    text = open(path, encoding='utf8', errors='replace').read()
    text = re.sub(r'^---\n.*?\n---\n', '', text, flags=re.S)
    return len(re.sub(r'\s', '', text))


# ---- 等待與回答 ----

def answer_all(verdict='proceed', log_only_types=()):
    """回答全部未決：gate→verdict；confirm→第一顆按鈕（skip 時取消；模型與詳細度照預設）；pick→第一項；input→取消。"""
    n = 0
    for p in load('pending.json', []):
        brief = (p.get('message') or '') + ' ' + (p.get('detail') or p.get('value') or '')
        say('answer', p['type'], p.get('title'), '|', brief.replace('\n', ' ')[:300])
        if p['type'] == 'gate':
            send({'type': 'gateResult', 'requestId': p['requestId'], 'verdict': verdict})
        elif p['kind'] == 'confirm':
            first = (p.get('actions') or ['確定'])[0]
            send({'type': 'promptResult', 'requestId': p['requestId'], **({'value': first} if verdict == 'proceed' else {})})
        elif p['kind'] == 'pick' and verdict == 'proceed':
            send({'type': 'promptResult', 'requestId': p['requestId'], 'value': (p.get('options') or [''])[0]})
        elif p['kind'] == 'merge' and verdict == 'proceed':
            # 合併檢視（覆蓋審閱、刪修飾的逐段對照）：原樣採用新版。
            send({'type': 'promptResult', 'requestId': p['requestId'], 'value': json.dumps({'verdict': 'apply'})})
        else:
            send({'type': 'promptResult', 'requestId': p['requestId']})
        n += 1
        time.sleep(1.5)
    return n


def wait_pending(timeout=900):
    """發了一次對話頁生成之後，等那張「寫入」卡片出來。卡片出不來（生成失敗）就在 busy 落回 false 後返回。"""
    t0 = time.time()
    time.sleep(5)
    while time.time() - t0 < timeout:
        if load('pending.json', []):
            return True
        if load('busy.json') is False and time.time() - t0 > 15:
            time.sleep(3)
            return bool(load('pending.json', []))
        time.sleep(3)
    return False


def wait_tasks(auto=True, idle_rounds=3):
    """等工程頁長任務跑完；途中的彈窗自動答「繼續」。"""
    idle = 0
    while idle < idle_rounds:
        if auto:
            answer_all()
        if load('tasks.json', []):
            t = load('tasks.json')[0]
            idle = 0
            sys.stdout.write(f"\r  {t.get('title')} {t.get('current')}/{t.get('total')} {t.get('message','')[:60]}   ")
            sys.stdout.flush()
            time.sleep(10)
        else:
            idle += 1
            time.sleep(4)
    print()


def select_model():
    if MODEL:
        send({'type': 'selectModel', 'ref': MODEL})
        time.sleep(1.5)


def chat_generate(payload, verdict='proceed'):
    """對話頁的一次單步生成：發出去、等卡片、點寫入。返回是否寫入了。"""
    send({'type': 'switchTab', 'tab': 'chat'})
    send({'type': 'send', 'payload': {'text': '', 'attachments': [], 'excludedIds': [], **payload}})
    if not wait_pending():
        say('沒等到寫入卡片（生成失敗？看 log.txt）')
        return False
    answer_all(verdict)
    time.sleep(4)
    return True


# ---- 子命令 ----

def cmd_status(a):
    ws = load('last-workspaces.json') or {}
    st = (load('last-settings.json') or {}).get('settings')
    if not st:
        # 服務只在切到設定頁時推 settings；沒推過就直接讀全域性配置（不碰 secrets.json）。
        try:
            st = json.load(open(config_path(), encoding='utf8'))
        except Exception:
            st = {}
    nxt = (load('last-pipeline.json') or {}).get('next')
    print('工程    ', ws.get('currentId'))
    print('預設模型', st.get('model'), '| 模型池', st.get('models'), '| 分檔', st.get('tierModels'))
    print('下一步  ', nxt and nxt.get('label'))
    print('長任務  ', [(t['title'], t.get('message')) for t in load('tasks.json', [])])
    print('未決    ', [(p['type'], p.get('title')) for p in load('pending.json', [])])
    if ws.get('currentId'):
        cfg = book_config()
        fs = chapter_files()
        print('全書    ', cfg, '大綱覆蓋到第', outline_coverage(), '章')
        print('細綱    ', len(plot_files()), '份')
        print('正文    ', len(fs), '章；未同步', [f for f in fs if not finalized(f)][:20])


def cmd_send(a):
    send(json.loads(a.json))


def cmd_answer(a):
    print('answered', answer_all(a.verdict))


def cmd_next(a):
    s = (load('last-pipeline.json') or {}).get('next')
    if not s:
        sys.exit('沒有下一步')
    if s.get('form') == 'idea':
        sys.exit('下一步是「從一句話生成小說配置」：用 idea 子命令')
    if s.get('projectAction'):
        send({'type': 'projectAction', 'action': s['projectAction'], 'relPath': (s.get('target') or {}).get('plotRelPath')})
    else:
        send({'type': 'send', 'payload': {'text': '', 'stage': s['stage'], 'capability': s['capability'], 'target': s.get('target'),
              'targetNo': s.get('no') or (s.get('range') or {}).get('from') or 1, 'range': s.get('range'),
              'writeMode': s.get('writeMode'), 'attachments': [], 'excludedIds': []}})
    say('pressed:', s['label'])


def cmd_idea(a):
    select_model()
    ok = chat_generate({'text': a.text, 'stage': 'setting', 'capability': 'generate',
                        'target': {'kind': 'setting', 'doc': 'config'}, 'targetNo': 1,
                        'setup': {'totalChapters': a.chapters, 'wordsPerChapter': a.words}})
    say('小說配置', '已寫入' if ok else '未寫入')


def cmd_settings(a):
    select_model()
    send({'type': 'switchTab', 'tab': 'project'})
    send({'type': 'projectAction', 'action': 'completeSettings'})
    time.sleep(5)
    wait_tasks()
    say('補齊架構完成；角色卡：', os.listdir(nf('characters')))


def cmd_outline(a):
    select_model()
    total = book_config().get('totalChapters') or sys.exit('config.md 裡沒有 totalChapters')
    while True:
        cov = outline_coverage()
        if cov >= total:
            say('情節大綱已覆蓋到第', cov, '章')
            return
        lo, hi = cov + 1, min(cov + a.batch, total)
        say('生成情節大綱', lo, '-', hi)
        if not chat_generate({'stage': 'outline', 'capability': 'generate', 'target': {'kind': 'outline'},
                              'targetNo': lo, 'range': {'from': lo, 'to': hi}}):
            sys.exit('大綱這一段沒寫進去，停下')
        if outline_coverage() <= cov:
            sys.exit(f'寫入之後覆蓋沒往前走（還是第 {cov} 章），停下看工程頁的情節大綱')


def cmd_plots(a):
    select_model()
    total = a.to or book_config().get('totalChapters') or outline_coverage()
    send({'type': 'switchTab', 'tab': 'project'})
    # call：彈窗已經問過（模型按分檔、詳細度照設定），後端不再彈確認框。
    send({'type': 'projectAction', 'action': 'generatePlots', 'range': {'from': a.from_, 'to': total}, 'call': {}})
    time.sleep(5)
    wait_tasks()
    say('細綱', len(plot_files()), '份')


def cmd_write(a):
    """批次寫章的外層迴圈。批次一次最多 10 章，並且會在三種情況下停：人物提前登場、沒寫夠八成、重演。
    停下的那一章已經落盤但沒同步——這裡先補（字數不夠就「接著寫」一次），再同步，再起下一批。"""
    select_model()
    cfg = book_config()
    total = a.to or cfg.get('totalChapters') or sys.exit('config.md 裡沒有 totalChapters')
    floor = int((cfg.get('wordsPerChapter') or 3000) * 0.8)
    tried = set()
    send({'type': 'switchTab', 'tab': 'project'})
    while True:
        answer_all()
        if load('tasks.json', []):
            wait_tasks()
            continue
        unfin = [f for f in chapter_files() if not finalized(f)]
        if unfin:
            f = unfin[0]
            wc = char_count(os.path.join(chapters_dir(), f))
            if wc < floor and f not in tried:
                tried.add(f)
                plot = plot_of(f)
                say('接著寫', f, wc, '字')
                if plot:
                    plot_rel = os.path.relpath(os.path.join(meta_dir(project_root()), 'summaries', plot), project_root()).replace('\\', '/')
                    send({'type': 'chapterAction', 'plotRelPath': plot_rel, 'action': 'continue'})
                    if wait_pending():
                        answer_all()
                        time.sleep(4)
                send({'type': 'switchTab', 'tab': 'project'})
                continue
            say('同步', f, wc, '字')
            send({'type': 'projectAction', 'action': 'finalizeChapter', 'relPath': os.path.relpath(os.path.join(chapters_dir(), f), project_root()).replace('\\', '/')})
            time.sleep(8)
            wait_tasks()
            if not finalized(f):
                time.sleep(15)
                if not finalized(f):
                    sys.exit(f'{f} 同步沒成，停下看 log.txt')
            continue
        n = next_chapter_no()
        if n > total:
            say('全部', total, '章已寫完並同步')
            return
        hi = min(n + 9, total)
        say('批次寫章', n, '-', hi)
        send({'type': 'projectAction', 'action': 'writeManuscripts', 'range': {'from': n, 'to': hi},
              'call': {}, 'mode': 'finalize', 'review': bool(a.review)})
        time.sleep(10)
        wait_tasks()
        if next_chapter_no() == n and not [f for f in chapter_files() if not finalized(f)]:
            sys.exit(f'第 {n} 章這一批什麼都沒寫出來，停下看 log.txt')


def cmd_wait(a):
    wait_tasks()


def main():
    global STATE, MODEL
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', default=os.environ.get('NF_STATE', os.path.join(os.getcwd(), 'nf-state')))
    ap.add_argument('--model', default=os.environ.get('NF_MODEL'), help='每個階段開始前 selectModel 一次')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status')
    s = sub.add_parser('send'); s.add_argument('json')
    s = sub.add_parser('answer'); s.add_argument('verdict', nargs='?', default='proceed', choices=['proceed', 'skip'])
    sub.add_parser('next')
    s = sub.add_parser('idea'); s.add_argument('text'); s.add_argument('--chapters', type=int, default=100); s.add_argument('--words', type=int, default=3000)
    sub.add_parser('settings')
    s = sub.add_parser('outline'); s.add_argument('--batch', type=int, default=20)
    s = sub.add_parser('plots'); s.add_argument('--from', dest='from_', type=int, default=1); s.add_argument('--to', type=int)
    s = sub.add_parser('write'); s.add_argument('--to', type=int); s.add_argument('--review', action='store_true')
    sub.add_parser('wait')
    a = ap.parse_args()
    STATE = os.path.abspath(a.state)
    MODEL = a.model
    if not os.path.exists(P('pending.json')):
        sys.exit(f'{STATE} 裡沒有 drv.mjs 的狀態：先在後臺跑 node drv.mjs --state {STATE}')
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
