"""Print file → flat front mockup (exact placement on the blank-bag photo) → AI lifestyle photos."""
import json, numpy as np, cv2
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont
import ai
L = json.load(open("layout.json"))
W, H = L["main"]["w"], L["main"]["h"]

def print_file(hair_c, style, sweater, pants, shoes, name):
    """Same stack as the product: main, then layers bottom → top, then the name (Great Vibes, centred in its box)."""
    p = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    p.alpha_composite(Image.open("main.png").convert("RGBA"))
    c = L["character"]; size = (round(c["w"]), round(c["h"]))
    for f in [f"hair_back_{hair_c}_{style}", "body", f"pants_{pants}", f"sweater_{sweater}", f"shoes_{shoes}", f"hair_front_{hair_c}_{style}"]:
        p.alpha_composite(Image.open(f"out/{f}.png").resize(size, Image.LANCZOS), (c["x"], c["y"]))
    n = L["name"]; fs = 300
    font = ImageFont.truetype("GreatVibes.ttf", fs)
    while font.getlength(name) > n["w"] and fs > 60: fs -= 10; font = ImageFont.truetype("GreatVibes.ttf", fs)
    ImageDraw.Draw(p).text((n["x"] + n["w"] / 2, n["y"] + n["h"] / 2), name, font=font, fill=(29, 29, 31, 255), anchor="mm")
    return p

def front_mockup(pr):
    bag = Image.open(L["bag"]["file"]).convert("RGB")
    b = L["bag"]["box"]
    art = pr.resize((round(b["w"]), round(b["h"])), Image.LANCZOS)
    # Fabric puckering (low-frequency light only, not the stripes) shades the print a little.
    lum = cv2.cvtColor(np.asarray(bag).astype(np.float32) / 255, cv2.COLOR_RGB2GRAY)
    x, y, w, h = round(b["x"]), round(b["y"]), art.width, art.height
    shade = cv2.GaussianBlur(lum, (0, 0), 14)[y:y + h, x:x + w]
    shade = np.clip((shade / shade.mean()) ** 0.7, 0.75, 1.15)[..., None]
    a = np.asarray(art).astype(np.float32) / 255
    a[..., :3] = np.clip(a[..., :3] * shade, 0, 1)
    out = bag.convert("RGBA")
    out.alpha_composite(Image.fromarray((a * 255).astype(np.uint8), "RGBA"), (x, y))
    return out.convert("RGB")

KEEP = ("The printed artwork on the front of the bag must stay EXACTLY as in the reference: the same cartoon girl with the same "
        "hair, sweater, pants and shoes colours, the same peach peony, the same small butterflies and the same handwritten name "
        "spelled exactly the same — do not redraw, restyle, move or misspell any of it; it follows the bag's surface naturally. "
        "Keep the same bag: red-and-white seersucker stripes, same proportions, silver zipper with round pull. Photorealistic, "
        "premium e-commerce lifestyle photo, soft natural light, shallow depth of field.")
SCENES = {
    "vanity": "Turn this into a lifestyle photo: the bag stands on a white marble vanity table at a slight three-quarter angle, a vase of pale pink and cream roses behind it, a vintage gold hand mirror and a lipstick in front. ",
    "flatlay": "Turn this into a top-down flat-lay photo: the bag lies flat on soft pastel linen, surrounded by a few makeup brushes, a compact, a small perfume bottle and scattered dried flowers, the front of the bag facing up toward the camera. ",
}
if __name__ == "__main__":
    combos = {"emily": ("black", "braid", "red", "black", "pink", "Emily"), "sophia": ("blonde", "long", "cream", "light-blue", "green", "Sophia")}
    flats = {}
    for k, c in combos.items():
        pr = print_file(*c); pr.save(f"print_{k}.png")
        flats[k] = front_mockup(pr); flats[k].save(f"mockup_front_{k}.jpg", quality=92)
    jobs = [("emily", "vanity"), ("sophia", "flatlay"), ("sophia", "vanity")]
    def run(j):
        k, s = j
        ai.fal(SCENES[s] + KEEP, [flats[k]]).convert("RGB").save(f"mockup_{s}_{k}.jpg", quality=92); return j
    with ThreadPoolExecutor(3) as ex:
        for r in ex.map(run, jobs): print("done", r)
