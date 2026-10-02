
from PIL import Image, ImageDraw, ImageFont
import os
os.makedirs("test/site", exist_ok=True)
src = Image.open("/Users/alexey/.hermes/images/clip_20261002_162457_1.png").convert("RGB")
# субтитры Cloud Quest: y 855..955, x 835..1585
caption = src.crop((835, 850, 1590, 960))
caption.save("test/site/caption.png")

def render(text, path, bg, fg, size=34, w=1100, h=110, font="/System/Library/Fonts/Supplemental/Arial.ttf"):
    im = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype(font, size)
    except Exception:
        f = ImageFont.load_default()
    d.text((18, 22), text, font=f, fill=fg)
    im.save(path)

render("Amazon S3 Glacier Deep Archive is the lowest-cost storage class.",
       "test/site/dark.png", (10, 26, 36), (240, 250, 255))
render("Amazon S3 Intelligent-Tiering moves objects between access tiers.",
       "test/site/light.png", (255, 255, 255), (16, 16, 16))
print("fixtures ok", Image.open("test/site/caption.png").size)
