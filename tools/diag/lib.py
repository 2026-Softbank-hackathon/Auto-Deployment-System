"""Shared SVG helpers for the v3-style architecture diagrams."""
from html import escape

CSS = """
:root{--bg:#F6F8FA;--card:#FFFFFF;--line:#D5DBE3;--text:#1C2430;--muted:#5E6B7A;--edge:#7C8896;
--cp-fill:#EFF6F2;--cp-line:#7DB596;--cp-text:#2F7A55;--pool:#9AA7B5;
--ag-fill:#F3F0FD;--ag-line:#A99BE6;--async:#7B61D9;--prov:#D9731A;--user:#2F6FD1;
--pg-f:#EEF3FB;--pg-l:#BCCDEA;--rd-f:#FCEFEE;--rd-l:#EBC0BB;--ob-f:#F2F4F6;--ob-l:#D2D8DF;--vt-f:#FBF4E6;--vt-l:#E4CC9C;--ai-f:#F3F0FD;--ai-l:#CFC5F1;--rg-f:#EEF6F1;--rg-l:#BCDAC8;
--on:#5B6B7F;--obs:#1F9E89;--obs-f:#EAF6F4;--obs-l:#9FD3C8;--aws:#E07A1F;--gcp:#3B7BE0;--az:#1E8FD6;--strip:#FFFFFF;
--gate:#C98A12;--gate-f:#FFF6E0;--gate-l:#E9C46A;--fail:#C0453A;--new:#2F7A55;--code-f:#1F2630;--code-t:#DCE3EA;--code-k:#8FC7A8}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#12161C;--card:#1B212A;--line:#2E3845;--text:#E6EBF1;--muted:#9AA6B4;--edge:#8391A1;
--cp-fill:#14231C;--cp-line:#4F8F6D;--cp-text:#7FC9A0;--pool:#566273;--ag-fill:#221D38;--ag-line:#6D5DC0;--async:#A08BF0;--prov:#F0913E;--user:#6FA2F0;
--pg-f:#18222F;--pg-l:#34496A;--rd-f:#2A1A1A;--rd-l:#5C3531;--ob-f:#1D232B;--ob-l:#36404C;--vt-f:#2A2418;--vt-l:#5E4E2C;--ai-f:#221D38;--ai-l:#4C4285;--rg-f:#162520;--rg-l:#34594A;--strip:#1B212A;--obs:#4CC3AE;--obs-f:#15272A;--obs-l:#2F6B62;
--gate:#E3A93A;--gate-f:#2A2414;--gate-l:#6B5424;--fail:#E0766B;--new:#4F8F6D;--code-f:#0E1217;--code-t:#DCE3EA;--code-k:#8FC7A8}}
:root[data-theme="dark"]{--bg:#12161C;--card:#1B212A;--line:#2E3845;--text:#E6EBF1;--muted:#9AA6B4;--edge:#8391A1;
--cp-fill:#14231C;--cp-line:#4F8F6D;--cp-text:#7FC9A0;--pool:#566273;--ag-fill:#221D38;--ag-line:#6D5DC0;--async:#A08BF0;--prov:#F0913E;--user:#6FA2F0;
--pg-f:#18222F;--pg-l:#34496A;--rd-f:#2A1A1A;--rd-l:#5C3531;--ob-f:#1D232B;--ob-l:#36404C;--vt-f:#2A2418;--vt-l:#5E4E2C;--ai-f:#221D38;--ai-l:#4C4285;--rg-f:#162520;--rg-l:#34594A;--strip:#1B212A;--obs:#4CC3AE;--obs-f:#15272A;--obs-l:#2F6B62;
--gate:#E3A93A;--gate-f:#2A2414;--gate-l:#6B5424;--fail:#E0766B;--new:#4F8F6D;--code-f:#0E1217;--code-t:#DCE3EA;--code-k:#8FC7A8}
body{margin:0;background:var(--bg);color:var(--text);font-family:"IBM Plex Sans KR","Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
svg{display:block;width:100%;min-width:1180px;margin:0 auto;height:auto;font-family:inherit}
.bg{fill:var(--bg)}
.card{fill:var(--card);stroke:var(--line);stroke-width:1}
.agent{fill:var(--ag-fill);stroke:var(--ag-line);stroke-width:1.5}
.st-pg{fill:var(--pg-f);stroke:var(--pg-l)}.st-rd{fill:var(--rd-f);stroke:var(--rd-l)}.st-ob{fill:var(--ob-f);stroke:var(--ob-l)}
.st-vt{fill:var(--vt-f);stroke:var(--vt-l)}.st-ai{fill:var(--ai-f);stroke:var(--ai-l)}.st-rg{fill:var(--rg-f);stroke:var(--rg-l)}
.cp{fill:var(--cp-fill);stroke:var(--cp-line);stroke-width:1.5;stroke-dasharray:7 6}
.pool{fill:none;stroke:var(--pool);stroke-width:1.2;stroke-dasharray:5 5}
.env{fill:var(--card);stroke-width:1.5}
.env-on{stroke:var(--on)}.env-aws{stroke:var(--aws)}.env-gcp{stroke:var(--gcp)}.env-az{stroke:var(--az)}
.bd-on{fill:var(--on)}.bd-aws{fill:var(--aws)}.bd-gcp{fill:var(--gcp)}.bd-az{fill:var(--az)}
.dot-on{fill:var(--on)}.dot-aws{fill:var(--aws)}.dot-gcp{fill:var(--gcp)}.dot-az{fill:var(--az)}
.strip{fill:var(--strip);stroke:var(--line)}
.obsc{fill:var(--obs-f);stroke:var(--obs-l)}
.gatec{fill:var(--gate-f);stroke:var(--gate-l);stroke-width:1.5}
.failc{fill:var(--rd-f);stroke:var(--rd-l);stroke-width:1.2}
.codec{fill:var(--code-f);stroke:none}
.newb{fill:var(--new)}.p0b{fill:var(--new)}.p1b{fill:var(--gate)}.p2b{fill:#8A95A3}.optb{fill:var(--muted)}
.optc{fill:var(--card);stroke:var(--pool);stroke-width:1.3;stroke-dasharray:6 4}
.h1{font-size:34px;font-weight:700;fill:var(--text)}
.h2{font-size:17px;fill:var(--muted)}
.ttl{font-size:19px;font-weight:700;fill:var(--text)}
.ttl-s{font-size:16px;font-weight:700;fill:var(--text)}
.sub{font-size:14.5px;fill:var(--muted)}
.subd{font-size:14.5px;fill:var(--text)}
.tag{font-size:13px;fill:var(--muted);font-weight:700}
.cpt{font-size:22px;font-weight:700;fill:var(--cp-text)}
.pt{font-size:14.5px;font-weight:700;fill:var(--muted)}
.stt{font-size:17px;font-weight:700;fill:var(--cp-text)}
.lbl{font-size:13.5px;fill:var(--muted);font-weight:700}
.leg{font-size:14.5px;fill:var(--muted)}
.bdt{font-size:12.5px;font-weight:700;fill:#fff}
.newt{font-size:11px;font-weight:700;fill:#fff;letter-spacing:.04em}
.gatet{font-size:16px;font-weight:700;fill:var(--gate)}
.failt{font-size:15px;font-weight:700;fill:var(--fail)}
.code{font-family:"IBM Plex Mono","DejaVu Sans Mono",monospace;font-size:13.5px;fill:var(--code-t)}
.codek{font-family:"IBM Plex Mono","DejaVu Sans Mono",monospace;font-size:13.5px;fill:var(--code-k)}
.mono{font-family:"IBM Plex Mono","DejaVu Sans Mono",monospace;font-size:13px;fill:var(--muted)}
.stn{font-size:15px;font-weight:700;fill:#fff}
.e-api{stroke:var(--edge);stroke-width:1.5;fill:none}
.e-async{stroke:var(--async);stroke-width:1.6;stroke-dasharray:6 4;fill:none}
.e-prov{stroke:var(--prov);stroke-width:2;fill:none}
.e-user{stroke:var(--user);stroke-width:2;fill:none}
.e-obs{stroke:var(--obs);stroke-width:1.8;stroke-dasharray:3 3;fill:none}
.e-gate{stroke:var(--gate);stroke-width:2;fill:none}
.e-fail{stroke:var(--fail);stroke-width:1.8;stroke-dasharray:7 5;fill:none}
.mk-e-obs{fill:var(--obs)}.mk-e-api{fill:var(--edge)}.mk-e-async{fill:var(--async)}.mk-e-prov{fill:var(--prov)}.mk-e-user{fill:var(--user)}.mk-e-gate{fill:var(--gate)}.mk-e-fail{fill:var(--fail)}
"""

