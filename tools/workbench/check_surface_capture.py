"""Check real browser pixels from the controlled near/far wall fixture."""
import argparse,json
from pathlib import Path
import numpy as np
from PIL import Image

def main():
    p=argparse.ArgumentParser();p.add_argument('image');p.add_argument('layout');p.add_argument('--side',choices=['before','after'],default='after');args=p.parse_args()
    layout=json.loads(Path(args.layout).read_text(encoding='utf8'))
    pixels=np.asarray(Image.open(args.image).convert('RGB'));ratio=layout.get('pixelsPerCssPixel',1)
    rows={}
    for name,rect in layout['frames'].items():
        cx=rect['x']+rect['width']/2;cy=rect['y']+rect['height']/2
        box=pixels[round((cy-40)*ratio):round((cy+40)*ratio),round((cx-40)*ratio):round((cx+40)*ratio)]
        assert box.size,name
        rows[name]={'meanRed':float(box[:,:,0].mean()/255),'darkFraction':float(np.mean(box.max(axis=2)<50))}
    print(json.dumps(rows,indent=2),flush=True)
    Path(args.image+'.metrics.json').write_text(json.dumps(rows,indent=2),encoding='utf8')
    near=rows[args.side+'-near']['meanRed'];far=rows[args.side+'-far']['meanRed']
    assert far>.8,'The reference wall must be opaque at the farther camera'
    assert near>=far*.95,f'Near surface loses coverage: near red={near:.3f}, far red={far:.3f}'

if __name__=='__main__':main()
