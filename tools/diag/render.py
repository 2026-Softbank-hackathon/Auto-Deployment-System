import sys, asyncio
from playwright.async_api import async_playwright

async def main(html, png, scale):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(device_scale_factor=scale)
        await pg.goto(f"file://{html}")
        await pg.wait_for_timeout(600)
        vb = await pg.evaluate("document.querySelector('svg').viewBox.baseVal.width + ',' + document.querySelector('svg').viewBox.baseVal.height")
        w, h = [float(v) for v in vb.split(",")]
        await pg.set_viewport_size({"width": int(w), "height": int(h)})
        await pg.add_style_tag(content="svg{min-width:0!important;max-width:none!important}")
        await pg.wait_for_timeout(300)
        bad = await pg.evaluate("""() => [...document.querySelectorAll('text[data-fit]')].map(t => {
            const b = t.getBBox(); const f = +t.dataset.fit;
            return (b.x + b.width > f + 0.5) ? `${t.textContent} :: over by ${(b.x+b.width-f).toFixed(0)}px` : null }).filter(Boolean)""")
        fam = await pg.evaluate("document.fonts.check('16px \"IBM Plex Sans KR\"')")
        print("plex loaded:", fam)
        for x in bad: print("OVERFLOW", x)
        el = await pg.query_selector("svg")
        await el.screenshot(path=png)
        await b.close()

asyncio.run(main(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 2))
