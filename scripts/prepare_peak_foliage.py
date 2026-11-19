"""Prepare Peak foliage. Run with python -I, explicit external bark paths.
Only reads raster data; never imports/executes any downloaded file. Requires Pillow/numpy.
Generates deterministic botanical glTFs and software-baked multi-view leafy impostors.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SEED = 0x5045414B
OUT = None
ATLAS = None
BARK = None


def leaf_tile(kind, seed):
    r = random.Random(seed)
    im = Image.new('RGBA', (256, 256), (45, 91, 25, 0))
    d = ImageDraw.Draw(im)
    if kind == 2:  # needle-bearing shoot, not a solid triangular crown
        d.line([(125, 239), (132, 22)], fill=(102, 91, 43), width=4)
        for j in range(35):
            y = 30 + j * 5.5
            for sign in [-1, 1]:
                x = 130 + sign * r.uniform(30, 77)
                d.line([(130, y + 20), (x, y - r.uniform(8, 24))],
                       fill=(r.randrange(34, 74), r.randrange(86, 140), r.randrange(24, 54)), width=3)
        return im
    if kind >= 4:  # aster/daisy and pink meadow flower; petals with longitudinal detail
        cx, cy = 128, 128
        for j in range(11):
            a = j * math.tau / 11
            pts = []
            for k in range(28):
                t = k * math.tau / 28
                along = 49 + 44 * math.cos(t)
                side = 13 * math.sin(t)
                pts.append((cx + along * math.cos(a) - side * math.sin(a), cy + along * math.sin(a) + side * math.cos(a)))
            color = (232, 233, 202) if kind == 4 else (214, 109, 155)
            d.polygon(pts, fill=color)
            d.line([(cx+24*math.cos(a), cy+24*math.sin(a)), (cx+86*math.cos(a), cy+86*math.sin(a))], fill=(193, 185, 144) if kind == 4 else (169, 73, 128), width=2)
        d.ellipse((101, 101, 155, 155), fill=(199, 143, 33))
        for _ in range(100):
            x, y = r.uniform(105, 152), r.uniform(105, 152)
            if (x-128)**2+(y-128)**2 < 24**2:
                d.ellipse((x, y, x+3, y+3), fill=(239, 185+r.randrange(35), 61))
        return im
    # Serrated elliptical/birch and lobed oak leaves, with explicit midrib/veins.
    ys = np.arange(256)[:, None]
    xs = np.arange(256)[None, :]
    t = np.clip((ys - 16) / 221, 0, 1)
    width = np.sin(t * math.pi) ** (0.72 if kind == 0 else 0.95) * (85 if kind == 0 else 73)
    width *= (0.87 + 0.13 * np.cos(t * math.pi * 10)) if kind == 0 else (0.97 + 0.03 * np.sin(t * math.pi * 46))
    center = 128 + 8 * np.sin(t * math.pi)
    mask = (abs(xs-center) < width) & (ys > 16) & (ys < 237)
    grain = np.random.default_rng(seed).normal(0, 3, (256, 256))
    ridge = 10 * (1-abs(xs-center)/np.maximum(width, 1))
    pixels = np.asarray(im).copy()
    for channel, value in enumerate([54, 112, 30]):
        pixels[:, :, channel] = np.clip(value + ridge + grain + 11*np.sin(t*math.pi), 0, 255)
    pixels[:, :, 3] = np.where(mask, 255, 0)
    im = Image.fromarray(pixels)
    d = ImageDraw.Draw(im)
    d.line([(128, 246), (135, 130), (128, 20)], fill=(138, 159, 63), width=2)
    for y in range(51, 218, 19):
        w = float(width[y, 0]) * .85
        d.line([(133, y+8), (133-w, y-15)], fill=(102, 140, 50), width=1)
        d.line([(133, y+8), (133+w, y-15)], fill=(102, 140, 50), width=1)
    # RGB-only dilation avoids dark fringes without expanding alpha silhouette.
    expanded = Image.fromarray(np.asarray(im)[:,:,:3]).filter(ImageFilter.MaxFilter(3))
    pixels = np.asarray(im).copy(); pixels[:,:,:3] = np.asarray(expanded)
    return Image.fromarray(pixels)


def atlas():
    im = Image.new('RGBA', (1024, 512), (50, 100, 27, 0))
    for tile in range(6):
        im.paste(leaf_tile(tile, SEED+tile), ((tile % 4)*256, (tile//4)*256))
    # Medium shoots are clusters of fine leaves, not single metre-wide leaves.
    for kind in range(2):
        shoot=Image.new('RGBA',(256,256),(50,100,27,0))
        d=ImageDraw.Draw(shoot)
        d.line([(127,245),(132,28)],fill=(105,91,44),width=3)
        base=leaf_tile(kind,SEED+kind).resize((51,76),Image.Resampling.LANCZOS)
        for j in range(7):
            y=25+j*26
            for sign in [-1,1]:
                small=base.rotate(sign*(38+j%3*7),resample=Image.Resampling.BICUBIC,expand=True)
                x=128+sign*(24+j%2*9)-small.width//2
                shoot.alpha_composite(small,(x,y-small.height//2))
        im.paste(shoot,((kind+6)%4*256,256))
    im.save(OUT/'leaf-atlas.png', optimize=True)
    return im


class Mesh:
    def __init__(self):
        self.pos, self.norm, self.uv, self.color, self.idx = [], [], [], [], []
    def vertex(self, p, n, uv, c):
        self.pos.append(tuple(p)); self.norm.append(tuple(n)); self.uv.append(tuple(uv)); self.color.append(tuple(c))
        return len(self.pos)-1
    def quad(self, p, u, v, tile=0, tint=(1, 1, 1), normal=None):
        p, u, v = np.array(p), np.array(u), np.array(v)
        n = np.cross(u, v) if normal is None else np.array(normal)
        n /= max(np.linalg.norm(n), 1e-8)
        ids = []
        for x, y in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
            # inset avoids atlas bleed; glTF UV origin is image top.
            uv = ((tile%4 + (.02 if x < 0 else .98))/4,
                  (tile//4 + (.98 if y < 0 else .02))/2)
            ids.append(self.vertex(p+u*x+v*y, n, uv, tint))
        self.idx.extend([ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]])
    def tube(self, path, radius, end_radius, sides=8):
        path = [np.array(p) for p in path]
        first = len(self.pos)
        dist = 0
        previous_u = None
        for j, p in enumerate(path):
            direction = path[min(j+1, len(path)-1)]-path[max(0, j-1)]
            direction /= max(np.linalg.norm(direction), 1e-8)
            if previous_u is None:
                ref = np.array([0., 1., 0.]) if abs(direction[1]) < .94 else np.array([1., 0., 0.])
                u = np.cross(direction, ref)
            else:
                # Parallel-transport the ring frame; changing reference axes mid
                # curved limb would twist/flop the bark strip and triangle winding.
                u = previous_u - direction * np.dot(previous_u, direction)
            u /= max(np.linalg.norm(u),1e-8)
            previous_u = u
            v = np.cross(direction, u)
            rad = radius+(end_radius-radius)*j/(len(path)-1)
            if j: dist += np.linalg.norm(p-path[j-1])
            for k in range(sides+1):
                a = k*math.tau/sides
                n = u*math.cos(a)+v*math.sin(a)
                # glTF repeat texture coordinates follow bark longitudinally.
                self.vertex(p+n*rad, n, (k/sides*1.3, dist*7), (.82, .79, .74))
            if j:
                for k in range(sides):
                    a=first+(j-1)*(sides+1)+k; b=a+sides+1
                    self.idx.extend([a,a+1,b,a+1,b+1,b])
    def normalize(self, height, root=0):
        self.pos = [(x/height,(y-root)/height,z/height) for x,y,z in self.pos]


def cluster(leaves, center, r, kind, cards, spread=.075):
    center = np.array(center)
    for _ in range(cards):
        p = center+np.array([r.uniform(-spread,spread),r.uniform(-spread*.65,spread*.65),r.uniform(-spread,spread)])
        yaw, tilt = r.random()*math.tau, r.uniform(-.9,.9)
        width = r.uniform(.010,.022) if kind != 2 else r.uniform(.032,.048)
        length = width*(1.65 if kind != 2 else 1.7)
        u = np.array([math.cos(yaw),0.,math.sin(yaw)])*width
        v = np.array([-math.sin(yaw)*math.sin(tilt),math.cos(tilt),math.cos(yaw)*math.sin(tilt)])*length
        tint = (r.uniform(.72,1.04),r.uniform(.82,1.12),r.uniform(.73,1.02))
        leaves.quad(p,u,v,kind,tint)


def botanical(kind, medium=False):
    r = random.Random(SEED+kind*811)
    bark, leaves = Mesh(), Mesh()
    pine = kind == 2
    top = .98
    bend = r.uniform(-.025,.025)
    path = [(bend*t*t, t, .009*math.sin(t*5)) for t in [0,.08,.27,.48,.69,.86,top]]
    bark.tube(path,.023 if not pine else .020,.002,8 if medium else 12)
    if not medium:
        # Root flare is decorative only; stays inside original trunk collider footprint.
        for j in range(5):
            a=j*math.tau/5
            bark.tube([(0,.075,0),(.019*math.cos(a),.015,.019*math.sin(a)),(.032*math.cos(a),0,.032*math.sin(a))],.009,.001,6)
    if pine:
        for tier in range(10):
            y=.19+tier*.078
            reach=.34*(1-y)**.82
            for j in range(5):
                a=j*math.tau/5+tier*2.399
                tip=np.array([reach*math.cos(a),y-.026+r.uniform(-.015,.028),reach*math.sin(a)])
                start=np.array([bend*y*y,y,0])
                bark.tube([start,(start+tip)/2+np.array([0,-.02,0]),tip],.0045*(1-y),.0007,4 if medium else 6)
                if medium:
                    # Medium retains separated needle shoots, never a filled cone.
                    u=np.array([math.cos(a),0,math.sin(a)])*reach*.53
                    leaves.quad((start+tip)/2,u,[0,.055,0],2,(.82,.98,.80))
                    leaves.quad(tip*.85+start*.15,[-math.sin(a)*.052,0,math.cos(a)*.052],[0,.045,0],2)
                else:
                    for k in range(4):
                        p=start+(tip-start)*(.25+k*.2)
                        cluster(leaves,p,r,2,5,.032)
    else:
        # Spiral scaffold -> forks -> twigs -> individual fine serrated leaves.
        branches=15 if kind==0 else 13
        for j in range(branches):
            a=j*2.399+r.uniform(-.25,.25)
            y=.30+j/(branches-1)*.59
            reach=(.35 if kind==0 else .30)*(1-((y-.57)/.55)**2)
            start=np.array([bend*y*y,y,0])
            end=np.array([reach*math.cos(a),min(.95,y+.13),reach*math.sin(a)])
            mid=start+(end-start)*.5+np.array([0,-.016,0])
            bark.tube([start,mid,end],.0065*(1-y)+.001,.001,5 if medium else 8)
            for fork in [-1,0,1]:
                fa=a+fork*.66
                origin=start+(end-start)*(.53 if fork else .90)
                tip=origin+np.array([math.cos(fa)*.089,.06+r.random()*.035,math.sin(fa)*.089])
                bark.tube([origin,(origin+tip)/2,tip],.0018,.0004,3 if medium else 5)
                if medium:
                    # Six overlapping small leaf-shoot cards per fork, detailed alpha atlas.
                    for k in range(3):
                        p=tip+np.array([r.uniform(-.045,.045),r.uniform(-.025,.025),r.uniform(-.045,.045)])
                        yaw=r.random()*math.tau
                        leaves.quad(p,[math.cos(yaw)*.055,0,math.sin(yaw)*.055],[0,.078,0],6+kind,(.84,1,.84))
                else:
                    for twig in range(3):
                        ta=fa+(twig-1)*.80
                        tipp=tip+np.array([math.cos(ta)*.044,r.uniform(-.012,.037),math.sin(ta)*.044])
                        bark.tube([tip,tipp],.0007,.00015,3)
                        cluster(leaves,tipp,r,kind,16,.059)
        cluster(leaves,(bend,.955,0),r,kind,6 if medium else 50,.04)
    # Exact root=0 and height=1 for art only; placement/collider height is untouched.
    root=min(p[1] for m in [bark,leaves] for p in m.pos)
    height=max(p[1] for m in [bark,leaves] for p in m.pos)-root
    bark.normalize(height,root); leaves.normalize(height,root)
    return bark,leaves


def ground(kind):
    r=random.Random(SEED+113*kind)
    bark,leaves=Mesh(),Mesh()
    if kind==0:
        for j in range(11):
            a=j*2.399
            tip=np.array([.34*math.cos(a),r.uniform(.53,.86),.34*math.sin(a)])
            bark.tube([(0,0,0),tip*.55,tip],.009,.001,5)
            for k in range(6):
                p=tip*.6+np.array([r.uniform(-.20,.20),r.uniform(-.03,.30),r.uniform(-.20,.20)])
                cluster(leaves,p,r,1,12,.13)
    else:
        for j in range(19):
            a=j*2.399
            p=np.array([math.cos(a)*r.uniform(.1,.4),r.uniform(.45,.93),math.sin(a)*r.uniform(.1,.4)])
            bark.tube([(p[0]*.7,0,p[2]*.7),p*.6,p],.005,.002,4)
            leaves.quad(p,[.095,0,0],[0,.06,.073],4+j%2)
            for k in range(3):
                c=p*np.array([1,.28+k*.15,1])
                leaves.quad(c,[.053,0,.025],[0,.10,.02],1,(.76,.93,.71))
    root=min(p[1] for m in [bark,leaves] for p in m.pos)
    height=max(p[1] for m in [bark,leaves] for p in m.pos)-root
    bark.normalize(height,root); leaves.normalize(height,root)
    return bark,leaves


def save_gltf(name, meshes, far=False):
    data=bytearray(); views=[]; access=[]; primitives=[]
    def attribute(values, components, typ='f'):
        while len(data)%4: data.append(0)
        a=np.asarray(values,dtype='<f4' if typ=='f' else '<u4')
        offset=len(data); data.extend(a.tobytes())
        views.append({'buffer':0,'byteOffset':offset,'byteLength':a.nbytes})
        acc={'bufferView':len(views)-1,'componentType':5126 if typ=='f' else 5125,'count':len(values),'type':{1:'SCALAR',2:'VEC2',3:'VEC3'}[components]}
        if components==3 and typ=='f': acc.update(min=a.min(axis=0).tolist(),max=a.max(axis=0).tolist())
        access.append(acc); return len(access)-1
    for i,m in enumerate(meshes):
        attrs={'POSITION':attribute(m.pos,3),'NORMAL':attribute(m.norm,3),'TEXCOORD_0':attribute(m.uv,2),'COLOR_0':attribute(m.color,3)}
        primitives.append({'attributes':attrs,'indices':attribute(m.idx,1,'i'),'material':0 if far else i})
    leafmat={'name':'Peak leaf atlas','alphaMode':'MASK','alphaCutoff':.38,'doubleSided':True,'pbrMetallicRoughness':{'baseColorTexture':{'index':2},'metallicFactor':0,'roughnessFactor':.94}}
    barkmat={'name':'Peak CC0 bark','normalTexture':{'index':1,'scale':.7},'pbrMetallicRoughness':{'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':.91}}
    g={'asset':{'version':'2.0','generator':'Project Peak deterministic botanical prep'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0}],'meshes':[{'primitives':primitives}],
       'buffers':[{'uri':name+'.bin','byteLength':len(data)}],'bufferViews':views,'accessors':access,
       'samplers':[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497},{'magFilter':9729,'minFilter':9987,'wrapS':33071,'wrapT':33071}],
       'images':[{'uri':'bark-albedo.jpg'},{'uri':'bark-normal.jpg'},{'uri':'leaf-atlas.png'}],
       'textures':[{'source':0,'sampler':0},{'source':1,'sampler':0},{'source':2,'sampler':1}], 'materials':[barkmat,leafmat]}
    if far:
        g['images']=[{'uri':'tree-views.png'}]; g['textures']=[{'source':0,'sampler':1}]
        g['materials']=[{'name':'Peak leafy multi-angle impostor','alphaMode':'MASK','alphaCutoff':.38,'doubleSided':True,'pbrMetallicRoughness':{'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':1}}]
    (OUT/(name+'.bin')).write_bytes(data)
    (OUT/(name+'.gltf')).write_text(json.dumps(g,separators=(',',':')),encoding='utf-8')
    return {'triangles':sum(len(m.idx)//3 for m in meshes),'vertices':sum(len(m.pos) for m in meshes),'geometryBytes':len(data)}


def bake_view(meshes, yaw, pitch):
    """Alpha-tested orthographic CPU rasterizer. Actual hero leaf/trunk silhouette."""
    w,h=128,192
    forward=np.array([math.sin(yaw)*math.cos(pitch),math.sin(pitch),math.cos(yaw)*math.cos(pitch)])
    right=np.array([math.cos(yaw),0,-math.sin(yaw)])
    up=np.cross(forward,right)
    pixels=np.zeros((h,w,4),dtype=np.uint8); pixels[:,:,:3]=[55,105,30]
    depth=np.full((h,w),-1e9)
    for part,m in enumerate(meshes):
        p=np.asarray(m.pos); n=np.asarray(m.norm); uv=np.asarray(m.uv); colors=np.asarray(m.color)
        rel=p-np.array([0,.5,0])
        screen=np.stack([(rel@right/1.05+.5)*(w-1),(.5-rel@up/1.05)*(h-1)],axis=1)
        z=rel@forward
        texture=np.asarray(BARK if part==0 else ATLAS)
        th,tw=texture.shape[:2]
        for a,b,c in np.asarray(m.idx).reshape(-1,3):
            v=screen[[a,b,c]]
            xmin=max(0,int(math.floor(v[:,0].min()))); xmax=min(w-1,int(math.ceil(v[:,0].max())))
            ymin=max(0,int(math.floor(v[:,1].min()))); ymax=min(h-1,int(math.ceil(v[:,1].max())))
            if xmax<xmin or ymax<ymin: continue
            yy,xx=np.mgrid[ymin:ymax+1,xmin:xmax+1]; xx=xx+.5; yy=yy+.5
            den=(v[1,1]-v[2,1])*(v[0,0]-v[2,0])+(v[2,0]-v[1,0])*(v[0,1]-v[2,1])
            if abs(den)<1e-8: continue
            wa=((v[1,1]-v[2,1])*(xx-v[2,0])+(v[2,0]-v[1,0])*(yy-v[2,1]))/den
            wb=((v[2,1]-v[0,1])*(xx-v[2,0])+(v[0,0]-v[2,0])*(yy-v[2,1]))/den
            wc=1-wa-wb
            zz=wa*z[a]+wb*z[b]+wc*z[c]
            mask=(wa>=0)&(wb>=0)&(wc>=0)&(zz>depth[ymin:ymax+1,xmin:xmax+1])
            if not mask.any(): continue
            tuv=wa[:,:,None]*uv[a]+wb[:,:,None]*uv[b]+wc[:,:,None]*uv[c]
            tx=(tuv[:,:,0]%1*(tw-1)).astype(int); ty=(tuv[:,:,1]%1*(th-1)).astype(int)
            tex=texture[ty,tx]
            if part: mask &= tex[:,:,3]>96
            ns=wa[:,:,None]*n[a]+wb[:,:,None]*n[b]+wc[:,:,None]*n[c]
            # Broad sky fill with gentle directional relief; no baked hard sunlight.
            light=.72+.28*np.clip(ns[:,:,1]*.65+abs(ns[:,:,0])*.18+.17,0,1)
            tint=wa[:,:,None]*colors[a]+wb[:,:,None]*colors[b]+wc[:,:,None]*colors[c]
            rgb=np.clip(tex[:,:,:3]*tint*light[:,:,None],0,255).astype(np.uint8)
            dest=pixels[ymin:ymax+1,xmin:xmax+1]; dest[:,:,:3][mask]=rgb[mask]; dest[:,:,3][mask]=255
            depth[ymin:ymax+1,xmin:xmax+1][mask]=zz[mask]
    # RGB dilation avoids dark fringes after mipmapping, alpha stays silhouette-only.
    image=Image.fromarray(pixels)
    expanded=image.filter(ImageFilter.MaxFilter(3))
    arr=np.asarray(expanded).copy(); arr[:,:,3]=pixels[:,:,3]
    return Image.fromarray(arr)


def main():
    global OUT,ATLAS,BARK
    ap=argparse.ArgumentParser()
    ap.add_argument('--out',required=True); ap.add_argument('--bark-albedo',required=True); ap.add_argument('--bark-normal',required=True)
    args=ap.parse_args(); OUT=Path(args.out).resolve(); OUT.mkdir(parents=True,exist_ok=True)
    inputs=[]
    for arg,name in [(args.bark_albedo,'bark-albedo.jpg'),(args.bark_normal,'bark-normal.jpg')]:
        p=Path(arg).resolve()
        inputs.append({'output':name,'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        with Image.open(p) as im:
            im.convert('RGB').resize((1024,1024)).save(OUT/name,quality=89,subsampling=0)
    BARK=Image.open(OUT/'bark-albedo.jpg').convert('RGB')
    ATLAS=atlas(); budgets={}; heroes=[]
    for kind,name in enumerate(['oak','birch','pine']):
        m=botanical(kind); heroes.append(m); budgets[name+'-hero']=save_gltf(name+'-hero',m)
        budgets[name+'-mid']=save_gltf(name+'-mid',botanical(kind,True))
    budgets['bush']=save_gltf('bush',ground(0)); budgets['flowers']=save_gltf('flowers',ground(1))
    views=Image.new('RGBA',(1024,2048),(55,105,30,0))
    for species,m in enumerate(heroes):
        for pitch in range(3):
            for angle in range(8):
                views.paste(bake_view(m,angle*math.tau/8,math.radians(pitch*35)),(angle*128,(species*3+pitch)*192))
        print('Baked', ['oak','birch','pine'][species],flush=True)
    views.save(OUT/'tree-views.png',optimize=True)
    card=Mesh(); card.quad([0,.5,0],[.525,0,0],[0,.525,0])
    card.uv=[(0,1),(1,1),(1,0),(0,0)]
    budgets['tree-far']=save_gltf('tree-far',[card],True)
    manifest={'generator':'scripts/prepare_peak_foliage.py','seed':SEED,'license':'CC0-1.0','sourceInputs':inputs,'assets':budgets,
              'impostors':{'azimuths':8,'elevationsDegrees':[0,35,70],'tilePixels':[128,192],'atlasPixels':[1024,2048],'treeWidthAndHeight':1.05},
              'runtimeLimits':{'heroInstances':96,'midInstances':512,'farInstances':'original tree count (6800 scatter plus accepted belt trees)','bushInstances':96,'flowerInstances':256,'heroTransitionMeters':[70,90],'midTransitionMeters':[240,300]},
              'outputs':{p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.iterdir()) if p.suffix in ['.bin','.gltf','.png','.jpg']}}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(budgets,indent=2))

if __name__=='__main__': main()
