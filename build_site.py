"""Build the single-file artifact (site.html) and the deployable page (index.html) from site.src.html.

site.html  : fragment for the Claude artifact viewer (no doctype, no head).
index.html : full document with meta tags, Open Graph, favicon and font preconnects, ready to host.
"""
import base64, re, pathlib
here = pathlib.Path(__file__).parent
src = (here / "site.src.html").read_text()
def uri(m):
    p = here / "assets" / (m.group(1) + ".jpg")
    return "data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode()
out = re.sub(r"\{\{IMG:([\w-]+)\}\}", uri, src)
(here / "site.html").write_text(out)

head_end = out.index("</style>") + len("</style>")
head, body = out[:head_end], out[head_end:]
fav = ("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
       "<rect width='64' height='64' rx='12' fill='%2307090d'/><circle cx='32' cy='32' r='10' fill='%23ff4b3a'/></svg>")
meta = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="DWIM Logic is an AI production agency with 30 years of production craft behind it. Fixed-price edits, graphics, captions and spots, checked by a senior producer.">
<meta name="theme-color" content="#07090d">
<meta property="og:type" content="website">
<meta property="og:title" content="DWIM Logic. A one-person army with a 30-year bench.">
<meta property="og:description" content="AI production agency. Better, faster and cheaper, all three. Fixed price, fixed date, senior QC on every cut.">
<meta property="og:url" content="https://dwimlogic.com/">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{fav}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
"""
page = meta + head.replace('<title>DWIM Logic</title>', '<title>DWIM Logic</title>') + "\n</head>\n<body style=\"margin:0\">\n" + body + "\n</body>\n</html>\n"
(here / "index.html").write_text(page)
print("site.html", len(out) // 1024, "KB; index.html", len(page) // 1024, "KB")
