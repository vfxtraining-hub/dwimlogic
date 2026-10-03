"""Build lookbook.html (single file, images inlined) from the list below."""
import base64, pathlib, html
here = pathlib.Path(__file__).parent
L = here / "assets" / "lookbook"
# (shot, file, title, verdict, note, generation id)
SHOTS = [
 ("01-02", "s01-stage.jpg", "The empty stage", "approve", "The hero. Dawn through the hangar doors, one figure, one lamp, a red tally in the far haze. Sets the whole look.", "01a0fd40-9b42-7546-95eb-7bb5057adf90"),
 ("03", "s03-film.jpg", "1996 film splice", "approve", "Hands, tape, grease pencil, reels soft behind. The red dot lands exactly where it should.", "01a0fd41-db58-75bd-a932-c8b142863b01"),
 ("04", "s04-tape.jpg", "2002 tape deck", "approve", "Cool monitor against warm shelves. Hand reads clean.", "01a0fd41-df7f-7597-a032-59a5a14854f6"),
 ("05", "s05-timeline.jpg", "2010 timeline", "approve", "Over-the-shoulder, faceless enough. Screens read as a real NLE.", "01a0fd41-e871-79ce-a3a5-9bc10c3724af"),
 ("07", "s07-grade.jpg", "2018 grade", "approve", "Amber panel lights, graded frame, red beacon at right.", "01a0fd41-ec5a-78a0-86d7-ec9898a88bd9"),
 ("13", "s13-agent.jpg", "2026 the agent era", "approve", "Silhouette at a vast console, ribbons of light overhead. The strongest 'now' frame.", "01a0fd41-ef5b-792d-afbe-6463443213cd"),
 ("09", "s09-lights.jpg", "Lights snap on", "approve", "Truss rows in perspective, red tally at the vanishing point. Ready to animate as a sequence.", "01a0fd57-da93-798b-9a83-965735f86718"),
 ("10", "s10-dolly.jpg", "Dolly track", "approve", "Camera on rails, red record light, practical lamps behind. Very usable.", "01a0fd57-e1b2-71e0-a289-7eddde0b8641"),
 ("14", "s14-cameras.jpg", "Cameras pivot", "approve", "Two crane cameras, symmetry, red tally on each. Better than planned.", "01a0fd57-ecb0-7b1d-8ef6-082e3188e656"),
 ("15", "s15-formats.jpg", "Frame splits into formats", "retake", "Great idea, but the orange neon is too saturated against the restrained look. Retake in warm white with less glow.", "01a0fd57-f393-7290-a381-abf0438f6488"),
 ("16", "s16-wall.jpg", "Wall of screens", "approve", "Dense and cinematic, red tally under each screen.", "01a0fd41-fae9-7707-820b-a6eb31ce5bf8"),
 ("17", "s17-lowerthird.jpg", "Lower-third glyph", "retake", "Reads as sci-fi HUD, not broadcast. Retake as a clean bar sliding in over a dark studio.", "01a0fd57-f8b6-7f2a-a631-3852d58ad610"),
 ("18", "s18-console.jpg", "Mixing console", "approve", "Amber faders, meters, red peak light. Sound gets its own beat.", "01a0fd57-fe0b-73e5-b74d-8497309446ea"),
 ("20", "s20-freeze.jpg", "Everything freezes", "revise", "Beautiful, but the figure looks defeated (head down) and the crew is a normal crew, not light. Retake with the figure upright and the crew as warm particles.", "01a0fd58-018b-7796-bca4-471f2e09c83b"),
 ("21", "s21-tally.jpg", "The tally light", "approve", "The signature image. Also the site's closing frame.", "01a0fd41-fdb3-70c5-bbb8-86c3129b1976"),
 ("22", "s22-final.jpg", "Final image", "approve", "One figure, one lamp, a red light far behind. Calm. This closes the film.", "01a0fd58-0577-71a1-9c6f-bfb40775f11e"),
 ("11", "", "Hero crane: the army assembles", "missing", "Generated but the tool would not return the image, so I could not review it. Open it in Artlist history to judge. 01a0fd41-f39b-7128-87c5-8feae42c9574 and 01a0fd42-f18a-78d6-ad64-77d42cfac35e.", "01a0fd42-f18a-78d6-ad64-77d42cfac35e"),
 ("12", "", "Crew of light", "missing", "Same problem. Generated, not reviewable here. 01a0fd57-e76d-77d4-9bf8-7181b497bb50.", "01a0fd57-e76d-77d4-9bf8-7181b497bb50"),
]
TESTS = [
 ("T1", "t1-stage-clip-frame.jpg", "Test clip: slow push-in on the stage", "Kling v3 Pro, 1080p, 5s, no audio, 500 credits. I could only review a single frame, not the motion. Watch it in Artlist before judging.", "01a0fd58-2490-782a-b496-bfe614f8b364"),
 ("T2", "t2-tally-clip-frame.jpg", "Test clip: tally light rack focus", "Kling v3 Pro, 1080p, 5s, no audio, 500 credits. Single frame reviewed only.", "01a0fd58-29ad-7f1c-aae4-3865ee3fe171"),
]
def img(name):
    if not name: return ""
    return "data:image/jpeg;base64," + base64.b64encode((L / name).read_bytes()).decode()
