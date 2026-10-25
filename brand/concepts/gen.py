import math
W='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{}</svg>'
def hexpts(cx,cy,r,flat=False):
    off=0 if flat else -90
    return [(cx+r*math.cos(math.radians(off+60*k)),cy+r*math.sin(math.radians(off+60*k))) for k in range(6)]
def rhex(cx,cy,r,rad,flat=False):
    # rounded hexagon path (corner radius rad)
    p=hexpts(cx,cy,r,flat); d=""
    for i in range(6):
        a,b,c=p[i-1],p[i],p[(i+1)%6]
        def towards(u,v,t):
            L=math.dist(u,v); return (u[0]+(v[0]-u[0])*t/L,u[1]+(v[1]-u[1])*t/L)
        t=rad/math.tan(math.radians(60))  # interior 120 -> half 60
        s=towards(b,a,t); e=towards(b,c,t)
        d+=("M" if i==0 else "L")+f"{s[0]:.2f},{s[1]:.2f} A{rad},{rad} 0 0 1 {e[0]:.2f},{e[1]:.2f} "
    return d+"Z "
def circ(cx,cy,r):
    return f"M{cx-r:.2f},{cy} a{r},{r} 0 1 0 {2*r},0 a{r},{r} 0 1 0 {-2*r},0 Z "
def save(name,body): open(name+".svg","w").write(W.format(body))

# A Notch Hive: flat-top hex with the macOS notch cut from its top edge
h=104*math.sin(math.radians(60)); top=128-h+6; bot=128+h+6
save("a-notch-hive",f'<path fill="#000" d="M76,{top:.1f} L100,{top:.1f} L100,{top+14:.1f} A14,14 0 0 0 114,{top+28:.1f} L142,{top+28:.1f} A14,14 0 0 0 156,{top+14:.1f} L156,{top:.1f} L180,{top:.1f} L232,{128+6} L180,{bot:.1f} L76,{bot:.1f} L24,{128+6} Z"/>')

# B Off on a task: six dots on a hexagon, one has left the ring and moves outward
pts=hexpts(118,138,72); body=""
for i,(x,y) in enumerate(pts):
    if i==1: x,y=x+36,y-36*math.tan(math.radians(30))*1.0
    body+=circ(x,y,22 if i!=1 else 26)
save("b-off-on-a-task",f'<path fill="#000" d="{body}"/>')

# C H-cell: an H whose crossbar is a solid hive cell
save("c-h-cell",f'<path fill="#000" d="M52,40 h40 a0,0 0 0 1 0,0 v176 h-40 Z M164,40 h40 v176 h-40 Z {rhex(128,128,46,8)}"/>')

# D Agent: rounded hex with two eye-holes (a friendly face = your agent)
save("d-agent",f'<path fill="#000" fill-rule="evenodd" d="{rhex(128,128,112,22)} M94,104 a14,14 0 0 1 28,0 v30 a14,14 0 0 1 -28,0 Z M134,104 a14,14 0 0 1 28,0 v30 a14,14 0 0 1 -28,0 Z"/>')

# E Asleep, ready: rounded hex with a crescent-moon hole
cxA,cyA,rA=124,132,46; cxB,cyB,rB=146,114,40
dx,dy=cxB-cxA,cyB-cyA; dd=math.hypot(dx,dy); a=(rA*rA-rB*rB+dd*dd)/(2*dd); hh=math.sqrt(rA*rA-a*a)
mx,my=cxA+a*dx/dd,cyA+a*dy/dd
p1=(mx+hh*dy/dd,my-hh*dx/dd); p2=(mx-hh*dy/dd,my+hh*dx/dd)
cres=f"M{p1[0]:.2f},{p1[1]:.2f} A{rA},{rA} 0 1 0 {p2[0]:.2f},{p2[1]:.2f} A{rB},{rB} 0 0 1 {p1[0]:.2f},{p1[1]:.2f} Z"
save("e-asleep",f'<path fill="#000" fill-rule="evenodd" d="{rhex(128,128,112,22)} {cres}"/>')

# F Awake cell: seven packed cells, the centre one is lit (solid), the others are rings
rings=""
for (x,y) in hexpts(128,128,74,flat=True):
    rings+=f'<circle cx="{x:.2f}" cy="{y:.2f}" r="24" fill="none" stroke="#000" stroke-width="11"/>'
save("f-awake-cell",rings+'<circle cx="128" cy="128" r="32" fill="#000"/>')

# G Island: the notch pill holding three cells (the team lives in your notch)
holes="".join(rhex(x,128,22,4) for x in (84,128,172))
save("g-island",f'<path fill="#000" fill-rule="evenodd" d="M56,82 h144 a46,46 0 0 1 0,92 h-144 a46,46 0 0 1 0,-92 Z {holes}"/>')

# H Skep board: a dome hive made of stacked lanes, with an entrance
lanes=""
for i,(w,y) in enumerate([(84,46),(140,88),(176,130),(200,172)]):
    lanes+=f"M{128-w/2+17},{y} h{w-34} a17,17 0 0 1 0,34 h{-(w-34)} a17,17 0 0 1 0,-34 Z "
door="M110,206 v-10 a18,18 0 0 1 36,0 v10 Z"
save("h-skep-board",f'<path fill="#000" fill-rule="evenodd" d="{lanes} {door}"/>')

# J Team stack: three overlapping rounded-hex avatars, like the collapsed notch
st=""
for x in (72,128,184):
    st+=f'<path d="{rhex(x,128,58,12)}" fill="#000" stroke="#fff" stroke-width="12" paint-order="stroke"/>'
save("j-team-stack",st)