EDGE_KINDS = ["e-api", "e-async", "e-prov", "e-user", "e-obs", "e-gate", "e-fail"]


def est_w(s, size):
    """Rough text width estimate (px) for CJK + latin mixes."""
    w = 0.0
    for ch in s:
        o = ord(ch)
        if 0x1100 <= o <= 0xFFDC:
            w += size * 0.98
        elif ch in "il.,:;|!'·":
            w += size * 0.30
        elif ch == " ":
            w += size * 0.28
        elif ch.isupper() or ch in "mwMW@%":
            w += size * 0.66
        else:
            w += size * 0.54
    return w


class Doc:
    def __init__(self, w, h, title, desc):
        self.w, self.h, self.title, self.desc = w, h, title, desc
        self.p = []

    def add(self, s):
        self.p.append(s)

    # ---- primitives
    def rect(self, x, y, w, h, cls, rx=12, extra=""):
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" class="{cls}" {extra}/>')

    def text(self, x, y, s, cls, anchor="start", fit=None):
        attr = f' data-fit="{fit}"' if fit else ""
        self.add(f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}"{attr}>{escape(s)}</text>')

    def path(self, d, kind, start=False, end=True):
        m = ""
        if end:
            m += f' marker-end="url(#m-{kind})"'
        if start:
            m += f' marker-start="url(#m-{kind})"'
        self.add(f'<path d="{d}" class="{kind}"{m}/>')

    def new_badge(self, x, y, label="NEW", bcls="newb"):
        w = 12 + len(label) * 7.6 if label.isascii() else 16 + len(label) * 11
        self.add(f'<rect x="{x}" y="{y}" width="{w:.0f}" height="20" rx="10" class="{bcls}"/>')
        self.add(f'<text x="{x + w / 2:.0f}" y="{y + 14.5}" class="newt" text-anchor="middle">{label}</text>')

    # ---- composite
    def card(self, x, y, w, title, lines, tag=None, cls="card", new=False, lh=25,
             tcls="ttl", lcls="sub", h=None, top=38, min_h=None, bullets=None):
        n = len(lines)
        hh = h or (top + 30 + (n - 1) * lh + 26 if n else top + 24)
        if min_h:
            hh = max(hh, min_h)
        self.rect(x, y, w, hh, cls)
        self.text(x + 22, y + top, title, tcls, fit=x + w - 12)
        if new:
            tw = est_w(title, 19 if tcls == "ttl" else 16)
            if new == "opt":
                self.new_badge(x + 22 + tw + 10, y + top - 16, "옵션", "optb")
            elif new in ("P0", "P1", "P2"):
                self.new_badge(x + 22 + tw + 10, y + top - 16, new, new.lower() + "b")
            else:
                self.new_badge(x + 22 + tw + 10, y + top - 16)
        if tag:
            self.text(x + w - 20, y + top - 2, tag, "tag", "end")
        for i, ln in enumerate(lines):
            self.text(x + 22, y + top + 30 + i * lh, ln, lcls, fit=x + w - 12)
        return hh

    def render(self):
        defs = "".join(
            f'<marker id="m-{k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" class="mk-{k}"/></marker>' for k in EDGE_KINDS)
        body = "\n".join(self.p)
        return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(self.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;700&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body><div class="wrap">
<svg viewBox="0 0 {self.w} {self.h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="dt dd">
<title id="dt">{escape(self.title)}</title><desc id="dd">{escape(self.desc)}</desc>
<defs>{defs}</defs>
<rect width="{self.w}" height="{self.h}" class="bg"/>
{body}
</svg></div></body></html>"""


def legend(d, x, y, items, col_w=330, per_col=3):
    """items: list of (kind, label). kind in edge kinds or 'new' / 'gate'."""
    for i, (kind, label) in enumerate(items):
        cx = x + (i // per_col) * col_w
        cy = y + (i % per_col) * 34
        if kind == "new":
            d.new_badge(cx, cy - 10)
        elif kind == "opt":
            d.new_badge(cx, cy - 10, "옵션", "optb")
        elif kind in ("P0", "P1", "P2"):
            d.new_badge(cx, cy - 10, kind, kind.lower() + "b")
        elif kind == "gatebox":
            d.add(f'<path d="M{cx + 25} {cy - 11} L{cx + 36} {cy} L{cx + 25} {cy + 11} L{cx + 14} {cy} Z" '
                  f'class="gatec"/>')
        else:
            d.add(f'<line x1="{cx}" y1="{cy}" x2="{cx + 50}" y2="{cy}" class="{kind}"/>')
        d.text(cx + 66, cy + 5, label, "leg")
