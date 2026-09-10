"""UI integration against real Node core via stdio, without HTTP or Electron.
Requires Python + Playwright and a Chromium executable. Does not contact APIs.
Usage: python scripts/ui-test.py [repo-path]
"""
import asyncio, json, os, re, shutil, sys, tempfile
from pathlib import Path
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[1]

async def main():
    owned = len(sys.argv) < 2
    repo = Path(tempfile.mkdtemp(prefix='neo-ui-')) if owned else Path(sys.argv[1])
    proc = await asyncio.create_subprocess_exec('node', str(ROOT/'scripts/ui-bridge.mjs'),str(repo),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,limit=8_388_608)
    lock=asyncio.Lock()
    async def rpc(method,payload):
        async with lock:
            proc.stdin.write((json.dumps({'method':method,'payload':payload})+'\n').encode());await proc.stdin.drain()
            raw=await proc.stdout.readline()
            if not raw: raise RuntimeError((await proc.stderr.read()).decode())
            result=json.loads(raw)
            if not result['ok']: raise RuntimeError(result['error'])
            return result['value']
    errors=[]
    try:
        async with async_playwright() as p:
            browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH',shutil.which('chromium') or shutil.which('google-chrome')),headless=True,args=['--no-sandbox'])
            page=await browser.new_page(viewport={'width':1320,'height':980},device_scale_factor=1)
            page.on('pageerror',lambda e:errors.append(str(e)))
            await page.expose_function('neoRPC',rpc)
            async def mount():
                # Mount local files in memory because the sandbox Chromium blocks file navigation.
                # The production CSP is removed from this test document only. This is not an
                # Electron security-boundary test; app files on disk remain unchanged.
                await page.goto('about:blank')
                html=(ROOT/'src/ui/index.html').read_text(encoding='utf-8')
                html=re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', '', html)
                html=re.sub(r'<link rel="stylesheet"[^>]*>', '', html)
                html=re.sub(r'<script defer[^>]*></script>', '', html)
                await page.set_content(html)
                await page.add_style_tag(content=(ROOT/'src/ui/app.css').read_text(encoding='utf-8'))
                await page.add_style_tag(content=(ROOT/'src/ui/detail.css').read_text(encoding='utf-8'))
                await page.evaluate("window.neo={call:(m,p={})=>window.neoRPC(m,p),onChanged:()=>()=>{}};")
                await page.add_script_tag(content=(ROOT/'src/ui/app.js').read_text(encoding='utf-8'))
            await mount()
            await page.wait_for_function("document.getElementById('footerStatus').textContent.includes('git')")
            await page.wait_for_timeout(500)
            if not owned:
                await page.screenshot(path=str(ROOT/'docs/screenshot-library.png'),full_page=True)
            before=await page.locator('.card').count()
            await page.locator('#addButton').click()
            await page.locator('#captureInput').fill('https://example.com/ui-integration UIテスト')
            await page.locator('#captureNote').fill('保存の理由：検証固有境界の表現')
            await page.locator('#captureForm button[type=submit]').click()
            await page.wait_for_function(f"document.querySelectorAll('.card').length === {before+1}")
            print('PASS UI capture -> real Markdown + Git')
            await page.locator('#search').fill('検証固有境界')
            await page.wait_for_function("document.querySelectorAll('.card').length===1")
            await page.locator('.card').click()
            await page.locator('#newMemoEntry').fill('履歴の最初のメモ')
            await page.locator('#appendMemo').click()
            await page.wait_for_function("document.querySelectorAll('.memo-entry').length===1")
            first_entry=page.locator('.memo-entry').first
            await first_entry.locator('summary').click()
            assert await first_entry.locator('.memo-entry-preview').is_visible()
            await first_entry.locator('summary').click()
            await first_entry.get_by_role('button',name='編集する').click()
            await first_entry.locator('textarea').fill('履歴の最初のメモ。<img src=x onerror="window.injected=true">')
            await first_entry.get_by_role('button',name='このメモを保存').click()
            await page.locator('#newMemoEntry').fill('あとから追加した二回目のメモ')
            await page.locator('#appendMemo').click()
            await page.wait_for_function("document.querySelectorAll('.memo-entry').length===2")
            await page.locator('#detailTitle').fill('テスト用タイトル')
            await page.locator('#detailTags').fill('テスト, 光学')
            await page.locator('#saveDetail').click()
            await page.wait_for_function("document.getElementById('detailSaveStatus').textContent.includes('保存しました')")
            if not owned:
                await page.screenshot(path=str(ROOT/'docs/screenshot-detail.png'),full_page=True)
            await page.locator('[data-close=detailDialog]').click()
            await page.locator('#search').fill('二回目 光学')
            await page.wait_for_function("document.querySelectorAll('.card').length===1")
            assert not await page.evaluate('Boolean(window.injected)')
            print('PASS memo history append/edit, Japanese search, preview toggle, literal HTML/XSS isolation')
            await page.locator('#addButton').click()
            await page.locator('#captureInput').fill('https://example.com/ui-integration?utm_source=repeat')
            await page.locator('#captureNote').fill('二回目の理由')
            await page.locator('#captureForm button[type=submit]').click()
            await page.wait_for_timeout(350)
            await page.locator('#search').fill('二回目')
            await page.wait_for_function("document.querySelectorAll('.card').length===1")
            await page.locator('.card').click()
            await page.wait_for_function("document.querySelectorAll('.capture-entry').length===2")
            print('PASS duplicate card -> append reason, not new item')
            await page.locator('#archiveButton').click()
            await page.wait_for_function("!document.getElementById('detailDialog').open")
            await page.locator('#search').fill('')
            await page.locator('#archiveNav').click()
            await page.wait_for_function("document.querySelectorAll('.card').length===1")
            await mount()
            await page.wait_for_function("document.getElementById('footerStatus').textContent.includes('git')")
            await page.locator('#archiveNav').click()
            await page.wait_for_function("document.querySelectorAll('.card').length===1")
            print('PASS archive + restart persistence')
            await page.locator('#settingsButton').click()
            await page.locator('#slackChannels').fill('C123456789')
            await page.locator('#settingsForm button[type=submit]').click()
            await page.wait_for_timeout(250)
            assert await page.locator('#slackChannels').input_value()=='C123456789'
            print('PASS settings UI')
            await page.locator('[data-close=settingsDialog]').click()
            await page.set_viewport_size({'width':900,'height':760})
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            print('PASS 900px viewport, no horizontal page overflow')
            assert not errors,errors
            print('PASS no browser JavaScript errors')
            await browser.close()
    finally:
        if proc.stdin:proc.stdin.close()
        await proc.wait()
        if owned:shutil.rmtree(repo,ignore_errors=True)

asyncio.run(main())
