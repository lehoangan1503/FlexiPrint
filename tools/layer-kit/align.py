"""Registration check: how far an edit moved the unchanged parts of the master."""
import sys, numpy as np, cv2
from PIL import Image
def load(p, size=None):
    im = Image.open(p).convert("RGB")
    if size and im.size != size: print("  size differs", im.size, "->", size); im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32)
m = load(sys.argv[1]); 
for p in sys.argv[2:]:
    e = load(p, (m.shape[1], m.shape[0]))
    g1 = cv2.cvtColor(m, cv2.COLOR_RGB2GRAY); g2 = cv2.cvtColor(e, cv2.COLOR_RGB2GRAY)
    (dx, dy), resp = cv2.phaseCorrelate(g1, g2)
    d = np.abs(m - e).mean(2)
    same = d < 12
    print(f"{p}: shift dx={dx:.2f} dy={dy:.2f} (resp {resp:.2f}); unchanged px {same.mean()*100:.1f}%; mean diff on 'unchanged' {d[same].mean():.2f}")