def card(shot, f, title, verdict, note, gid):
    chip = {"approve": "Approved", "retake": "Retake", "revise": "Revise", "missing": "Not reviewed"}[verdict]
    pic = f'<img src="{img(f)}" alt="{html.escape(title)}">' if f else '<div class="none">Image not retrievable</div>'
    return f'<article class="c {verdict}"><div class="ph">{pic}<span class="n">SHOT {shot}</span><span class="chip">{chip}</span></div><h3>{html.escape(title)}</h3><p>{html.escape(note)}</p><code>{gid}</code></article>'
def tcard(code, f, title, note, gid):
    return f'<article class="c test"><div class="ph"><img src="{img(f)}" alt="{html.escape(title)}"><span class="n">{code}</span><span class="chip">Frame only</span></div><h3>{html.escape(title)}</h3><p>{html.escape(note)}</p><code>{gid}</code></article>'
page = """<title>Army of One Lookbook</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a contact sheet. One card per shot, a verdict chip on each, so the producer approves or rejects in one pass. */
:root{--bg:#07090d;--panel:#10151c;--fg:#eef0f3;--mute:#9aa5b3;--line:#232c38;--tally:#ff4b3a;--ok:#4cc38a;--warn:#f2c14e;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "IBM Plex Sans",system-ui,sans-serif}
.w{max-width:1240px;margin:0 auto;padding:40px 24px 80px}
.k{font:500 12px "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--mute);margin:0 0 10px}
h1{font:400 clamp(52px,9vw,120px)/.92 Anton,Impact,sans-serif;text-transform:uppercase;margin:0 0 16px}
h1 em{font:italic 400 1.05em "Instrument Serif",Georgia,serif;text-transform:none;color:var(--tally)}
.lead{color:var(--mute);max-width:64ch;margin:0 0 28px}
.sum{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 36px}
.sum div{border:1px solid var(--line);border-radius:12px;padding:12px 18px;background:var(--panel)}
.sum b{display:block;font:400 32px/1 Anton,Impact,sans-serif}
.sum span{font:500 11px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
h2{font:400 clamp(34px,4vw,52px)/1 Anton,Impact,sans-serif;text-transform:uppercase;margin:48px 0 18px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}
.c{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;display:grid;gap:8px;align-content:start;min-width:0}
.ph{position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:#0b0f15}
.ph img{width:100%;height:100%;object-fit:cover;display:block}
.none{display:grid;place-items:center;height:100%;font:500 12px "IBM Plex Mono",monospace;color:var(--mute);letter-spacing:.1em;text-transform:uppercase;text-align:center;padding:12px}
.n{position:absolute;left:8px;top:8px;font:500 11px "IBM Plex Mono",monospace;letter-spacing:.1em;background:rgba(0,0,0,.65);padding:3px 8px;border-radius:5px}
.chip{position:absolute;right:8px;top:8px;font:500 11px "IBM Plex Mono",monospace;letter-spacing:.08em;padding:3px 8px;border-radius:5px;background:rgba(0,0,0,.65)}
.approve .chip{color:var(--ok)}.retake .chip,.revise .chip{color:var(--warn)}.missing .chip,.test .chip{color:var(--mute)}
.c h3{margin:2px 0 0;font:400 22px/1.1 Anton,Impact,sans-serif;letter-spacing:.01em;text-transform:uppercase}
.c p{margin:0;color:var(--mute);font-size:14px}
code{font:400 10.5px "IBM Plex Mono",monospace;color:#6f7b8a;word-break:break-all}
.box{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:18px 20px;margin-top:16px}
.box p{margin:0 0 6px;color:var(--mute)}.box b{color:var(--fg)}
</style>
<div class="w">
<p class="k">The Army of One · Phase A review</p>
<h1>The look, <em>for approval.</em></h1>
<p class="lead">Sixteen lookbook stills, two test clips and one music candidate, all generated from one style bible. Approve the look, or mark what to retake. Nothing here is final footage.</p>
<div class="sum"><div><b>13</b><span>approved</span></div><div><b>3</b><span>retake or revise</span></div><div><b>2</b><span>not reviewable</span></div><div><b>1,750</b><span>credits spent</span></div></div>
<h2>Stills</h2>
<div class="g">""" + "".join(card(*s) for s in SHOTS) + """</div>
<h2>Test clips</h2>
<div class="g">""" + "".join(tcard(*t) for t in TESTS) + """</div>
<h2>Music</h2>
<div class="box"><p><b>Candidate 1</b> · Lyria 3 Pro instrumental · 300 credits · about 100 BPM, low sub pulse, strings building, drop to near silence, one resolved hit.</p><p><code>01a0fd58-2e0a-7636-bfd6-02c2566f3804</code></p><p>I could not play it here. Listen in Artlist and tell me whether to keep it, regenerate, or pick a licensed catalog track instead.</p></div>
</div>
"""
(here / "lookbook.html").write_text(page)
print(len(page) // 1024, "KB")
