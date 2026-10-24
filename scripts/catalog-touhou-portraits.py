"""Refresh portrait metadata ONLY; never downloads or commits image bytes.
Run: python3 scripts/catalog-touhou-portraits.py
THBWiki file categories verify original-game portraits and their credited artist.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
API = 'https://thwiki.cc/api.php'
HEADERS = {'User-Agent': 'CharacterSocialAquarium/0.1 (optional portrait catalog metadata)'}
TWILIGHT = ['非想天则', '绯想天', '萃梦想', '心绮楼', '深秘录凭依华', '凭依华', '刚欲异闻']
ZUN = ['锦上京', '兽王园', '虹龙洞', '鬼形兽', '天空璋', '绀珠传', '辉针城', '神灵庙', '星莲船', '地灵殿', '风神录', '花映塚', '永夜抄', '妖妖梦', '红魔乡', '文花帖DS', '天邪鬼', '黑市', '噩梦日记']
OLD = ['怪绮谈', '幻想乡', '梦时空', '封魔录', '灵异传']
PAGE_ALIASES = {'lake-fairy': '大妖精', 'library-devil': '小恶魔', 'reisen-moon': '铃仙', 'old-reimu': '灵梦', 'old-marisa': '魔理沙', 'old-yuuka': '幽香', 'old-alice': '爱丽丝'}
FILE_NAMES = {'tewi': '因幡帝', 'suwako': '洩矢诹访子', 'eiki': '四季映姬', 'yuugenmagan': '幽幻魔眼', 'elis': '依莉丝', 'sariel': '萨丽艾尔', 'old-reimu': '博丽灵梦', 'old-marisa': '雾雨魔理沙', 'old-yuuka': '幽香', 'old-alice': '爱丽丝'}
EXTRA = {'old-reimu': ['博丽灵梦1（怪绮谈立绘）.png', '博丽灵梦（封魔录立绘）.png'], 'old-marisa': ['雾雨魔理沙1（怪绮谈立绘）.png', '雾雨魔理沙（梦时空立绘）.png'], 'old-alice': ['爱丽丝1（怪绮谈立绘）.png', '爱丽丝2（怪绮谈立绘）.png'], 'kurumi': ['胡桃（幻想乡立绘）.png']}

def api(params):
    url = API + '?' + urllib.parse.urlencode({'format': 'json', **params})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25) as response:
                return json.load(response)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def people():
    rows = []
    for filename in ['touhou-characters.ts', 'touhou-legacy.ts']:
        text = (ROOT / 'src/data/presets' / filename).read_text()
        for key, name in re.findall(r"\bp\(\s*'([^']+)'\s*,\s*'([^']+)'", text):
            rows.append((key, name, 'pc98' if filename.endswith('legacy.ts') else 'windows'))
    return rows

def discover(row):
    key, name, continuity = row
    pages = api({'action': 'query', 'prop': 'images', 'titles': PAGE_ALIASES.get(key, name), 'imlimit': 'max', 'redirects': 1})['query']['pages']
    files = [image['title'] for page in pages.values() for image in page.get('images', [])]
    files.extend('文件:' + title for title in EXTRA.get(key, []))
    identity = FILE_NAMES.get(key, name)
    valid = []
    for title in set(files):
        if '立绘' not in title or '&' in title or '＆' in title or '（' not in title:
            continue
        prefix = title.removeprefix('文件:').split('（')[0]
        prefix = re.sub(r'(?:[12AB]|EX|ex)$', '', prefix)
        if prefix != identity:
            continue
        works = OLD if continuity == 'pc98' else TWILIGHT + ZUN
        work = next((work for work in works if work in title), None)
        if work:
            valid.append((title, work))
    rank = lambda pair: ((OLD if continuity == 'pc98' else TWILIGHT + ZUN).index(pair[1]), len(pair[0]), pair[0])
    return row, sorted(valid, key=rank)

def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        discoveries = list(executor.map(discover, people()))
    titles = sorted({title for _, files in discoveries for title, _ in files})
    images = {}
    for start in range(0, len(titles), 20):
        result = api({'action':'query', 'titles':'|'.join(titles[start:start+20]), 'prop':'imageinfo|categories', 'iiprop':'url|size|mime', 'iiurlwidth':256, 'cllimit':'max'})
        images.update({p['title']: p for p in result['query']['pages'].values()})
        print(f'Checked image metadata {min(start+20,len(titles))}/{len(titles)}', flush=True)
    output = []
    for (key, name, continuity), files in discoveries:
        candidates = []
        for title, work in files:
            image = images.get(title, {})
            categories = {c['title'] for c in image.get('categories', [])}
            if '分类:官方游戏立绘' not in categories or not image.get('imageinfo'):
                continue
            artist = next((a for a in ['Alphes', '春河萌', 'TOKIAME', 'ZUN'] if f'分类:{a}绘' in categories), None)
            if not artist or (work in TWILIGHT and artist == 'ZUN') or (work not in TWILIGHT and artist != 'ZUN'):
                continue
            info = image['imageinfo'][0]
            url = info.get('thumburl', info['url'])
            if urllib.parse.urlparse(url).hostname not in ['upload.thwiki.cc', 'upload.thbwiki.cc']:
                raise ValueError('Unexpected asset host')
            candidates.append({'id':hashlib.sha256(title.encode()).hexdigest()[:20], 'kind':'twilight' if work in TWILIGHT else 'zun', 'work':work, 'artist':'alphes' if artist == 'Alphes' else artist, 'fileTitle':title, 'sourcePage':info['descriptionurl'], 'url':url, 'bytes':info['size']})
        # Prefer two Twilight options, but always retain a ZUN fallback when one exists.
        twilight = [c for c in candidates if c['kind'] == 'twilight']
        zun = [c for c in candidates if c['kind'] == 'zun']
        chosen = (twilight[:2] + zun[:1]) if twilight else zun[:2]
        entry = {'characterId':'th:'+key,'name':name,'continuity':continuity,'candidates':chosen}
        if not chosen:
            entry['missingReason'] = '未找到可确认的黄昏作品或 ZUN 单人立绘；保留默认头像，不挪用他人形象或同人图。'
            if key in ['sunny','luna','star']:
                entry['missingReason'] = '妖精大战争立绘为比良坂真琴绘，不冒充黄昏绘或 ZUN 绘；可自行上传。'
        output.append(entry)
    path = ROOT / 'src/data/presets/touhou-portraits.json'
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'total':len(output), 'twilight':sum(bool(e['candidates']) and e['candidates'][0]['kind']=='twilight' for e in output), 'zun':sum(bool(e['candidates']) and e['candidates'][0]['kind']=='zun' for e in output), 'missing':[e['name'] for e in output if not e['candidates']]}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
