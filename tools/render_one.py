import sys, os, pathlib
# 사용법: npm i mermaid@11 (tools/ 에서) 후 python3 tools/render_one.py 01_deploy
# 입력: docs/diagrams/mermaid/<name>.mmd  출력: docs/diagrams/png/<name>.png
ROOT = pathlib.Path(__file__).resolve().parent
PAGE = ROOT / 'page.html'
PAGE.write_text('<html><head><style>body{margin:0;background:#fff}</style><script src="node_modules/mermaid/dist/mermaid.min.js"></script></head><body><div id="c" style="display:inline-block;padding:16px"></div></body></html>')
from playwright.sync_api import sync_playwright
name=sys.argv[1]; d=open(ROOT.parent/'docs'/'diagrams'/'mermaid'/f'{name}.mmd').read()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1600,'height':1200},device_scale_factor=4)
    pg.goto(PAGE.as_uri())
    pg.evaluate("""mermaid.initialize({startOnLoad:false,theme:'base',fontFamily:'Noto Sans CJK KR',
      themeVariables:{fontFamily:'Noto Sans CJK KR',fontSize:'18px',actorBkg:'#EFF6F2',actorBorder:'#7DB596',signalColor:'#1C2430',labelBoxBkgColor:'#EFF6F2',labelBoxBorderColor:'#7DB596',primaryColor:'#F3F0FD',primaryBorderColor:'#A99BE6',primaryTextColor:'#1C2430',lineColor:'#7C8896',secondaryColor:'#EFF6F2',tertiaryColor:'#F6F8FA'},
      flowchart:{useMaxWidth:false,htmlLabels:true,nodeSpacing:40,rankSpacing:50,padding:16,wrappingWidth:600},state:{useMaxWidth:false},sequence:{useMaxWidth:false,mirrorActors:false,messageFontSize:21,actorFontSize:20,noteFontSize:18,actorMargin:36,messageMargin:44,width:150,boxMargin:10,wrap:false}})""")
    pg.evaluate("async (d)=>{const r=await mermaid.render('g1',d);document.getElementById('c').innerHTML=r.svg}",d)
    pg.wait_for_timeout(400)
    pg.locator('#c').screenshot(path=str(ROOT.parent/'docs'/'diagrams'/'png'/f'{name}.png')); b.close()
