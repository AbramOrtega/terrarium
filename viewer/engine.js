/* Terrarium 3D: a small WebGL2 engine for the island a conversation builds.
   No dependencies. Lit low-poly geometry with shadow maps, water, a sky that
   follows the clock, bloom, particles and creatures that mean something. */
(() => {
'use strict'

const LH = 0.42
const BOTTOM = -2.6
const TAU = Math.PI * 2
const BIOME = { seabed: 0, beach: 1, meadow: 2, forest: 3, dry: 4, rock: 5, snow: 6, river: 7, lava: 8, marsh: 9 }
const DECOR = { none: 0, pine: 1, oak: 2, birch: 3, bush: 4, rock: 5, flowers: 6, reeds: 7, palm: 8, snowpine: 9, mushroom: 10 }

// ------------------------------------------------------------------ math

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const mix = (a, b, t) => a + (b - a) * t
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const lerpAngle = (a, b, t) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return a + d * t }

const M4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0])
  },
  ortho(l, r, b, t, n, f) {
    const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f)
    return new Float32Array([-2 * lr, 0, 0, 0, 0, -2 * bt, 0, 0, 0, 0, 2 * nf, 0, (l + r) * lr, (t + b) * bt, (f + n) * nf, 1])
  },
  lookAt(eye, at, up) {
    const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x)
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
  },
  mul(a, b) {
    const o = new Float32Array(16)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
    return o
  },
  apply(m, p) {
    const x = p[0], y = p[1], z = p[2]
    const w = m[3] * x + m[7] * y + m[11] * z + m[15]
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w]
  },
}

const rand2 = (x, y, seed) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a)

// ------------------------------------------------------------------ color (stored linear)

const srgb = h => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] }
const toLin = c => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]
const C = h => toLin(srgb(h))
const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l)
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return toLin([f(0), f(8), f(4)])
}
const cmix = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
const cmul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]

// ------------------------------------------------------------------ unit shapes (y from 0 to 1, x and z from -0.5 to 0.5)

const orient = (tris, center) => {
  for (const t of tris) {
    const n = cross(sub(t[1], t[0]), sub(t[2], t[0]))
    const c = scl(add(add(t[0], t[1]), t[2]), 1 / 3)
    if (dot(n, sub(c, center)) < 0) { const s = t[1]; t[1] = t[2]; t[2] = s }
  }
  return tris
}
const quadTris = (out, a, b, c, d) => { out.push([a, b, c], [a, c, d]) }

const UNIT = {}
UNIT.cube = (() => {
  const c = [[-.5, 0, -.5], [.5, 0, -.5], [.5, 1, -.5], [-.5, 1, -.5], [-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5]]
  const t = []
  quadTris(t, c[0], c[1], c[2], c[3]); quadTris(t, c[4], c[5], c[6], c[7]); quadTris(t, c[0], c[1], c[5], c[4])
  quadTris(t, c[3], c[2], c[6], c[7]); quadTris(t, c[0], c[3], c[7], c[4]); quadTris(t, c[1], c[2], c[6], c[5])
  return orient(t, [0, .5, 0])
})()
const ring = (n, r, y, off = 0) => Array.from({ length: n }, (_, k) => [Math.cos(off + (k / n) * TAU) * r, y, Math.sin(off + (k / n) * TAU) * r])
const cone = (n, off = 0, r = .5) => {
  const b = ring(n, r, 0, off), t = []
  for (let k = 0; k < n; k++) { t.push([[0, 1, 0], b[k], b[(k + 1) % n]]); t.push([[0, 0, 0], b[(k + 1) % n], b[k]]) }
  return orient(t, [0, .3, 0])
}
const cyl = n => {
  const b = ring(n, .5, 0), u = ring(n, .5, 1), t = []
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n
    quadTris(t, b[k], b[k2], u[k2], u[k])
    t.push([[0, 0, 0], b[k2], b[k]], [[0, 1, 0], u[k], u[k2]])
  }
  return orient(t, [0, .5, 0])
}
UNIT.cone6 = cone(6); UNIT.cone8 = cone(8); UNIT.cone10 = cone(10)
UNIT.pyr = cone(4, Math.PI / 4, Math.SQRT1_2)
UNIT.cyl6 = cyl(6); UNIT.cyl8 = cyl(8); UNIT.cyl12 = cyl(12)
UNIT.wedge = (() => {
  const A = [-.5, 0, -.5], B = [.5, 0, -.5], Cc = [.5, 0, .5], D = [-.5, 0, .5], E = [-.5, 1, 0], F = [.5, 1, 0]
  const t = []
  quadTris(t, A, B, Cc, D); quadTris(t, D, Cc, F, E); quadTris(t, A, E, F, B); t.push([A, D, E], [B, F, Cc])
  return orient(t, [0, .35, 0])
})()
UNIT.octa = orient([
  [[0, 1, 0], [.5, .5, 0], [0, .5, .5]], [[0, 1, 0], [0, .5, .5], [-.5, .5, 0]], [[0, 1, 0], [-.5, .5, 0], [0, .5, -.5]], [[0, 1, 0], [0, .5, -.5], [.5, .5, 0]],
  [[0, 0, 0], [0, .5, .5], [.5, .5, 0]], [[0, 0, 0], [-.5, .5, 0], [0, .5, .5]], [[0, 0, 0], [0, .5, -.5], [-.5, .5, 0]], [[0, 0, 0], [.5, .5, 0], [0, .5, -.5]],
], [0, .5, 0])
const icosphere = subdivisions => {
  const p = (1 + Math.sqrt(5)) / 2
  const v = [[-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]].map(norm)
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  let tris = f.map(([a, b, c]) => [v[a], v[b], v[c]])
  for (let s = 0; s < subdivisions; s++) {
    const next = []
    for (const [a, b, c] of tris) {
      const ab = norm(scl(add(a, b), .5)), bc = norm(scl(add(b, c), .5)), ca = norm(scl(add(c, a), .5))
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    tris = next
  }
  return orient(tris.map(t => t.map(q => [q[0] * .5, q[1] * .5 + .5, q[2] * .5])), [0, .5, 0])
}
UNIT.ico0 = icosphere(0); UNIT.ico1 = icosphere(1)
// The unit sphere about the origin, for shapes built by their axes.
const SPHERE = UNIT.ico1.map(t => t.map(q => [q[0] * 2, (q[1] - .5) * 2, q[2] * 2]))

// ------------------------------------------------------------------ mesh building

// Vertex: position 3, normal 3, color 3, emissive 1 (negative: only at night; 5+: lava), sway 1, material 1
const STRIDE = 12
// What a surface is made of, for the shader: ground and cliffs get their grain,
// the creature its oily skin, eyes and wet things their shine.
// (5 is a stream in the photo sent to Blender.) The turtle: its scaly hide, and its shell.
const MAT = { plain: 0, ground: 1, cliff: 2, skin: 3, gloss: 4, hide: 6, shell: 7 }
class Mesh {
  constructor() { this.d = []; this.n = 0; this.mat = MAT.plain }
  vtx(p, n, c, e, w) { this.d.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], e, w, this.mat); this.n++ }
  tri(a, b, c, col, e = 0, w = [0, 0, 0], cols) {
    const n = norm(cross(sub(b, a), sub(c, a)))
    this.vtx(a, n, cols ? cols[0] : col, e, w[0]); this.vtx(b, n, cols ? cols[1] : col, e, w[1]); this.vtx(c, n, cols ? cols[2] : col, e, w[2])
  }
  // A triangle that faces along `want`, whichever way its corners were given.
  triW(a, b, c, want, col, e = 0) {
    if (dot(cross(sub(b, a), sub(c, a)), want) < 0) this.tri(a, c, b, col, e)
    else this.tri(a, b, c, col, e)
  }
  // A smooth triangle: a normal per corner, so curved things shade round.
  triN(a, b, c, na, nb, nc, col, e = 0, cols) {
    this.vtx(a, na, cols ? cols[0] : col, e, 0); this.vtx(b, nb, cols ? cols[1] : col, e, 0); this.vtx(c, nc, cols ? cols[2] : col, e, 0)
  }
  // A smooth tube through points, as thick as `radii` says at each; capped at
  // its tip. `cols`, a color per point, shades it along its length.
  tube(pts, radii, col, e = 0, sides = 7, cols) {
    if (pts.length < 2) return
    const rings = pts.map((p, k) => {
      const t = norm(sub(pts[Math.min(k + 1, pts.length - 1)], pts[Math.max(k - 1, 0)]))
      const ref = Math.abs(t[1]) > .95 ? [1, 0, 0] : [0, 1, 0]
      const u = norm(cross(t, ref)), v = cross(t, u)
      return Array.from({ length: sides }, (_, s) => {
        const a = s / sides * TAU, n = add(scl(u, Math.cos(a)), scl(v, Math.sin(a)))
        return { p: add(p, scl(n, radii[k])), n }
      })
    })
    for (let k = 0; k < rings.length - 1; k++) for (let s = 0; s < sides; s++) {
      const a = rings[k][s], b = rings[k][(s + 1) % sides], c = rings[k + 1][(s + 1) % sides], d = rings[k + 1][s]
      const ca = cols ? cols[k] : col, cb = cols ? cols[k + 1] : col
      this.triN(a.p, b.p, c.p, a.n, b.n, c.n, col, e, cols && [ca, ca, cb]); this.triN(a.p, c.p, d.p, a.n, c.n, d.n, col, e, cols && [ca, cb, cb])
    }
    const end = pts[pts.length - 1], last = rings[rings.length - 1], tip = norm(sub(end, pts[pts.length - 2]))
    const cap = add(end, scl(tip, radii[radii.length - 1])), ce = cols ? cols[cols.length - 1] : col
    for (let s = 0; s < sides; s++) this.triN(last[s].p, last[(s + 1) % sides].p, cap, last[s].n, last[(s + 1) % sides].n, tip, ce, e)
  }
  // An ellipsoid about a center, its three half-axes given as vectors.
  ellipsoid(c, ax, ay, az, col, e = 0) {
    const flip = dot(cross(ax, ay), az) < 0
    for (const u of SPHERE) {
      const t = flip ? [u[0], u[2], u[1]] : u
      const ps = t.map(d => add(c, add(add(scl(ax, d[0]), scl(ay, d[1])), scl(az, d[2]))))
      const ns = t.map(d => norm(add(add(scl(ax, d[0] / Math.max(1e-4, dot(ax, ax))), scl(ay, d[1] / Math.max(1e-4, dot(ay, ay)))), scl(az, d[2] / Math.max(1e-4, dot(az, az))))))
      this.triN(ps[0], ps[1], ps[2], ns[0], ns[1], ns[2], col, e)
    }
  }
  // A quad whose face points along `want`; colors per corner optional.
  quad(a, b, c, d, want, col, e = 0, cols, w = 0) {
    let n = cross(sub(b, a), sub(c, a))
    if (dot(n, want) < 0) { this.quad(a, d, c, b, want, col, e, cols && [cols[0], cols[3], cols[2], cols[1]], w); return }
    const ww = [w, w, w]
    this.tri(a, b, c, col, e, ww, cols && [cols[0], cols[1], cols[2]])
    this.tri(a, c, d, col, e, ww, cols && [cols[0], cols[2], cols[3]])
  }
  // A thin flat thing seen from both sides (wings, leaves, flags).
  sheet(a, b, c, d, col, e = 0) {
    const n = norm(cross(sub(b, a), sub(c, a)))
    this.quad(a, b, c, d, n, col, e); this.quad(a, b, c, d, scl(n, -1), col, e)
  }
  put(unit, T, col, e = 0, sway = 0) {
    const sx = T.sx, sy = T.sy, sz = T.sz
    const cy = Math.cos(T.ry || 0), syn = Math.sin(T.ry || 0)
    const cx = Math.cos(T.rx || 0), sxn = Math.sin(T.rx || 0)
    const cz = Math.cos(T.rz || 0), szn = Math.sin(T.rz || 0)
    const xf = p => {
      let x = p[0] * sx, y = p[1] * sy, z = p[2] * sz
      let y2 = y * cx - z * sxn; z = y * sxn + z * cx; y = y2
      let x2 = x * cz - y * szn; y = x * szn + y * cz; x = x2
      x2 = x * cy + z * syn; z = -x * syn + z * cy; x = x2
      return [x + T.x, y + T.y, z + T.z]
    }
    for (const t of unit) {
      const w = sway ? [sway * t[0][1], sway * t[1][1], sway * t[2][1]] : [0, 0, 0]
      this.tri(xf(t[0]), xf(t[1]), xf(t[2]), col, e, w)
    }
  }
}

// A local frame for a structure: a base point, a turn about y, and a growth scale.
const frame = (m, bx, by, bz, ry, k) => {
  const c = Math.cos(ry), s = Math.sin(ry)
  const W = (ox, oy, oz) => [bx + (ox * c + oz * s) * k, by + oy * k, bz + (-ox * s + oz * c) * k]
  const P = (unit, ox, oy, oz, sx, sy, sz, col, e = 0, sway = 0, rot = {}) => {
    const p = W(ox, oy, oz)
    m.put(unit, { x: p[0], y: p[1], z: p[2], sx: sx * k, sy: sy * k, sz: sz * k, ry: ry + (rot.ry || 0), rx: rot.rx || 0, rz: rot.rz || 0 }, col, e, sway)
  }
  return { W, P }
}

// ------------------------------------------------------------------ GL

const canvas = document.getElementById('gl')
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' })
const fallback = document.getElementById('fallback')
const wait = document.getElementById('wait')

const compile = (src, type) => {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'))
  return s
}
const program = (vs, fs) => {
  const p = gl.createProgram()
  gl.attachShader(p, compile(vs, gl.VERTEX_SHADER))
  gl.attachShader(p, compile(fs, gl.FRAGMENT_SHADER))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
  const u = {}
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name) }
  return { p, u }
}

const HEAD = '#version 300 es\nprecision highp float;\nprecision highp sampler2DShadow;\n'
const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float hash3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int k=0;k<5;k++){ s+=a*vnoise(p); p=p*2.03+vec2(17.1,9.2); a*=.5; } return s; }
`
const SWAY = `
uniform float uTime, uWind;
vec3 sway(vec3 p, float w){
  float s = sin(uTime*1.7 + p.x*.9 + p.z*.7) + .5*sin(uTime*3.3 + p.z*1.3 + p.x*.4);
  return p + vec3(s*.045, 0., s*.03) * w * uWind;
}`

const LIT_VS = HEAD + SWAY + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC;
layout(location=3) in float aE; layout(location=4) in float aW; layout(location=5) in float aM;
uniform mat4 uVP, uLVP;
out vec3 vN; out vec3 vC; out float vE; out vec3 vW; out vec4 vL; flat out float vM;
void main(){ vec3 p = sway(aP, aW); vN = aN; vC = aC; vE = aE; vM = aM; vW = p; vL = uLVP*vec4(p,1.); gl_Position = uVP*vec4(p,1.); }`

// Lit surfaces. Ground and cliffs get grain from noise (no textures), rain
// wets what faces the sky, clouds drift shadows across, ambient occlusion
// darkens the creases, the creature's skin is oily and veined, eyes and wet
// things shine, and light ripples over everything under the water.
const LIT_FS = HEAD + NOISE + `
in vec3 vN; in vec3 vC; in float vE; in vec3 vW; in vec4 vL; flat in float vM;
uniform vec3 uLightDir, uLightCol, uSkyAmb, uGroundAmb, uFogCol, uCam, uUnderDir, uUnderCol, uFallCol;
uniform float uFog, uNight, uTime, uShadowOn, uSea, uClipY, uWet, uCover, uCaustic, uVein, uAOOn, uUnderY, uRimR, uShellAge, uShellRings;
uniform vec2 uCloudOff, uRes, uShellF, uFallR;
uniform vec4 uShellSz;
uniform vec2 uScutes[37];
uniform sampler2DShadow uShadow;
uniform sampler2D uAO;
out vec4 o;
float shadowAt(){
  vec3 p = vL.xyz/vL.w*.5+.5;
  if (p.x<0.||p.x>1.||p.y<0.||p.y>1.||p.z>1.) return 1.;
  vec2 t = 1./vec2(textureSize(uShadow,0)); float s = 0.;
  for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++) s += texture(uShadow, vec3(p.xy+vec2(x,y)*t*1.2, p.z-.0012));
  return s/9.;
}
float caustic(vec2 p, float t){
  vec2 q = p + vec2(vnoise(p*1.3 + t*.31), vnoise(p*1.3 - t*.27 + 7.))*1.7;
  float v = vnoise(q*2.3 + vec2(t*.45, -t*.38));
  float w = vnoise(q*3.1 - vec2(t*.3, t*.5) + 3.);
  return pow(smoothstep(.16, 0., abs(v - .5)), 2.) + .6*pow(smoothstep(.12, 0., abs(w - .5)), 2.);
}
// Cells: the nearest two cell points, and the nearest cell's own number.
vec3 cells(vec3 p){
  vec3 i = floor(p), f = fract(p); float d1 = 9., d2 = 9., id = 0.;
  for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++) for (int z=-1;z<=1;z++) {
    vec3 g = vec3(float(x), float(y), float(z)), c = i + g;
    float d = length(g + vec3(hash3(c), hash3(c + 7.1), hash3(c + 13.3)) - f);
    if (d < d1) { d2 = d1; d1 = d; id = hash3(c + 3.7); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
// The turtle's hide, by where on its body (lp, carried in the color so the
// scales stay put as it moves): dark olive scales with pale edges, darker
// blotches, paler beneath.
vec3 hideOf(vec3 lp, vec3 n){
  vec3 c = cells(lp);
  float edge = smoothstep(.04, .2, c.y - c.x);
  vec3 sc = mix(vec3(.042,.038,.014), vec3(.15,.13,.04), c.z);
  sc = mix(sc, vec3(.022,.018,.007), smoothstep(.5, .78, vnoise(lp.xy*.21 + lp.z*.13))*.6);
  return mix(mix(vec3(.5,.43,.22), sc, edge), vec3(.62,.54,.3), smoothstep(.15, -.65, n.y));
}
// The shell, by where on it (its frame from uShellF, its size from uShellSz):
// each plate dark with amber flames from its middle, an olive wash, grooves
// between; a growth ring near each plate's edge for each compaction; dust
// and small craters as the session ages. Its color, and how deep in a groove.
vec4 shellOf(vec3 w, vec3 tint){
  float u = dot(w.xz, uShellF)/uShellSz.x, v = dot(w.xz, vec2(uShellF.y, -uShellF.x))/uShellSz.y;
  float d1 = 9., d2 = 9., id = 0.; vec2 c = vec2(0.);
  for (int k = 0; k < 37; k++) { vec2 s = uScutes[k]; float d = length(vec2(u - s.x, (v - s.y)*1.1));
    if (d < d1) { d2 = d1; d1 = d; c = s; id = float(k); } else if (d < d2) d2 = d; }
  float inner = d1/max(d1 + d2, 1e-3)*2.;
  float flame = smoothstep(.38, .78, fbm(vec2(atan(v - c.y, u - c.x)*2.2 + id*3.7, inner*2.6 - id)));
  vec3 col = mix(vec3(.05,.03,.008), vec3(.36,.19,.03), flame) * tint;
  col = mix(col, vec3(.15,.14,.035), .22 + .2*(1. - inner));
  for (int k = 1; k <= 6; k++) if (float(k) <= uShellRings) col = mix(col, vec3(.69,.62,.39), smoothstep(.016, 0., abs(inner - (1. - float(k)*.085)))*.55);
  col = mix(col, vec3(.37,.33,.24), uShellAge*(.25 + .45*vnoise(vec2(u, v)*28.)));
  vec2 g = vec2(u, v)*9., gi = floor(g);
  for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++) {
    vec2 cc = gi + vec2(float(x), float(y));
    if (hash(cc + 2.3) > uShellAge*.55) continue;
    float d = length(g - cc - vec2(hash(cc + 5.1), hash(cc + 9.7)))/(.12 + .14*hash(cc + 1.9));
    col = d < 1. ? col*(.45 + .3*d) : mix(col, vec3(.55,.5,.4), smoothstep(1.5, 1., d)*.45);
  }
  float groove = 1. - smoothstep(0., .035, d2 - d1);
  return vec4(mix(col, vec3(.013,.008,.003), groove*.85), groove);
}
void main(){
  if (vW.y < uClipY) discard;
  vec3 n = normalize(vN);
  vec3 v = normalize(uCam - vW);
  vec3 alb = vC;
  float m = vM;
  bool skin = m > 2.5 && m < 3.5, shiny = m > 3.5 && m < 4.5, hide = m > 5.5 && m < 6.5, shell = m > 6.5;
  float groove = 0.;
  if (hide) alb = hideOf(vC, n);
  else if (shell) { vec4 sl = shellOf(vW, vC); alb = sl.rgb; groove = sl.a; }
  else if (m > .5 && m < 1.5) alb *= .84 + .2*fbm(vW.xz*1.6) + .1*vnoise(vW.xz*9.);
  else if (m > 1.5 && m < 2.5) {
    float band = .5 + .5*sin(vW.y*26. + vnoise(vec2(vW.x + vW.z, vW.y)*2.5)*5.);
    alb *= .8 + .14*band + .12*vnoise(vec2(vW.x - vW.z, vW.y*3.)*5.);
  }
  float wet = skin ? 0. : uWet * smoothstep(.35, .9, n.y) * step(uSea, vW.y);
  alb *= 1. - .32*wet;
  float diff = max(dot(n, uLightDir), 0.);
  float sh = uShadowOn > .5 ? shadowAt() : 1.;
  sh *= 1. - uCover*.5*smoothstep(.42, .72, fbm(vW.xz*.09 + uCloudOff));
  float ao = uAOOn > .5 ? texture(uAO, gl_FragCoord.xy/uRes).r : 1.;
  vec3 amb = mix(uGroundAmb, uSkyAmb, n.y*.5+.5) * ao;
  vec3 col = alb * (amb + uLightCol*diff*sh*mix(1., ao, .4));
  float rim = pow(1.-max(dot(n,v),0.), 3.);
  col += alb * uSkyAmb * rim * .35 * ao;
  float gloss = max(wet, m > 2.5 && m < 4.5 ? 1. : 0.);
  // The shell's faint clear coat, the hide's damp sheen; none down in the grooves.
  if (shell || hide) col += uLightCol * pow(max(dot(n, normalize(uLightDir + v)), 0.), shell ? 60. : 30.) * sh * (shell ? .35 : .12) * (1. - groove);
  if (gloss > 0.) {
    vec3 hv = normalize(uLightDir + v);
    float sp = pow(max(dot(n, hv), 0.), shiny ? 140. : skin ? 110. : 70.);
    col += uLightCol * sp * sh * (shiny ? 2.2 : skin ? .32 : 1.1) * gloss;
    col += mix(uGroundAmb, uSkyAmb, .8) * rim * gloss * .25;
  }
  if (skin) {
    float fr = pow(1.-max(dot(n,v),0.), 2.);
    vec3 film = .5 + .5*cos(6.2831*(fr*1.4 + vec3(0., .33, .67) + vW.y*.35 + uTime*.05));
    col += film * fr * .3 * (.35 + uLightCol.g*.5 + uNight*.5);
    // A spawnling (material 3.1 to 3.4) has veins of its own: its hue, pulsing at its own rate.
    bool own = m > 3.05;
    float vr = own ? clamp((m - 3.1)/.3, 0., 1.) : uVein;
    vec3 vc = own ? normalize(alb + .002)*1.15 : vec3(.62,.32,1.);
    col += (own ? vc*.8 : vec3(.5,.28,1.)) * rim * (.18 + uNight*.6);
    float vn = vnoise(vW.xz*3.2 + vW.y*2.3 + vec2(0., uTime*.05));
    float veins = smoothstep(.07, 0., abs(vn - .5));
    float pulse = .5 + .5*sin(uTime*(2. + vr*7.) - dot(vW, vec3(2.1,3.,1.7)));
    col += vc * veins * (.25 + .9*vr) * (.35 + .65*pulse);
  }
  float e = vE >= 4.5 ? (1.3 + .7*sin(uTime*2.3 + vW.x*2.1 + vW.z*1.7)) * 2.2 : (vE > 0. ? vE : -vE*uNight);
  if (!hide) col += vC * e * 2.4;
  // Under the sea: only inside the rim, above the rock beneath.
  if (vW.y < uSea && vW.y > uUnderY && length(vW.xz) < uRimR) {
    float dp = uSea - vW.y;
    col *= mix(vec3(1.), vec3(.55,.8,.85), clamp(dp*1.6, 0., .85));
    col += uLightCol * caustic(vW.xz*1.8, uTime) * uCaustic * sh * .5 * exp(-dp*.7) * max(n.y, .15);
  }
  // Under the disc, out of the air: lit from below (softly round the curve)
  // when the sun has gone round beneath it; starlight round the turtle's
  // edges so it never sinks into the dark; light off the falls above on what
  // faces up near the rim.
  if (vW.y < uUnderY) {
    float own = shell || hide ? 1. : .45;
    float wrap = clamp(dot(n, uUnderDir)*.6 + .4, 0., 1.);
    col += alb * uUnderCol * wrap * wrap * mix(.6, 1., own);
    col += vec3(.3,.4,.68) * pow(1. - max(dot(n, v), 0.), 2.6) * .2 * own * (1. - groove*.7);
    col += alb * uFallCol * max(n.y, 0.) * smoothstep(uFallR.x, uFallR.y, length(vW.xz)) * ao;
  }
  float f = vW.y < uUnderY ? 0. : 1. - exp(-length(uCam - vW)*uFog);
  o = vec4(mix(col, uFogCol, f), 1.);
}`

const DEPTH_VS = HEAD + SWAY + `
layout(location=0) in vec3 aP; layout(location=4) in float aW;
uniform mat4 uLVP;
void main(){ gl_Position = uLVP*vec4(sway(aP, aW),1.); }`
const DEPTH_FS = HEAD + `void main(){}`

// The pre-pass: each pixel's facing and distance, for occlusion, sun rays and focus.
const GBUF_VS = HEAD + SWAY + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=4) in float aW;
uniform mat4 uVP, uV;
out vec3 vNV; out float vZ;
void main(){ vec3 p = sway(aP, aW); vNV = mat3(uV)*aN; vZ = -(uV*vec4(p,1.)).z; gl_Position = uVP*vec4(p,1.); }`
const GBUF_FS = HEAD + `
in vec3 vNV; in float vZ; out vec4 o;
void main(){ o = vec4(normalize(vNV)*.5+.5, vZ); }`

const SSAO_FS = HEAD + `
in vec2 vUV; uniform sampler2D uG; uniform vec2 uTanXY; uniform vec3 uK[16]; uniform int uN; uniform float uRadius; out vec4 o;
void main(){
  vec4 g = texture(uG, vUV); float z = g.a;
  if (z > 900.) { o = vec4(1.); return; }
  vec3 n = normalize(g.xyz*2.-1.);
  vec3 p = vec3((vUV*2.-1.)*uTanXY*z, -z);
  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453)*6.2831;
  vec3 r = vec3(cos(a), sin(a), 0.);
  vec3 t = normalize(r - n*dot(r,n)); vec3 b = cross(n, t);
  float occ = 0., rad = uRadius*(.7 + z*.015);
  for (int i=0;i<16;i++){ if (i>=uN) break;
    vec3 s = p + (t*uK[i].x + b*uK[i].y + n*uK[i].z)*rad;
    vec2 su = (s.xy/(-s.z))/uTanXY*.5+.5;
    float sz = texture(uG, su).a;
    float range = smoothstep(0., 1., rad/max(abs(z - sz), 1e-3));
    occ += (sz < -s.z - .04 ? 1. : 0.) * range;
  }
  o = vec4(vec3(clamp(1. - occ/float(uN)*1.25, 0., 1.)), 1.);
}`
const AOBLUR_FS = HEAD + `
in vec2 vUV; uniform sampler2D uTex, uG; uniform vec2 uDir; out vec4 o;
void main(){ float z0 = texture(uG, vUV).a; float s = 0., w = 0.;
  for (int i=-3;i<=3;i++){ vec2 uv = vUV + uDir*float(i); float z = texture(uG, uv).a;
    float k = exp(-abs(z - z0)*3.) * (1. - abs(float(i))/4.); s += texture(uTex, uv).r*k; w += k; }
  o = vec4(vec3(s/max(w, 1e-4)), 1.); }`

// Sun rays: march toward the sun through the sky the island leaves showing.
const RAYS_FS = HEAD + `
in vec2 vUV; uniform sampler2D uTex, uG; uniform vec2 uSun; uniform int uSteps; out vec4 o;
void main(){
  vec2 d = (uSun - vUV) / float(uSteps) * .92;
  vec2 p = vUV; float decay = 1.; vec3 acc = vec3(0.);
  for (int i=0;i<64;i++){ if (i>=uSteps) break; p += d;
    if (p.x<0.||p.x>1.||p.y<0.||p.y>1.) break;
    float sky = step(900., texture(uG, p).a);
    vec3 c = min(texture(uTex, p).rgb, vec3(8.)); float l = max(c.r, max(c.g, c.b));
    acc += c * sky * smoothstep(.5, 2., l) * decay; decay *= .968; }
  o = vec4(acc/float(uSteps)*2.4, 1.);
}`

const WATER_VS = HEAD + `
layout(location=0) in vec3 aP; layout(location=1) in float aD;
uniform mat4 uVP; uniform float uTime, uWind, uWave;
out vec3 vW; out vec3 vN; out float vD;
float h(vec2 p){ return (sin(p.x*1.4+uTime*1.3)*.018 + sin(p.y*1.9-uTime*1.05)*.014 + sin((p.x+p.y)*2.7+uTime*2.1)*.008) * uWave * (.6+uWind*.3); }
void main(){
  vec3 p = aP; vec3 n = vec3(0,1,0);
  if (aD >= 0.) { float e = .05; p.y += h(p.xz);
    n = normalize(vec3(h(p.xz-vec2(e,0))-h(p.xz+vec2(e,0)), 2.*e, h(p.xz-vec2(0,e))-h(p.xz+vec2(0,e)))); }
  vW = p; vN = n; vD = aD; gl_Position = uVP*vec4(p,1.);
}`
// Water: the island and sky mirrored in it, the seabed bending beneath it,
// rings where the rain lands, foam at the shore.
const WATER_FS = HEAD + NOISE + `
in vec3 vW; in vec3 vN; in float vD;
uniform vec3 uCam, uLightDir, uLightCol, uZen, uHor, uFogCol;
uniform float uTime, uFog, uNight, uClarity, uFlow, uRain, uReflOn, uRefrOn;
uniform vec2 uRes; uniform sampler2D uRefl, uScene;
out vec4 o;
float ripple(vec2 p, float t){
  vec2 c = floor(p); vec2 f = fract(p) - .5; float h0 = hash(c);
  float ph = fract(t*.9 + h0);
  float d = length(f - (vec2(hash(c + 3.1), hash(c + 7.7)) - .5)*.5);
  return sin((d - ph*.5)*40.) * smoothstep(.5*ph + .06, .5*ph, d) * (1. - ph);
}
float rings(vec2 p){ return ripple(p*2.5, uTime) + ripple(p*3.7 + 9., uTime*1.3); }
void main(){
  vec3 v = normalize(uCam - vW);
  if (vD < 0.) {
    // A fall: a river's (depth -1), or the sea over the rim (-1 to -2 as it falls).
    float lit = .45+.55*uLightCol.g+.25;
    if (vD > -1.005) {
      float s = fract(vW.y*3.5 + uTime*(1.8 + uFlow*5.) + hash(vec2(floor((vW.x+vW.z)*14.), 3.))*.7);
      vec3 c = mix(vec3(.55,.8,.9), vec3(1.), smoothstep(.55, 1., s));
      o = vec4(c*lit, .82); return;
    }
    // Over the rim: streaming sheets with gaps between, see-through, breaking into spray as they fall.
    float down = clamp(-vD - 1., 0., 1.), ang = atan(vW.z, vW.x);
    float h1 = hash(vec2(floor(ang*160.), 7.));
    float sheet = smoothstep(.25, .75, vnoise(vec2(ang*38., down*2.)));
    float flow = fract(vW.y*1.1 + uTime*(1.2 + h1*.8) + h1*5.);
    float streak = smoothstep(0., .45, flow) * (1. - smoothstep(.55, 1., flow));
    vec3 c = mix(vec3(.6,.8,.9), vec3(.95,.98,1.), streak*.55 + down*.35);
    o = vec4(c*lit, (.1 + .42*sheet*(.45 + .55*streak)) * (1. - smoothstep(.1, 1., down))); return;
  }
  vec3 n = normalize(vN + vec3(vnoise(vW.xz*6.+uTime*.6)-.5, 0., vnoise(vW.zx*6.-uTime*.5)-.5)*.12);
  if (uRain > .01) {
    vec2 e = vec2(.03, 0.); float r0 = rings(vW.xz);
    n = normalize(n + vec3(rings(vW.xz + e.xy) - r0, 0., rings(vW.xz + e.yx) - r0)*uRain*2.2);
  }
  float fr = .03 + .97*pow(1.-max(dot(n,v),0.), 5.);
  float shallow = clamp(1. - vD/2.4, 0., 1.);
  vec3 deep = vec3(.01,.06,.13), mid = vec3(.02,.22,.32), lagoon = vec3(.06,.42,.44);
  vec3 base = mix(deep, mix(mid, lagoon, shallow*shallow), shallow);
  base = mix(mix(base, vec3(.16,.19,.09), (1. - uClarity)*.5), base*1.12, uClarity*.25);
  base *= .35 + .65*max(uLightCol.g*1.2, .25);
  vec2 suv = gl_FragCoord.xy/uRes;
  vec3 r = reflect(-v, n);
  vec3 refl = uReflOn > .5 ? texture(uRefl, suv + n.xz*.045).rgb : mix(uHor, uZen, clamp(r.y*1.8, 0., 1.));
  vec3 body = base;
  if (uRefrOn > .5) {
    vec3 under = texture(uScene, suv + n.xz*.035*clamp(vD, .2, 1.5)).rgb;
    float absorb = clamp(vD/2.4, 0., 1.)*(1. - uClarity*.55) + .12;
    body = mix(under*vec3(.75,.92,.95), base, absorb);
  }
  vec3 col = mix(body, refl, fr*(uReflOn > .5 ? .85 : .75));
  vec3 hv = normalize(uLightDir + v);
  col += uLightCol * pow(max(dot(n, hv), 0.), 220.) * 3.5;
  float foamBand = smoothstep(.84, .985, shallow);
  float foam = foamBand * smoothstep(.45, .8, vnoise(vW.xz*7. + vec2(uTime*.8, -uTime*.6)) + .25*sin(uTime*2.2 + vD*12.));
  col = mix(col, vec3(.92,.96,1.)*(.4+.6*uLightCol.g+.2), foam*.75);
  float a = uRefrOn > .5 ? 1. : max(mix(.76, .94, fr) - uClarity*.14, foam*.8);
  float f = 1. - exp(-length(uCam - vW)*uFog);
  o = vec4(mix(col, uFogCol, f), a);
}`

const SKY_VS = HEAD + `
out vec2 vUV;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p*2.-1.; gl_Position = vec4(p*2.-1., .9999, 1.); }`
// Space all round: near black, the stars and the Milky Way above and below.
// Over the disc hangs its air, a low dome over the sea in the sky's colors for the hour,
// thick where you look through much of it (a glow round the rim); its clouds,
// aurora and rainbow live in it, and by day it hides the stars behind it.
// Air (A) turns its glow off (uAirOn); the aurora and rainbow stay.
// The sun and moon are bodies of their own (drawOrbs); here only their glow.
const SKY_FS = HEAD + NOISE + `
in vec2 vUV;
uniform vec3 uR, uU, uF, uZen, uHor, uSunPos, uMoonPos, uSunCol, uEye;
uniform float uTan, uAspect, uNight, uTime, uStorm, uJoy, uWonder, uWind, uSunUp, uCover, uFlip, uSea, uAirOn;
uniform vec4 uAir, uMeteorA, uMeteorB;
out vec4 o;
vec3 rainbow(float t){ return clamp(vec3(abs(t*6.-3.)-1., 2.-abs(t*6.-2.), 2.-abs(t*6.-4.)), 0., 1.); }
// How much of the air a ray passes through, 0 to 1: the dome is uAir.y wide
// and uAir.z high about the height uAir.x, and ends at the floor below. It is
// thickest over the disc's middle and thins away to nothing at its edge.
float airOf(vec3 e, vec3 d, float floorY){
  vec3 s = vec3(uAir.y, uAir.z, uAir.y);
  vec3 q = (e - vec3(0., uAir.x, 0.))/s, k = d/s;
  float a = dot(k,k), b = dot(q,k), c = dot(q,q) - 1.;
  float h = b*b - a*c; if (h <= 0.) return 0.;
  h = sqrt(h);
  float t0 = max((-b - h)/a, 0.), t1 = (-b + h)/a;
  if (t1 <= 0.) return 0.;
  if (abs(d.y) > 1e-4) { float tf = (floorY - e.y)/d.y; if (d.y > 0.) t0 = max(t0, tf); else t1 = min(t1, tf); }
  else if (e.y < floorY) return 0.;
  float len = t1 - t0; if (len <= 0.) return 0.;
  float od = 0.;
  for (int i = 0; i < 6; i++) { vec3 p = q + k*(t0 + (float(i) + .5)/6.*len); od += exp(-dot(p,p)*2.5); }
  return (1. - exp(-od*len/6./(uAir.y*.5))) * .6;
}
void main(){
  vec3 d = normalize(uF + vUV.x*uTan*uAspect*uR + vUV.y*uTan*uU);
  vec3 e = uEye;
  if (uFlip > .5) { d.y = -d.y; e.y = 2.*uSea - e.y; }
  float air = airOf(e, d, uFlip > .5 ? uSea : uAir.w);
  // Space.
  vec3 col = vec3(.004,.006,.016) + vec3(.008,.006,.018)*(1. - abs(d.y));
  float haze = air*uAirOn;
  float dark = (.55 + .45*uNight) * (1. - haze*(.2 + .8*uSunUp)) * (1. - uStorm*haze);
  // Each star has its own brightness, tint, pace and moment: most shimmer gently, a few twinkle hard.
  vec3 q = floor(d*240.);
  if (hash3(q) > .9965) {
    float h2 = hash3(q + 17.31), h3 = hash3(q + 41.7);
    float deep = h3 > .85 ? .6 : .18;
    float tw = 1. - deep*(.5 + .5*sin(uTime*(.7 + h2*2.6) + h3*44.));
    col += mix(vec3(1.,.88,.76), vec3(.8,.9,1.), h3) * (.45 + .55*h2) * tw * dark;
  }
  // The Milky Way: a dusty band of light across the dark, dark lanes through it.
  vec3 mwN = normalize(vec3(.35, .55, .76));
  float mw = exp(-pow(dot(d, mwN), 2.)*26.);
  float az = atan(d.z, d.x);
  float dust = fbm(vec2(az*3., d.y*6.)*2.);
  float lane = smoothstep(.45, .72, fbm(vec2(az*5., d.y*9.) + 5.));
  col += mix(vec3(.5,.56,.85), vec3(.95,.82,.66), dust) * mw * (.2 + .55*dust) * (1. - .7*lane) * dark * .55;
  col += vec3(step(.996, hash3(floor(d*520.)))) * mw * dark * .8;
  // A shooting star.
  if (uMeteorA.w > 0.) {
    float k = uMeteorA.w, best = 0.;
    for (int i=0;i<12;i++){ float tt = k - float(i)*.022; if (tt < 0.) break;
      vec3 p = normalize(mix(uMeteorA.xyz, uMeteorB.xyz, tt));
      best = max(best, exp(-(1. - dot(d, p))*9.e4) * (1. - float(i)/12.)); }
    col += vec3(1.,.95,.85) * best * 3.5 * (1. - smoothstep(.85, 1., k)) * (1.-uStorm*.7);
  }
  float s = max(dot(d, normalize(uSunPos - e)), 0.);
  float m = max(dot(d, normalize(uMoonPos - e)), 0.);
  // The sun's corona, seen through space as through air.
  col += uSunCol * pow(s, 900.) * 1.2 * (1.-uStorm*.8);
  // The air: the sky's colors for the way it looks, lit by the sun, with its weather.
  float t = clamp(d.y, 0., 1.);
  vec3 sky = mix(mix(uHor, uZen, .4), uZen, pow(t, .55));
  if (d.y < 0.) sky = mix(uHor, mix(uHor, uZen, .6)*.7, clamp(-d.y*2.2, 0., 1.));
  sky += uSunCol * (pow(s, 10.)*.22 + pow(s, 3.)*.06) * uSunUp * (1.-uStorm*.85);
  sky += vec3(.85,.9,1.) * pow(m, 60.)*.12 * (.25 + uNight*.75) * (1.-uStorm*.8);
  vec3 glow = vec3(0.);
  if (d.y > 0.) {
    float wave = d.y - .32 - .07*sin(d.x*3.7 + uTime*.13) - .05*sin(d.z*6.1 - uTime*.21) - .03*sin((d.x+d.z)*11. + uTime*.4);
    float band = exp(-wave*wave*70.) * (.6+.4*sin(d.x*22.+uTime*.5)*sin(d.z*17.-uTime*.3));
    vec3 ac = mix(vec3(.15,1.,.55), vec3(.6,.3,1.), clamp(d.x*.7+.5, 0., 1.));
    glow += ac * band * uWonder * uNight * .9 * (1.-uStorm);
    vec2 uv = d.xz/(d.y+.12)*.55 + vec2(uTime*.006*(1.+uWind*2.5), uTime*.002);
    float c = fbm(uv*2.2);
    float cover = mix(.82, .28, max(uCover, uStorm));
    float cl = smoothstep(cover, cover+.22, c) * smoothstep(0., .25, d.y);
    vec3 cc = mix(vec3(1.), vec3(.32,.34,.4), uStorm) * (.35 + .75*max(uSunCol.g*uSunUp, .1) + uNight*.08);
    cc = mix(cc, uSunCol*1.2, pow(s, 6.)*.5*uSunUp);
    float rim = smoothstep(cover+.22, cover+.05, c) * cl * pow(s, 4.) * uSunUp;
    sky = mix(sky, cc, cl*.88) + uSunCol*rim*.8;
    vec3 anti = normalize(e - uSunPos); float ang = acos(clamp(dot(d, anti), -1., 1.));
    float rk = (ang - .69)/.05;
    if (rk > 0. && rk < 1. && uSunUp > .2) glow += rainbow(1.-rk) * .32 * uJoy * (1.-uStorm) * smoothstep(0., .1, d.y);
  }
  col = col * (1. - haze*.8) + sky * haze + glow * air;
  o = vec4(col, 1.);
}`

const POINT_VS = HEAD + `
layout(location=0) in vec3 aP; layout(location=1) in float aS; layout(location=2) in vec4 aC;
uniform mat4 uVP; uniform float uScale;
out vec4 vC;
void main(){ gl_Position = uVP*vec4(aP,1.); gl_PointSize = clamp(aS*uScale/gl_Position.w, 1., 400.); vC = aC; }`
// Glows fall off softly (a gaussian, not a cone) so many together stay light,
// not white; cloud puffs are shaded as balls of vapour, lit on the sun's side.
const POINT_FS = HEAD + `
in vec4 vC; uniform float uAdd, uSoft, uLit; uniform vec3 uSunV, uSunC, uShadeC; out vec4 o;
void main(){ vec2 q = gl_PointCoord*2.-1.; float r = dot(q,q); if (r > 1.) discard;
  if (uLit > .5) {
    vec3 n = vec3(q.x, -q.y, sqrt(1.-r));
    float l = clamp(dot(n, uSunV)*.55 + .45, 0., 1.);
    o = vec4(mix(uShadeC, uSunC, l) * vC.rgb, pow(1.-r, 1.4) * vC.a); return;
  }
  if (uAdd > .5) { float a = (exp(-r*3.2) - .0408) / .9592 * vC.a; o = vec4(vC.rgb*a, a); return; }
  float a = pow(1.-r, uSoft) * vC.a; o = vec4(vC.rgb, a); }`

const LINE_VS = HEAD + `
layout(location=0) in vec3 aP; layout(location=1) in vec4 aC;
uniform mat4 uVP; out vec4 vC;
void main(){ gl_Position = uVP*vec4(aP,1.); vC = aC; }`
const LINE_FS = HEAD + `in vec4 vC; out vec4 o; void main(){ o = vC; }`

// Grass: one blade per instance, swaying in the wind, pressed flat where the
// creature's feet have landed; flowers are blades with a bloom at the tip.
const GRASS_VS = HEAD + `
layout(location=0) in vec2 aB;
layout(location=1) in vec4 aI;
layout(location=2) in vec4 aJ;
uniform mat4 uVP, uLVP; uniform float uTime, uWind; uniform vec4 uTrail[12];
out vec3 vC; out vec3 vW; out vec4 vL; out float vT;
void main(){
  bool flower = aJ.w >= 1.;
  float a = fract(aJ.w)*6.2831; vec2 side = vec2(cos(a), sin(a));
  float h = aI.w, t = aB.y;
  vec2 bend = vec2(0.);
  for (int i=0;i<12;i++){ vec4 tr = uTrail[i]; if (tr.z <= 0.) continue;
    vec2 d = aI.xz - tr.xy; float dl = length(d); float k = tr.z*smoothstep(tr.w, tr.w*.3, dl);
    bend += (dl > 1e-3 ? d/dl : side)*k*.9; h *= 1. - .55*k; }
  float s = sin(uTime*1.9 + aI.x*.8 + aI.z*.6) + .5*sin(uTime*3.7 + aI.z*1.4);
  bend += vec2(s*.06 + .03, s*.04) * uWind;
  float w = .04*(flower && t > .4 ? 2.4 : 1.)*(1. - t*.8);
  vec3 p = aI.xyz + vec3(side.x, 0., side.y)*aB.x*w;
  p.y += t*h; p.xz += bend*t*t*h;
  vC = flower ? (t > .4 ? aJ.rgb*1.25 : vec3(.16,.36,.1)*mix(.5, 1., t)) : aJ.rgb*mix(.45, 1.15, t);
  vT = t; vW = p; vL = uLVP*vec4(p,1.); gl_Position = uVP*vec4(p,1.);
}`
const GRASS_FS = HEAD + `
in vec3 vC; in vec3 vW; in vec4 vL; in float vT;
uniform vec3 uLightDir, uLightCol, uSkyAmb, uGroundAmb, uFogCol, uCam; uniform float uFog, uWet, uAOOn; uniform vec2 uRes;
uniform sampler2DShadow uShadow; uniform sampler2D uAO;
out vec4 o;
void main(){
  vec3 p = vL.xyz/vL.w*.5+.5;
  float sh = (p.x<0.||p.x>1.||p.y<0.||p.y>1.||p.z>1.) ? 1. : texture(uShadow, vec3(p.xy, p.z-.002));
  float ao = uAOOn > .5 ? texture(uAO, gl_FragCoord.xy/uRes).r : 1.;
  vec3 col = vC*(1. - .25*uWet) * (mix(uGroundAmb, uSkyAmb, .75)*ao*(.55 + .45*vT) + uLightCol*(.5 + .5*max(uLightDir.y, 0.))*sh*.85);
  float f = 1. - exp(-length(uCam - vW)*uFog);
  o = vec4(mix(col, uFogCol, f), 1.);
}`

const POST_VS = HEAD + `
out vec2 vUV;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.-1., 0., 1.); }`
// Bloom takes only what is truly bright, easing in, and never a blinding speck.
const BRIGHT_FS = HEAD + `
in vec2 vUV; uniform sampler2D uTex; out vec4 o;
void main(){ vec3 c = min(texture(uTex, vUV).rgb, vec3(12.)); float l = max(c.r, max(c.g, c.b));
  float k = clamp((l - 1.05)/1.3, 0., 1.); o = vec4(c*k*k, 1.); }`
const BLUR_FS = HEAD + `
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main(){ vec3 c = texture(uTex, vUV).rgb*.227027;
  c += (texture(uTex, vUV+uDir*1.3846).rgb + texture(uTex, vUV-uDir*1.3846).rgb)*.3162162;
  c += (texture(uTex, vUV+uDir*3.2307).rgb + texture(uTex, vUV-uDir*3.2307).rgb)*.0702703;
  o = vec4(c, 1.); }`
// The finish: miniature focus, bloom, sun rays, tone mapping, and a grade
// that follows the hour (golden at dawn and dusk, blue at night, grey in storms).
const FINAL_FS = HEAD + `
in vec2 vUV; uniform sampler2D uTex, uBloom, uRays, uBlur, uG;
uniform float uBloomK, uFlash, uExposure, uRayK, uDof, uFocus, uFocusY, uSat, uVig;
uniform vec3 uRayCol, uGain, uLift, uFlashCol;
out vec4 o;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14), 0., 1.); }
void main(){
  vec3 c = texture(uTex, vUV).rgb;
  if (uDof > 0.) {
    float z = min(texture(uG, vUV).a, 400.);
    float coc = smoothstep(.25, 1.2, abs(z - uFocus)/max(uFocus, 1.));
    coc = max(coc, smoothstep(.38, .62, abs(vUV.y - uFocusY))*.4)*.6;
    c = mix(c, texture(uBlur, vUV).rgb, clamp(coc*uDof, 0., 1.));
  }
  c += texture(uBloom, vUV).rgb*uBloomK;
  if (uRayK > 0.) c += texture(uRays, vUV).rgb*uRayCol*uRayK;
  c = c*uExposure + uFlash*uFlashCol;
  c = aces(c);
  c = c*uGain + uLift*(1.-c);
  float l = dot(c, vec3(.299,.587,.114)); c = mix(vec3(l), c, uSat);
  c = pow(clamp(c, 0., 1.), vec3(1./2.2));
  vec2 q = vUV-.5; c *= mix(1. - uVig, 1., smoothstep(.85, .2, length(q*vec2(1.15,1.))));
  o = vec4(c, 1.);
}`

let P = {}
const ok = (() => {
  if (gl === null) return false
  try {
    P.lit = program(LIT_VS, LIT_FS)
    P.depth = program(DEPTH_VS, DEPTH_FS)
    P.gbuf = program(GBUF_VS, GBUF_FS)
    P.ssao = program(POST_VS, SSAO_FS)
    P.aoblur = program(POST_VS, AOBLUR_FS)
    P.rays = program(POST_VS, RAYS_FS)
    P.water = program(WATER_VS, WATER_FS)
    P.sky = program(SKY_VS, SKY_FS)
    P.point = program(POINT_VS, POINT_FS)
    P.line = program(LINE_VS, LINE_FS)
    P.grass = program(GRASS_VS, GRASS_FS)
    P.bright = program(POST_VS, BRIGHT_FS)
    P.blur = program(POST_VS, BLUR_FS)
    P.final = program(POST_VS, FINAL_FS)
    return true
  } catch (error) {
    console.error(error)
    return false
  }
})()

// ------------------------------------------------------------------ buffers

const vao = (layout, usage = gl.STATIC_DRAW) => {
  const a = gl.createVertexArray(), b = gl.createBuffer()
  gl.bindVertexArray(a)
  gl.bindBuffer(gl.ARRAY_BUFFER, b)
  const stride = layout.reduce((s, [, n]) => s + n, 0) * 4
  let off = 0
  for (const [loc, n] of layout) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off); off += n * 4 }
  gl.bindVertexArray(null)
  return { a, b, count: 0, usage, floats: stride / 4 }
}
const upload = (buf, data) => {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf.b)
  gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : new Float32Array(data), buf.usage)
  buf.count = data.length / buf.floats
}
const LIT_LAYOUT = [[0, 3], [1, 3], [2, 3], [3, 1], [4, 1], [5, 1]]
// One grass blade: across (-1..1) and up (0..1); each instance places, colors and turns one.
const BLADE = new Float32Array([-1, 0, 1, 0, -.7, .45, 1, 0, .7, .45, -.7, .45, -.7, .45, .7, .45, 0, 1])

let G_ = null
const initBuffers = () => {
  G_ = {
    stat: vao(LIT_LAYOUT),
    fine: vao(LIT_LAYOUT),
    dyn: vao(LIT_LAYOUT, gl.DYNAMIC_DRAW),
    water: vao([[0, 3], [1, 1]]),
    add: vao([[0, 3], [1, 1], [2, 4]], gl.DYNAMIC_DRAW),
    alpha: vao([[0, 3], [1, 1], [2, 4]], gl.DYNAMIC_DRAW),
    cloud: vao([[0, 3], [1, 1], [2, 4]], gl.DYNAMIC_DRAW),
    lines: vao([[0, 3], [1, 4]], gl.DYNAMIC_DRAW),
    empty: gl.createVertexArray(),
    grass: (() => {
      const a = gl.createVertexArray(); gl.bindVertexArray(a)
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, BLADE, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib)
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1)
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(2, 1)
      gl.bindVertexArray(null)
      return { a, ib, count: 0 }
    })(),
  }
}

// ------------------------------------------------------------------ render targets

// ------------------------------------------------------------------ quality

// Three levels. On Auto the page steps down when frames run slow and back up
// when there is room to spare, so it stays smooth on any machine.
const QUALITY = [
  { name: 'Low', scale: .7, ssao: 0, refl: 0, rays: 0, dof: false, grass: 0, lod: 9 },
  { name: 'Medium', scale: .85, ssao: 8, refl: 4, rays: 32, dof: true, grass: .5, lod: 14 },
  { name: 'High', scale: 1, ssao: 16, refl: 2, rays: 48, dof: true, grass: 1, lod: 20 },
]
const Q = { mode: 'auto', level: 2, fps: 60, slow: 0, fast: 0, lockUntil: 0, probation: 0, timer: 0, frames: 0 }
const stored = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
const store = (key, value) => { try { localStorage.setItem(key, value) } catch { } }
Q.mode = stored('terrarium.quality', 'auto')
if (Q.mode !== 'auto') Q.level = clamp(Number(Q.mode) || 0, 0, 2)
let focusOn = stored('terrarium.focus', 'on') !== 'off'
// The air's glow over the disc, on unless this viewer turned it off; eased in and out.
let airOn = stored('terrarium.air', 'on') !== 'off', airK = airOn ? 1 : 0
const QL = () => QUALITY[Q.level]

const T = { w: 0, h: 0, own: [] }
const floatOk = ok && !!gl.getExtension('EXT_color_buffer_float')
const COLOR_FMT = floatOk ? gl.RGBA16F : gl.RGBA8
const tex = (w, h, fmt = COLOR_FMT) => {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  T.own.push(['t', t])
  return t
}
const fboFor = t => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); T.own.push(['f', f]); return f }
// A target with a depth buffer of its own, for passes that draw geometry.
const fboDepth = (t, w, h) => {
  const f = fboFor(t), rb = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb)
  T.own.push(['r', rb])
  return f
}

const SHADOW = 2048
let shadow = null
const initShadow = () => {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW, SHADOW)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const f = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, f)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t, 0)
  gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE)
  shadow = { t, f }
}

// The page's targets, sized to the window and the quality level; the old
// ones are let go so resizing never leaks.
const resize = () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75) * QL().scale
  const w = Math.max(2, Math.floor(innerWidth * dpr)), h = Math.max(2, Math.floor(innerHeight * dpr))
  if (w === T.w && h === T.h) return
  for (const [kind, o] of T.own) (kind === 't' ? gl.deleteTexture(o) : kind === 'f' ? gl.deleteFramebuffer(o) : gl.deleteRenderbuffer(o))
  T.own = []
  canvas.width = w; canvas.height = h
  T.w = w; T.h = h
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES))
  T.msaa = gl.createFramebuffer(); T.own.push(['f', T.msaa])
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.msaa)
  const rc = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rc)
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, COLOR_FMT, w, h)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rc)
  const rd = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rd)
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rd)
  T.own.push(['r', rc], ['r', rd])
  T.scene = tex(w, h); T.sceneF = fboFor(T.scene)
  const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1), qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2)
  T.half = tex(hw, hh); T.halfF = fboFor(T.half); T.hw = hw; T.hh = hh
  T.qa = tex(qw, qh); T.qaF = fboFor(T.qa); T.qb = tex(qw, qh); T.qbF = fboFor(T.qb); T.qw = qw; T.qh = qh
  // The pre-pass (facing and distance), occlusion, sun rays, the focus blur.
  T.g = tex(hw, hh); T.gF = fboDepth(T.g, hw, hh)
  T.ao = tex(hw, hh, gl.RGBA8); T.aoF = fboFor(T.ao); T.ao2 = tex(hw, hh, gl.RGBA8); T.ao2F = fboFor(T.ao2)
  T.rays = tex(hw, hh); T.raysF = fboFor(T.rays)
  T.dh = tex(hw, hh); T.dhF = fboFor(T.dh)
  T.da = tex(qw, qh); T.daF = fboFor(T.da); T.db = tex(qw, qh); T.dbF = fboFor(T.db)
  // The water's mirror.
  const rdiv = QL().refl || 4
  T.rw = Math.max(1, Math.floor(w / rdiv)); T.rh = Math.max(1, Math.floor(h / rdiv))
  T.refl = tex(T.rw, T.rh); T.reflF = fboDepth(T.refl, T.rw, T.rh)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
}

// ------------------------------------------------------------------ the island

let D = null            // the latest frame's data
let I = null            // the island derived from it
let version = -1
const born = new Map()  // feature id -> when it appeared, for the growing animation
let firstLoad = true
const halos = []        // glows that sit on static things
const emitters = []     // smoke, embers, mist
const blades = []       // windmills
const flags = []        // banners
const picks = []        // hover labels on static things

const level = (i, j) => {
  if (!I) return BOTTOM
  const G = I.G
  if (i < -G || j < -G || i >= G || j >= G) return BOTTOM
  return Math.max(BOTTOM, I.levels[(i + G) * 2 * G + (j + G)])
}
const inside = (i, j) => Math.hypot(i + .5, j + .5) <= I.seaRadius - .5
const cellAt = (x, z) => [Math.floor(x), Math.floor(z)]
const biomeAt = (i, j) => (I && inside(i, j) ? I.biome[(i + I.G) * 2 * I.G + (j + I.G)] : 0)
const groundY = (x, z) => { const [i, j] = cellAt(x, z); return level(i, j) * LH }
const seaY = () => (I ? I.sea * LH : 0)
const walkable = (i, j) => {
  if (!I || !inside(i, j)) return false
  const b = biomeAt(i, j)
  return b !== BIOME.seabed && b !== BIOME.river && b !== BIOME.lava && level(i, j) > I.sea + .2
}

const TOP = {
  [BIOME.seabed]: C('#b5aa84'), [BIOME.beach]: C('#e7d4a1'), [BIOME.meadow]: C('#88c063'), [BIOME.forest]: C('#4c8a3d'),
  [BIOME.dry]: C('#b8b46c'), [BIOME.rock]: C('#8f877b'), [BIOME.snow]: C('#eef3f7'), [BIOME.river]: C('#5d7d63'),
  [BIOME.lava]: C('#ff6a22'), [BIOME.marsh]: C('#6d9658'),
}
const STRATA = [C('#8a6a4c'), C('#7c5f45'), C('#8f7a62'), C('#6f655b'), C('#7a7068'), C('#5f5852')]

const BEVEL = .08
const buildTerrain = (m, water) => {
  const G = I.G, seed = I.seed
  const sea = I.sea
  for (let i = -G; i < G; i++) for (let j = -G; j < G; j++) {
    if (!inside(i, j)) continue
    const L = level(i, j), b = biomeAt(i, j), y = L * LH
    const v = .9 + .2 * rand2(i, j, seed + 21)
    let top = cmul(TOP[b] || TOP[BIOME.meadow], v)
    if (b === BIOME.meadow && rand2(i, j, seed + 5) < .18) top = cmix(top, C('#a7cf6e'), .5)
    const ao = (cx, cz) => {
      let n = 0
      for (const [a, c] of [[cx - 1, cz - 1], [cx, cz - 1], [cx - 1, cz], [cx, cz]]) if (inside(a, c) && level(a, c) > L) n++
      return 1 - .16 * n
    }
    const e = b === BIOME.lava ? 5 : 0
    // Where the ground drops to a lower terrace its edge is bevelled, so the
    // steps read soft rather than cut.
    const levelAt = (a, c) => (inside(a, c) ? level(a, c) : BOTTOM)
    const drops = (a, c) => levelAt(a, c) < L
    const dE = drops(i + 1, j), dW = drops(i - 1, j), dS = drops(i, j + 1), dN = drops(i, j - 1)
    const x0 = i + (dW ? BEVEL : 0), x1 = i + 1 - (dE ? BEVEL : 0), z0 = j + (dN ? BEVEL : 0), z1 = j + 1 - (dS ? BEVEL : 0)
    const yl = y - BEVEL
    m.mat = MAT.ground
    const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
    m.quad(...corners.map(([x, z]) => [x, y, z]), [0, 1, 0], top, e, corners.map(([x, z]) => cmul(top, ao(Math.round(x), Math.round(z)))))
    const lip = cmul(top, .8)
    // A neighbour along the bevel still standing full height leaves a notch to close.
    const solidBeside = (a, c, ex, ez) => { const n = levelAt(a, c); return n > L || (n === L && !drops(a + ex, c + ez)) }
    if (dE) {
      const za = dN ? z0 : j, zb = dS ? z1 : j + 1
      m.quad([x1, y, za], [x1, y, zb], [i + 1, yl, zb], [i + 1, yl, za], [1, 1, 0], lip, e)
      if (!dS && solidBeside(i, j + 1, 1, 0)) m.triW([x1, y, j + 1], [i + 1, yl, j + 1], [i + 1, y, j + 1], [0, 0, -1], lip)
      if (!dN && solidBeside(i, j - 1, 1, 0)) m.triW([x1, y, j], [i + 1, y, j], [i + 1, yl, j], [0, 0, 1], lip)
    }
    if (dW) {
      const za = dN ? z0 : j, zb = dS ? z1 : j + 1
      m.quad([x0, y, za], [i, yl, za], [i, yl, zb], [x0, y, zb], [-1, 1, 0], lip, e)
      if (!dS && solidBeside(i, j + 1, -1, 0)) m.triW([x0, y, j + 1], [i, y, j + 1], [i, yl, j + 1], [0, 0, -1], lip)
      if (!dN && solidBeside(i, j - 1, -1, 0)) m.triW([x0, y, j], [i, yl, j], [i, y, j], [0, 0, 1], lip)
    }
    if (dS) {
      const xa = dW ? x0 : i, xb = dE ? x1 : i + 1
      m.quad([xa, y, z1], [xa, yl, j + 1], [xb, yl, j + 1], [xb, y, z1], [0, 1, 1], lip, e)
      if (!dE && solidBeside(i + 1, j, 0, 1)) m.triW([i + 1, y, z1], [i + 1, yl, j + 1], [i + 1, y, j + 1], [-1, 0, 0], lip)
      if (!dW && solidBeside(i - 1, j, 0, 1)) m.triW([i, y, z1], [i, y, j + 1], [i, yl, j + 1], [1, 0, 0], lip)
    }
    if (dN) {
      const xa = dW ? x0 : i, xb = dE ? x1 : i + 1
      m.quad([xa, y, z0], [xb, y, z0], [xb, yl, j], [xa, yl, j], [0, 1, -1], lip, e)
      if (!dE && solidBeside(i + 1, j, 0, -1)) m.triW([i + 1, y, z0], [i + 1, y, j], [i + 1, yl, j], [-1, 0, 0], lip)
      if (!dW && solidBeside(i - 1, j, 0, -1)) m.triW([i, y, z0], [i, yl, j], [i, y, j], [1, 0, 0], lip)
    }
    // Corners where two sides drop: a sloped patch joins the bevels.
    for (const [sx, sz, ex, ez] of [[dE, dS, 1, 1], [dW, dS, -1, 1], [dE, dN, 1, -1], [dW, dN, -1, -1]]) {
      if (!sx || !sz) continue
      const ix = ex > 0 ? x1 : x0, iz = ez > 0 ? z1 : z0, ox = ex > 0 ? i + 1 : i, oz = ez > 0 ? j + 1 : j
      m.quad([ix, y, iz], [ox, yl, iz], [ox, yl, oz], [ix, yl, oz], [ex, 1, ez], lip, e)
    }
    m.mat = MAT.cliff
    if (b === BIOME.river) {
      const wy = (L + .55) * LH
      for (const [a, c, d2] of [[[i, wy, j], [i + 1, wy, j], [i + 1, wy, j + 1]], [[i, wy, j], [i + 1, wy, j + 1], [i, wy, j + 1]]].map(t => t)) water.push(...a, 1.1, ...c, 1.1, ...d2, 1.1)
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + dx, nj = j + dz
      const low = inside(ni, nj) ? level(ni, nj) : BOTTOM
      if (low >= L) continue
      const x0 = dx === 1 ? i + 1 : dx === -1 ? i : i, x1 = dx === 1 ? i + 1 : dx === -1 ? i : i + 1
      const z0 = dz === 1 ? j + 1 : dz === -1 ? j : j, z1 = dz === 1 ? j + 1 : dz === -1 ? j : j + 1
      const ex0 = dx !== 0 ? x0 : i, ex1 = dx !== 0 ? x1 : i + 1
      const ez0 = dz !== 0 ? z0 : j, ez1 = dz !== 0 ? z1 : j + 1
      const shade = .72 + .18 * Math.max(0, dx * .62 + dz * .78)
      for (let k = Math.floor(low); k < L; k++) {
        const ya = Math.max(k, low) * LH, yb = k + 1 >= L ? L * LH - BEVEL : (k + 1) * LH
        let col = STRATA[((k % STRATA.length) + STRATA.length) % STRATA.length]
        if (k === L - 1) col = b === BIOME.beach ? C('#cdb27f') : b === BIOME.snow || b === BIOME.rock ? C('#8b8379') : b === BIOME.lava ? C('#3a2218') : C('#7d6247')
        const dim = cmul(col, shade * (.7 + .3 * sstep(BOTTOM, L, k)))
        m.quad([ex0, ya, ez0], [ex1, ya, ez1], [ex1, yb, ez1], [ex0, yb, ez0], [dx, 0, dz], dim, b === BIOME.lava && k === L - 1 ? 1.2 : 0)
      }
    }
    m.mat = MAT.plain
  }
  // Waterfalls: a sheet of falling water down the drop, and mist at its foot.
  for (const f of I.waterfalls) {
    const dx = f.ti - f.i, dz = f.tj - f.j
    const ex = dx === 1 ? f.i + 1 : dx === -1 ? f.i : null, ez = dz === 1 ? f.j + 1 : dz === -1 ? f.j : null
    const yt = (f.top + .55) * LH, yf = (f.foot + .5) * LH
    const a = ex !== null ? [ex, yt, f.j + .1] : [f.i + .1, yt, ez], b = ex !== null ? [ex, yt, f.j + .9] : [f.i + .9, yt, ez]
    const push = (p, s) => water.push(p[0] + (dx * s), p[1], p[2] + (dz * s), -1)
    const c = [b[0], yf, b[2]], d = [a[0], yf, a[2]]
    for (const p of [a, b, c, a, c, d]) push(p, .04)
    emitters.push({ kind: 'mist', p: [f.ti + .5, yf + .05, f.tj + .5], rate: 3 })
  }
  if (I.vent) emitters.push({ kind: 'volcano', p: [I.vent.i + .5, level(I.vent.i, I.vent.j) * LH + .3, I.vent.j + .5], rate: 4 + I.heat * 8 })
}
const isGrassy = b => b === BIOME.meadow || b === BIOME.forest || b === BIOME.marsh || b === BIOME.dry

const LEAF = [C('#3e7a3a'), C('#4b8a3f'), C('#5d9a42'), C('#6aa64a')]
const buildDecor = m => {
  const G = I.G, seed = I.seed
  for (let i = -G; i < G; i++) for (let j = -G; j < G; j++) {
    if (!inside(i, j)) continue
    const at = (i + G) * 2 * G + (j + G)
    const d = I.decor[at]
    const y = level(i, j) * LH
    const r1 = rand2(i, j, seed + 101), r2 = rand2(j, i, seed + 103)
    const x = i + .5 + (r1 - .5) * .4, z = j + .5 + (r2 - .5) * .4
    const s = .8 + r1 * .45
    const { P } = frame(m, x, y, z, r2 * TAU, s)
    const leaf = LEAF[Math.floor(r1 * 4) % 4]
    switch (d) {
      case DECOR.pine: case DECOR.snowpine: {
        P(UNIT.cyl6, 0, 0, 0, .09, .28, .09, C('#5b3d27'))
        P(UNIT.cone8, 0, .18, 0, .62, .55, .62, C('#2f6a3a'), 0, .5)
        P(UNIT.cone8, 0, .48, 0, .48, .5, .48, d === DECOR.snowpine ? C('#e8eef2') : C('#37753f'), 0, .9)
        P(UNIT.cone8, 0, .78, 0, .32, .42, .32, d === DECOR.snowpine ? C('#f4f7f9') : C('#3f8246'), 0, 1.2)
        break
      }
      case DECOR.oak: {
        P(UNIT.cyl6, 0, 0, 0, .1, .4, .1, C('#6b4a2f'))
        const autumn = rand2(i, j, seed + 7) < .12
        const c1 = autumn ? C('#d9822b') : leaf
        P(UNIT.ico0, 0, .3, 0, .62, .52, .62, c1, 0, .7)
        P(UNIT.ico0, .14, .52, .06, .42, .38, .42, cmul(c1, 1.15), 0, 1)
        P(UNIT.ico0, -.16, .45, -.1, .36, .32, .36, cmul(c1, .9), 0, 1)
        break
      }
      case DECOR.birch: {
        P(UNIT.cyl6, 0, 0, 0, .06, .7, .06, C('#efeae0'))
        P(UNIT.ico0, 0, .45, 0, .34, .6, .34, C('#9cc95d'), 0, 1)
        break
      }
      case DECOR.bush: {
        P(UNIT.ico0, 0, 0, 0, .34, .24, .34, cmul(leaf, .9), 0, .4)
        P(UNIT.ico0, .12, 0, .08, .24, .2, .24, leaf, 0, .4)
        if (r2 < .4) P(UNIT.ico0, -.04, .14, .1, .05, .05, .05, C('#d6455b'))
        break
      }
      case DECOR.rock: {
        P(UNIT.ico0, 0, -.04, 0, .34, .22, .28, C('#8d877e'), 0, 0, { rz: r1 * .5 })
        if (r2 < .5) P(UNIT.ico0, .16, -.03, .1, .16, .12, .14, C('#9a948b'))
        break
      }
      case DECOR.flowers: {
        const hues = ['#f4d35e', '#ee6c8b', '#ffffff', '#b28cff', '#ff9f43']
        for (let k = 0; k < 5; k++) {
          const a = k * 1.3 + r1 * 6, rr = .1 + (k % 3) * .08
          P(UNIT.cyl6, Math.cos(a) * rr, 0, Math.sin(a) * rr, .015, .12, .015, C('#4f8a3a'), 0, 1)
          P(UNIT.ico0, Math.cos(a) * rr, .11, Math.sin(a) * rr, .06, .05, .06, C(hues[(k + Math.floor(r2 * 5)) % 5]), 0, 1)
        }
        break
      }
      case DECOR.reeds: {
        for (let k = 0; k < 6; k++) {
          const a = k * 1.1 + r1 * 4, rr = .05 + (k % 3) * .09
          P(UNIT.cube, Math.cos(a) * rr, 0, Math.sin(a) * rr, .025, .4 + (k % 3) * .08, .025, C('#7f9a52'), 0, 1.4)
          if (k % 2 === 0) P(UNIT.cyl6, Math.cos(a) * rr, .32, Math.sin(a) * rr, .045, .1, .045, C('#6b4a2f'), 0, 1.4)
        }
        break
      }
      case DECOR.palm: {
        let px = 0, py = 0
        for (let k = 0; k < 4; k++) { P(UNIT.cyl6, px, py, 0, .08 - k * .01, .2, .08 - k * .01, C('#8a6a45'), 0, k * .3, { rz: -.12 * k }); px += .025 * (k + 1); py += .19 }
        for (let k = 0; k < 6; k++) P(UNIT.cube, px, py, 0, .06, .5, .01, C('#4f9a3c'), 0, 1.4, { ry: k * TAU / 6, rx: 1.95 })
        P(UNIT.ico0, px, py - .08, 0, .08, .08, .08, C('#6b4a2f'))
        break
      }
      case DECOR.mushroom: {
        P(UNIT.cyl6, 0, 0, 0, .05, .1, .05, C('#f1e9da'))
        P(UNIT.ico0, 0, .07, 0, .16, .09, .16, C('#d8342c'))
        break
      }
      default: {
        const b = I.biome[at]
        if ((b === BIOME.meadow || b === BIOME.forest) && r2 < .45) {
          for (let k = 0; k < 3; k++) P(UNIT.pyr, (rand2(i, j, k) - .5) * .7, 0, (rand2(j, i, k) - .5) * .7, .05, .12, .05, cmul(leaf, 1.1), 0, 1.5)
        }
      }
    }
  }
}

// ------------------------------------------------------------------ structures

const WALL = C('#efe3cc'), WINDOW = C('#ffcf73'), DOOR = C('#5a3b2a')
// Each language builds in its own architecture (hooks/world.ts vernacular):
// how tall a floor is and what its walls are made of.
const ARCH_LOOK = {
  townhouse: { fh: .32, wall: WALL }, cottage: { fh: .3, wall: C('#f3ead6') }, fort: { fh: .3, wall: C('#6e625a') },
  workshop: { fh: .3, wall: C('#d6cfc2') }, keep: { fh: .34, wall: C('#a39e94') }, painted: { fh: .32, wall: WALL },
  pavilion: { fh: .3, wall: C('#fbf3e6') }, library: { fh: .36, wall: C('#e9dfc9') }, vault: { fh: .27, wall: C('#c9d3dc') },
  shed: { fh: .3, wall: C('#9a7652') }, silo: { fh: .27, wall: C('#d7c39a') }, watchtower: { fh: .42, wall: C('#a39e96') },
}
// Islands from before languages were known: by the old file styles.
const ARCH_OF_STYLE = { code: 'townhouse', doc: 'library', config: 'vault', web: 'pavilion', test: 'watchtower', data: 'silo' }
// Doors in a few colors, by the file's name.
const DOORS = [C('#5a3b2a'), C('#7a2e2a'), C('#2f4a5a'), C('#3f5a2f'), C('#6b4a2a'), C('#4a3a5a')]
const BOOKS = [C('#8c3b3b'), C('#3b5b8c'), C('#4f7a3b'), C('#b08a3b'), C('#6b3b8c')]
// History in the walls (hooks/world.ts onEdited, weathering): planks over a
// FIXME's window, blooms in a well-commented file's boxes, moss and ivy on a
// file left alone, a patch where a failed edit was made good, a crane for TODOs.
const PLANK = C('#9a7350'), MOSS = C('#5d7a3a'), WEATHERED = C('#8f9384'), CRANE = C('#e2b33a')
const BLOOMS = [C('#e0506e'), C('#f2c14e'), C('#c86bd6'), C('#ff8a5c')]
const IVY = [C('#3f6b2c'), C('#4f7d36'), C('#5f8c3e'), C('#35602a')]
// Each prompt's edits share a color, so one prompt's work matches across the town.
const turnColor = turn => hsl((turn * 137.508 + 20) % 360, .62, .56)
// How weathered a building is, 0 to 4, by how long its file has been left alone (as hooks/world.ts weathering).
const weathering = f => {
  if (!f.touchedAt || !D.now) return 0
  const minutes = (D.now - f.touchedAt) / 60000
  return minutes < 20 ? 0 : minutes < 45 ? 1 : minutes < 90 ? 2 : minutes < 150 ? 3 : 4
}
const structure = (m, f, k, collect) => {
  const L = level(f.x, f.y), by = L * LH
  const h = hashStr(f.key || String(f.id))
  const ry = (h % 4) * (Math.PI / 2) + ((h >> 3) % 7 - 3) * .04
  const { W, P } = frame(m, f.x + .5, by, f.y + .5, ry, k)
  // Small parts go in the fine mesh, drawn only near the eye (into the same mesh while growing in).
  const MQ = FM || m, PF = FM ? frame(FM, f.x + .5, by, f.y + .5, ry, k).P : P
  const size = Math.min(f.size || 1, 9)
  let top = .6
  const halo = (p, c, s, night = false) => { if (collect) halos.push({ p, c, s, night }) }
  const emit = (kind, p, rate) => { if (collect) emitters.push({ kind, p, rate }) }
  const isHot = glowOf(f.touchedAt) > .3
  // At work this moment (hooks/world.ts busyOf): its door stands open on a lit room.
  const isBusy = (D.busy || []).includes(f.id)
  // Windows on four faces, a floor at a time. Its file's FIXMEs board some up
  // (spread over the building); its comments put flower boxes under others.
  const windowsOn = (half, floors, fh, base = 0, sh) => {
    const n = Math.min(floors, 12), total = n * 4
    const boards = sh ? Math.min(sh.fixmes || 0, 4, total) : 0, every = boards ? Math.floor(total / boards) : 0
    const flowers = sh ? sh.flowers || 0 : 0
    let boarded = 0
    for (let fl = 0; fl < n; fl++) for (const [s, [nx, nz]] of [[1, 0], [-1, 0], [0, 1], [0, -1]].entries()) {
      const ox = nx * (half + .005), oz = nz * (half + .005), rot = nx ? Math.PI / 2 : 0, y = base + fh * (fl + .38), i = fl * 4 + s
      if (boards && i % every === 0 && boarded < boards) {
        boarded++
        P(UNIT.cube, ox, y, oz, .11, .12, .04, C('#2a2320'), 0, 0, { ry: rot })
        for (const tilt of [.62, -.62]) PF(UNIT.cube, ox + nx * .024, y + .048, oz + nz * .024, .15, .026, .01, PLANK, 0, 0, { ry: rot, rz: tilt })
        continue
      }
      P(UNIT.cube, ox, y, oz, .11, .12, .04, WINDOW, isHot ? 2 : -1.6, 0, { ry: rot })
      if (fl < 3) halo(W(ox * 1.15, base + fh * (fl + .45), oz * 1.15), [1, .7, .35], .55, !isHot)
      if (flowers && (i * .618 + h * .0013) % 1 < flowers) {
        PF(UNIT.cube, ox + nx * .026, y - .036, oz + nz * .026, .14, .036, .05, C('#7a5235'), 0, 0, { ry: rot })
        PF(UNIT.cube, ox + nx * .026, y, oz + nz * .026, .12, .03, .036, BLOOMS[(i + h) % BLOOMS.length], 0, .3, { ry: rot })
      }
    }
  }
  if (f.isScorched === true) {
    P(UNIT.cyl12, 0, .005, 0, .95, .02, .95, C('#1d1714'))
    emit('fire', W(.25, .05, .2), 6)
  }
  switch (f.kind) {
    case 'tree': {
      const count = size >= 5 ? 3 : size >= 3 ? 2 : 1
      for (let q = 0; q < count; q++) {
        const ox = q === 0 ? 0 : q === 1 ? -.25 : .25, oz = q === 0 ? 0 : -.18
        const sc = (q === 0 ? 1 : .72) * (.85 + .12 * Math.min(size, 6))
        P(UNIT.cyl6, ox, 0, oz, .1 * sc, .45 * sc, .1 * sc, C('#6b4a2f'))
        if ((h + q) % 3 !== 0) {
          P(UNIT.cone8, ox, .3 * sc, oz, .6 * sc, .55 * sc, .6 * sc, C('#2f6e3d'), 0, .6)
          P(UNIT.cone8, ox, .62 * sc, oz, .44 * sc, .5 * sc, .44 * sc, C('#3f8a4c'), 0, 1)
        } else {
          const c = hsl(80 + (h % 50), .45, .42)
          P(UNIT.ico1, ox, .3 * sc, oz, .62 * sc, .6 * sc, .62 * sc, c, 0, .8)
        }
        top = Math.max(top, 1.1 * sc)
      }
      break
    }
    case 'house': {
      // Architecture by language, shape by the file itself (hooks/world.ts
      // measure): a floor for every doubling of its length, a footprint as
      // wide as its lines run, a wing for every few functions, a tower for
      // each type, a pennant for each export. A file not measured yet stands
      // as tall as it has been worked.
      const sh = f.shape
      const kit = (D.kits && D.kits[f.id]) || {}
      const arch = f.arch || ARCH_OF_STYLE[f.style || 'code'] || 'townhouse'
      // A file left alone weathers: its roof fades toward lichen grey.
      const stage = weathering(f)
      const aged = c => stage ? cmix(c, WEATHERED, .11 * stage) : c
      const accent = aged(f.accent ? C(f.accent) : hsl(f.hue, .55, .47))
      const look = ARCH_LOOK[arch] || ARCH_LOOK.townhouse
      const floors = Math.min(sh ? sh.floors : size, 12)
      const wings = sh ? Math.min(3, sh.wings) : 0
      const foot = Math.min(sh ? sh.footprint : .56, wings ? .56 : .7), half = foot / 2
      const wall = arch === 'painted' ? cmix(WALL, accent, .45) : look.wall
      const fh = look.fh, hgt = arch === 'shed' ? .32 + floors * .1 : floors * fh
      const round = arch === 'library' || arch === 'silo'
      // A roof in the manner of its architecture over a block w × d at height y; k shrinks it for a wing.
      const roof = (ox, oz, w, d, y, k = 1) => {
        switch (arch) {
          case 'cottage': P(UNIT.ico1, ox, y - .14 * k, oz, w + .12, .52 * k, d + .12, accent); return y + .38 * k
          case 'fort': case 'keep': {
            const stone = cmul(look.wall, .82)
            P(UNIT.cube, ox, y, oz, w + .04, .05, d + .04, stone)
            const n = Math.max(2, Math.round(w / .13)), m2 = Math.max(2, Math.round(d / .13))
            for (const s of [-1, 1]) {
              for (let q = 0; q < n; q++) P(UNIT.cube, ox + ((q + .5) / n - .5) * w, y + .05, oz + s * d / 2, .06, .09 * k, .05, stone)
              for (let q = 0; q < m2; q++) P(UNIT.cube, ox + s * w / 2, y + .05, oz + ((q + .5) / m2 - .5) * d, .05, .09 * k, .06, stone)
            }
            return y + .14 * k
          }
          case 'workshop':
            for (let q = 0; q < 3; q++) P(UNIT.wedge, ox, y, oz - d / 2 + (q + .5) * d / 3, w + .06, .24 * k, d / 3, q % 2 ? cmul(accent, .8) : accent)
            return y + .24 * k
          case 'shed': P(UNIT.cube, ox, y + .05 * k, oz, w + .14, .04, d + .16, accent, 0, 0, { rx: -.32 }); return y + .14 * k
          case 'library': P(UNIT.cone10, ox, y, oz, w + .12, .62 * k, d + .12, accent); return y + .62 * k
          case 'silo': P(UNIT.ico1, ox, y - .2 * k, oz, w, .5 * k, d, accent, .2); return y + .3 * k
          case 'vault': P(UNIT.ico1, ox, y - .22 * k, oz, w * .86, .52 * k, d * .86, accent); return y + .3 * k
          case 'painted': P(UNIT.wedge, ox, y, oz, w + .14, .4 * k, d + .14, aged(C('#8c5a44'))); return y + .4 * k
          default: P(UNIT.wedge, ox, y, oz, w + .14, .42 * k, d + .14, accent); return y + .42 * k
        }
      }
      // How high the main roof stands over a point of the plot, for moss to sit on (undefined off it).
      const dome = (y0, sy, rx, r) => (r < rx ? y0 + sy / 2 + sy / 2 * Math.sqrt(1 - (r / rx) ** 2) : undefined)
      const roofAt = (px, pz, body, y) => {
        const r = Math.hypot(px, pz), slope = (H, half, z) => (Math.abs(z) < half ? y + H * (1 - Math.abs(z) / half) : undefined)
        switch (arch) {
          case 'cottage': return dome(y - .14, .52, (body + .12) / 2, r)
          case 'silo': return dome(y - .2, .5, body / 2, r)
          case 'vault': return dome(y - .22, .52, body * .43, r)
          case 'library': return r < (body + .12) / 2 ? y + .62 * (1 - r / ((body + .12) / 2)) : undefined
          case 'pavilion': return r < body * .8 ? y + .55 * (1 - r / (body * .8)) : undefined
          case 'fort': case 'keep': case 'watchtower': return y + .05
          case 'workshop': { const third = body / 3; return slope(.24, third / 2, ((pz + body / 2) % third) - third / 2) }
          case 'shed': return undefined
          case 'painted': return slope(.4, (body + .14) / 2, pz)
          default: return slope(.42, (body + .14) / 2, pz)
        }
      }
      // The walls everything below hangs on: half their width, their height, whether round.
      let wallHalf, wallH, isRound = round
      let roofTop
      if (arch === 'watchtower') {
        const tw = Math.min(foot, .5) * .8, th = floors * fh + .3
        P(UNIT.cube, 0, 0, 0, tw, th, tw, look.wall)
        wallHalf = tw / 2; wallH = th
        windowsOn(tw / 2, floors, fh, 0, sh)
        for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P(UNIT.cube, ox * tw * .38, th, oz * tw * .38, .1, .12, .1, C('#8e8981'))
        P(UNIT.cyl6, 0, th, 0, .025, .5, .025, C('#5b5650'))
        P(UNIT.cube, .11, th + .36, 0, .22, .12, .01, testFlagColor(f))
        P(UNIT.cube, 0, th * .5, tw / 2 + .004, tw * .9, .05, .01, accent)
        roofTop = th + .5
      } else {
        const body = round ? foot * .84 : foot, face = body / 2
        P(round ? UNIT.cyl12 : UNIT.cube, 0, 0, 0, body, hgt, body, wall)
        wallHalf = face; wallH = hgt
        if (arch === 'townhouse' || arch === 'painted' || arch === 'cottage') P(UNIT.cube, 0, hgt * .02, 0, body + .04, .06, body + .04, C('#b7a27f'))
        // An iron fort is banded in its language's rust.
        if (arch === 'fort') for (let fl = 1; fl < floors; fl += 2) P(UNIT.cube, 0, fl * fh, 0, body + .02, .035, body + .02, cmix(look.wall, accent, .55))
        if (arch === 'painted') for (let fl = 1; fl < floors; fl++) P(UNIT.cube, 0, fl * fh - .015, 0, body + .015, .03, body + .015, C('#fffaf0'))
        windowsOn(face, arch === 'shed' ? 1 : floors, arch === 'shed' ? hgt : fh, 0, sh)
        const wide = arch === 'workshop', dw = wide ? .3 : .15, dh = wide ? .28 : .24, door = DOORS[(h >>> 5) % DOORS.length]
        if (isBusy) {
          P(UNIT.cube, 0, 0, face + .004, dw * .92, dh * .95, .012, C('#ffcf73'), 2.2)
          P(UNIT.cube, -dw / 2 + Math.cos(-1.2) * dw / 2, 0, face + .006 - Math.sin(-1.2) * dw / 2, dw, dh, .025, door, 0, 0, { ry: -1.2 })
          halo(W(0, .1, face + .22), [1, .72, .38], .8)
        } else P(UNIT.cube, 0, 0, face + .006, dw, dh, .03, door)
        if (arch === 'painted') for (let q = 0; q < 5; q++) PF(UNIT.cube, -.16 + q * .08, .3, face + .05, .08, .015, .12, q % 2 ? C('#fffaf0') : accent, 0, 0, { rx: .35 })
        if (arch === 'library') for (let q = 0; q < 6; q++) PF(UNIT.cube, .1 + q * .035, .02, face + .01, .03, .1 + (q % 3) * .02, .03, BOOKS[q % BOOKS.length])
        if (arch === 'shed') for (let q = 0; q < 3; q++) PF(UNIT.cyl6, face + .05, 0, -.12 + q * .11, .015, .32, .015, C('#6b4a2f'), 0, 0, { rz: .22 })
        if (arch === 'pavilion') {
          const n = 8, r = body * .8
          for (let q = 0; q < n; q++) {
            const a0 = q / n * TAU, a1 = (q + 1) / n * TAU
            const A = W(Math.cos(a0) * r, hgt, Math.sin(a0) * r), B = W(Math.cos(a1) * r, hgt, Math.sin(a1) * r), Ap = W(0, hgt + .55, 0)
            const n0 = norm(cross(sub(B, A), sub(Ap, A)))
            m.tri(...(n0[1] > 0 ? [A, B, Ap] : [A, Ap, B]), q % 2 ? C('#fbf3e6') : accent)
          }
          P(UNIT.cyl6, 0, hgt + .5, 0, .02, .3, .02, C('#555'))
          P(UNIT.cube, .07, hgt + .72, 0, .14, .07, .01, accent)
          roofTop = hgt + .55
        } else roofTop = roof(0, 0, body, body, hgt)
        const peak = roofTop
        if (arch === 'vault') { P(UNIT.cyl6, 0, roofTop - .05, 0, .03, .25, .03, C('#555')); P(UNIT.ico0, 0, roofTop + .2, 0, .06, .06, .06, C('#ff5d5d'), 2.5) }
        if (arch === 'townhouse' || arch === 'cottage' || arch === 'painted') {
          P(UNIT.cube, face * .6, hgt + .12, face * .4, .1, .32, .1, C('#8c4a3a'))
          // A wisp from the chimney only while someone's home: edited these last minutes.
          if (isHot) emit('chimney', W(face * .6, hgt + .48, face * .4), .25)
        }
        // Wings: an annex for every few of its parts, each with a lit window and its own lower roof.
        const wd = .13, wingH = Math.max(fh, hgt * .55)
        const spots = [[face + wd / 2, 0, wd, body * .6], [-(face + wd / 2), 0, wd, body * .6], [0, -(face + wd / 2), body * .6, wd]]
        for (let q = 0; q < wings; q++) {
          const [ox, oz, w, d] = spots[q]
          P(UNIT.cube, ox, 0, oz, w, wingH, d, cmul(wall, .94))
          PF(UNIT.cube, ox + Math.sign(ox) * (w / 2 + .004), wingH * .45, oz + Math.sign(oz) * (d / 2 + .004), ox ? .01 : .09, .1, oz ? .01 : .09, WINDOW, isHot ? 2 : -1.6)
          roof(ox, oz, w, d, wingH, .55)
        }
        // Towers: one for each type it declares, at its corners.
        let towerTop = 0
        for (let q = 0; q < Math.min(3, sh ? sh.towers : 0); q++) {
          const [sx, sz] = [[-1, -1], [1, -1], [-1, 1]][q], tx = sx * (face - .02), tz = sz * (face - .02), th = hgt + fh * 1.3
          const square = arch === 'fort' || arch === 'keep'
          P(square ? UNIT.cube : UNIT.cyl8, tx, 0, tz, .17, th, .17, cmul(wall, .9))
          PF(UNIT.cube, tx + sx * .086, th * .7, tz, .005, .07, .05, WINDOW, isHot ? 2 : -1.6)
          if (square) P(UNIT.cube, tx, th, tz, .21, .06, .21, cmul(look.wall, .8))
          else P(UNIT.cone8, tx, th, tz, .23, .3, .23, accent)
          towerTop = Math.max(towerTop, th + (square ? .06 : .3))
        }
        // Pennants: one for each thing it exports, along the ridge.
        const pn = sh ? Math.min(4, sh.pennants) : 0
        for (let q = 0; q < pn; q++) {
          const px = (q - (pn - 1) / 2) * body * .28 + (kit.spire && pn % 2 ? body * .14 : 0)
          PF(UNIT.cyl6, px, roofTop - .04, 0, .012, .22, .012, C('#5b4636'))
          PF(UNIT.cube, px + .045, roofTop + .1, 0, .09, .055, .006, q % 2 ? C('#fffaf0') : accent, .3)
        }
        // ---- The kit of parts (hooks/world.ts kitsOf), each for something true of the file.
        // A spire on an entry point.
        if (kit.spire) {
          P(UNIT.cyl8, 0, peak - .06, 0, .12, .16, .12, cmul(wall, .92))
          P(UNIT.cone8, 0, peak + .1, 0, .14, .55, .14, cmul(accent, .85))
          PF(UNIT.ico0, 0, peak + .64, 0, .05, .05, .05, C('#e3c26b'), .6)
          towerTop = Math.max(towerTop, peak + .7)
        }
        // A clock face when two or more files import it, its hands at the hour it last changed.
        if (kit.clock) {
          const cx = face * .55, cy = Math.max(.12, hgt - .17), cz = round ? Math.sqrt(Math.max(0, face * face - cx * cx)) : face
          P(UNIT.cyl12, cx, cy, cz + .002, .15, .012, .15, C('#3a3330'), 0, 0, { rx: Math.PI / 2 })
          P(UNIT.cyl12, cx, cy, cz + .005, .12, .012, .12, C('#f4ecd8'), .25, 0, { rx: Math.PI / 2 })
          const [hr, mn] = kit.clock
          PF(UNIT.cube, cx, cy, cz + .019, .012, .035, .005, C('#222'), 0, 0, { rz: -(hr + mn / 60) / 12 * TAU })
          PF(UNIT.cube, cx, cy, cz + .021, .008, .052, .005, C('#222'), 0, 0, { rz: -mn / 60 * TAU })
        }
        // A dormer for each file it imports, looking out from its roof.
        for (const [q, [dx, dz]] of [[-.22, .24], [.22, .24], [-.22, -.24], [.22, -.24]].entries()) {
          if (q >= (kit.dormers || 0)) break
          const px = dx * body, pz = dz * body, y = roofAt(px, pz, body, hgt)
          if (y === undefined) continue
          const facing = ['townhouse', 'painted', 'workshop', 'fort', 'keep'].includes(arch) || !ARCH_LOOK[arch] ? [0, Math.sign(pz)] : norm([px, 0, pz]).filter((_, k) => k !== 1)
          const rot = Math.atan2(facing[0], facing[1])
          P(UNIT.cube, px, y - .07, pz, .1, .13, .1, cmul(wall, .97), 0, 0, { ry: rot })
          P(UNIT.pyr, px, y + .06, pz, .13, .08, .13, accent, 0, 0, { ry: rot })
          PF(UNIT.cube, px + facing[0] * .05, y - .03, pz + facing[1] * .05, .06, .06, .012, WINDOW, isHot ? 2 : -1.6, 0, { ry: rot })
        }
        // A balcony for every two times Claude read it, up the side away from the door.
        let balconies = 0
        for (let fl = floors - 1; fl >= 1 && balconies < (kit.balconies || 0); fl--) {
          const y = fh * fl + .01
          if (wings >= 2 && y < wingH + .02) break
          balconies++
          P(UNIT.cube, -(face + .06), y, 0, .12, .025, .26, cmul(wall, .8))
          for (let q = 0; q < 4; q++) PF(UNIT.cube, -(face + .115), y + .025, -.11 + q * .073, .01, .08, .01, C('#3a3a3a'))
          PF(UNIT.cube, -(face + .115), y + .1, 0, .012, .012, .26, C('#3a3a3a'))
          for (const s of [-1, 1]) PF(UNIT.cube, -(face + .06), y + .1, s * .125, .11, .012, .012, C('#3a3a3a'))
        }
        // A bay window when its lines run wide.
        if (kit.bay && !round) {
          const hi = floors >= 2, y = fh * (hi ? 1 : 0) + fh * .2, bx = hi ? 0 : face * .5, bz = face + .045, bw = hi ? .24 : .16
          P(UNIT.cube, bx, y, bz, bw, fh * .62, .09, cmul(wall, .96))
          P(UNIT.cube, bx, y - .02, bz, bw + .03, .02, .11, cmul(wall, .8))
          P(UNIT.cube, bx, y + fh * .62, bz, bw + .03, .03, .11, accent)
          PF(UNIT.cube, bx, y + .04, bz + .046, bw * .75, fh * .45, .006, WINDOW, isHot ? 2 : -1.6)
        }
        // The most worked building of its folder flies the folder's flag.
        if (kit.flag) {
          P(UNIT.cyl6, face - .02, hgt - .05, face - .02, .02, .75, .02, C('#5b4636'))
          P(UNIT.cube, face + .12, hgt + .5, face - .02, .26, .15, .008, hsl(hashStr(f.dir || '') % 360, .65, .5), .2, .8)
          towerTop = Math.max(towerTop, hgt + .7)
        }
        roofTop = Math.max(roofTop + (pn ? .2 : 0), towerTop)
      }
      top = roofTop
      // ---- History in the walls.
      const wallCol = arch === 'watchtower' ? look.wall : wall, wallW = wallHalf * 2
      let seed = h % 2147483646 + 1
      const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647
      // Each edit a band where it fell in the file (its first line at the top
      // floor), as thick as the passage it changed, in its prompt's color; the
      // newest strongest.
      const bands = f.edits || []
      bands.forEach((b, q) => {
        const th = Math.min(wallH, Math.max(.035, Math.min(1, b.span) * wallH))
        const y = Math.max(0, Math.min(wallH - th, (1 - b.pos) * wallH - th))
        const strength = .25 + .3 * (bands.length > 1 ? q / (bands.length - 1) : 1)
        P(isRound ? UNIT.cyl12 : UNIT.cube, 0, y, 0, wallW + .013 + q * .0016, th, wallW + .013 + q * .0016, cmix(wallCol, turnColor(b.turn), strength))
      })
      // Left alone, it gathers moss on its roof, and then ivy, climbing from the
      // corner by the door, round onto its side.
      if (stage && arch !== 'watchtower') {
        for (let q = 0; q < stage * 2; q++) {
          const px = (rnd() - .5) * wallW * .8, pz = (rnd() - .5) * wallW * .8, y = roofAt(px, pz, wallW, wallH)
          if (y !== undefined) PF(UNIT.ico0, px, y - .03, pz, .11, .05, .1, cmix(MOSS, IVY[q % IVY.length], .3), 0, .15)
        }
      }
      const ivy = (cx, cz, nx, nz, tx, tz, height) => {
        const want = sub(W(nx, 0, nz), W(0, 0, 0))
        for (let y = .02; y < height; y += .04) {
          const spread = .04 + .08 * (1 - y / height)
          for (let q = 0; q < 3; q++) {
            const a = (rnd() - .5) * 2 * spread, s = .017 + rnd() * .011, yy = y + rnd() * .03
            let px = cx + tx * a, pz = cz + tz * a
            if (!isRound) { px = Math.min(px, wallHalf + .012); pz = Math.min(pz, wallHalf + .012) }
            MQ.quad(W(px + tx * s, yy, pz + tz * s), W(px, yy + s, pz), W(px - tx * s, yy, pz - tz * s), W(px, yy - s, pz), want, IVY[(q + Math.floor(y * 40)) % IVY.length])
          }
        }
      }
      if (stage >= 2) {
        const height = wallH * Math.min(1, (stage - 1) / 3), out = wallHalf + .012
        if (isRound) ivy(out * Math.SQRT1_2, out * Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, height)
        else {
          ivy(out, wallHalf * .72, 1, 0, 0, 1, height)
          if (stage >= 3) ivy(wallHalf * .72, out, 0, 1, 1, 0, height * .8)
        }
      }
      // A patch on the wall for each failed edit later made good: planks nailed over, left of the door.
      for (let q = 0; q < Math.min(3, f.scars || 0); q++) {
        const px = -wallHalf * .6, py = Math.max(.04, Math.min(wallH - .14, wallH * [.3, .62, .85][q]))
        const pz = isRound ? Math.sqrt(Math.max(0, wallHalf ** 2 - px ** 2)) : wallHalf
        const patch = cmix(wallCol, C('#7a6550'), .6)
        P(UNIT.cube, px, py, pz + .004, .13, .11, .02, patch)
        for (const dy of [.036, .073]) PF(UNIT.cube, px, py + dy, pz + .014, .13, .007, .004, cmul(patch, .62))
        for (const [dx, dy] of [[-.055, .015], [.055, .015], [-.055, .092], [.055, .092]]) PF(UNIT.cube, px + dx, py + dy, pz + .015, .012, .012, .006, C('#3a3330'))
      }
      // A crane over the roof while its file holds TODOs: a crate on the hook for each (up to three).
      const todos = sh ? Math.min(3, sh.todos || 0) : 0
      if (todos) {
        const mx = -.42, mz = -.42, mastH = top + .42, jl = .62, d = Math.SQRT1_2
        P(UNIT.cube, mx, 0, mz, .045, mastH, .045, CRANE)
        for (let y = .2; y < mastH - .1; y += .2) PF(UNIT.cube, mx, y, mz, .055, .012, .055, cmul(CRANE, .7))
        P(UNIT.cube, mx, mastH, mz, .08, .07, .08, cmul(CRANE, .85))
        P(UNIT.cube, mx + d * (jl - .14) / 2, mastH + .07, mz + d * (jl - .14) / 2, jl + .14, .03, .03, CRANE, 0, 0, { ry: -Math.PI / 4 })
        PF(UNIT.cube, mx - d * .1, mastH + .03, mz - d * .1, .07, .06, .06, C('#6f6a62'))
        const tx = mx + d * (jl - .04), tz = mz + d * (jl - .04)
        PF(UNIT.cube, tx, mastH - .1, tz, .006, .17, .006, C('#3a3330'))
        for (let q = 0; q < todos; q++) PF(UNIT.cube, tx, mastH - .1 - .058 * (q + 1), tz, .075, .052, .075, q % 2 ? C('#a57c4f') : C('#8c6540'), 0, .2)
      }
      // Where a rope bridge may tie on: its walls' foot, height and half-width.
      if (collect) anchors.set(f.id, { p: W(0, 0, 0), h: wallH, half: wallHalf })
      if (isDirtyFile(f)) scaffold(m, W, top - .5, .4)
      if (f.isScorched) emit('smoke', W(0, top, 0), 1)
      break
    }
    case 'forge': {
      P(UNIT.cube, 0, 0, 0, .66, .36, .56, C('#7a7068'))
      P(UNIT.wedge, 0, .36, 0, .7, .22, .6, C('#4a3f3a'))
      const ch = .5 + Math.min(size, 6) * .1
      P(UNIT.cyl8, .2, .2, -.12, .17, ch, .17, C('#5a514a'))
      P(UNIT.cube, 0, 0, .281, .2, .22, .02, C('#ff8a3c'), 2.6)
      P(UNIT.cube, -.2, 0, .38, .14, .1, .08, C('#2b2b2b'))
      halo(W(0, .1, .36), [1, .5, .15], .9)
      emit(f.isScorched ? 'darksmoke' : 'smoke', W(.2, .2 + ch, -.12), .45 + Math.min(size, 6) * .1)
      if (collect) forges.push({ door: W(0, .1, .36), chimney: W(.2, .2 + ch, -.12) })
      top = .2 + ch
      break
    }
    case 'beacon': {
      const hgt = .95 + Math.min(size, 6) * .12
      P(UNIT.cyl8, 0, 0, 0, .26, hgt, .26, C('#ece6d8'))
      P(UNIT.cyl8, 0, hgt * .35, 0, .27, .1, .27, C('#c0392b'))
      P(UNIT.cyl8, 0, hgt * .7, 0, .27, .1, .27, C('#c0392b'))
      P(UNIT.ico1, 0, hgt, 0, .2, .2, .2, C('#fff1c2'), 4)
      P(UNIT.cone8, 0, hgt + .17, 0, .26, .14, .26, C('#3a3a3a'))
      halo(W(0, hgt + .1, 0), [1, .85, .5], 1.6 + size * .1)
      top = hgt + .3
      break
    }
    case 'windmill': {
      P(UNIT.cyl8, 0, 0, 0, .46, .95, .46, C('#efe7da'))
      P(UNIT.cone8, 0, .95, 0, .56, .38, .56, C('#9b5d45'))
      P(UNIT.cube, 0, 0, .23, .13, .2, .02, DOOR)
      if (collect) blades.push({ hub: W(0, .9, .3), ry, k, speed: 1.2 + size * .35 })
      top = 1.4
      break
    }
    case 'camp': {
      // A nest of its agent type: woven twigs, a lining in the type's color,
      // and an empty eggshell for every spawnling that hatched here.
      const hue = broodHue(f.key.replace(/^camp:/, ''))
      const shells = Math.min(f.size || 1, 12)
      P(UNIT.cyl12, 0, 0, 0, .66, .08, .66, C('#4a3220'))
      P(UNIT.cyl12, 0, .02, 0, .44, .07, .44, hsl(hue, .3, .68))
      for (let q = 0; q < 16; q++) {
        const a = q / 16 * TAU + (q % 2) * .2, r = .28 + (q % 3) * .015
        PF(UNIT.cube, Math.cos(a) * r, .03 + (q % 2) * .045, Math.sin(a) * r, .2, .035, .035, q % 3 ? C('#6b4a2b') : C('#8a6a43'), 0, 0, { ry: -a + Math.PI / 2, rz: (q % 2 ? .25 : -.25) })
      }
      for (let q = 0; q < shells; q++) {
        // The first few lie in the nest; the rest have tumbled out around it.
        const inside = q < 5, a = q * 2.39996 + (h % 7), r = inside ? .05 + q * .03 : .4 + (q % 3) * .05
        PF(UNIT.cone6, Math.cos(a) * r, inside ? .14 : .08, Math.sin(a) * r, .1, .07, .1, hsl(hue, .25, .9), 0, 0, { rx: Math.PI, rz: (q % 2 ? .4 : -.4) })
      }
      halo(W(0, .15, 0), hsl(hue, .6, .65).map(v => Math.sqrt(v)), .7)
      top = .4
      break
    }
    case 'crystal': {
      const c = hsl(f.hue, .75, .66)
      const n = Math.min(5, 2 + Math.floor(size / 2))
      for (let q = 0; q < n; q++) {
        const a = q / n * TAU + h, rr = q === 0 ? 0 : .18
        const hgt = (q === 0 ? .95 : .55 + (q % 3) * .12) * (.85 + Math.min(size, 6) * .06)
        P(UNIT.octa, Math.cos(a) * rr, 0, Math.sin(a) * rr, .2, hgt, .2, c, 1.3, 0, { rz: q === 0 ? 0 : Math.cos(a) * .35, rx: q === 0 ? 0 : Math.sin(a) * .35 })
      }
      halo(W(0, .45, 0), c.map(v => Math.sqrt(v)), 1.5)
      top = 1
      break
    }
    case 'shrine': {
      const hgt = 1.1 + size * .08
      P(UNIT.cube, 0, 0, 0, .3, .1, .3, C('#6f6880'))
      P(UNIT.cube, 0, .1, 0, .2, hgt, .2, C('#4b4560'))
      P(UNIT.pyr, 0, .1 + hgt, 0, .2, .22, .2, C('#e3c26b'), .4)
      for (let q = 0; q < 8; q++) { const a = q / 8 * TAU; P(UNIT.cube, Math.cos(a) * .4, 0, Math.sin(a) * .4, .07, .03, .07, C('#c9a0ff'), 2.6) }
      P(UNIT.cube, 0, .1 + hgt * .6, .101, .08, .1, .005, C('#d9b8ff'), 3)
      halo(W(0, .1 + hgt * .6, .12), [.75, .5, 1], .7)
      top = hgt + .3
      break
    }
    case 'signpost': {
      P(UNIT.cube, 0, 0, 0, .06, .78, .06, C('#6b4a2f'))
      P(UNIT.cube, .16, .62, 0, .4, .1, .03, C('#c89b62'), 0, 0, { ry: .3 })
      P(UNIT.cube, -.14, .44, 0, .36, .1, .03, C('#b98a55'), 0, 0, { ry: -.5 })
      top = .8
      break
    }
    case 'banner': {
      const hgt = 1.25 + Math.min(size, 6) * .08
      P(UNIT.cyl6, 0, 0, 0, .05, hgt, .05, C('#5b4636'))
      P(UNIT.ico0, 0, hgt, 0, .07, .07, .07, C('#e3c26b'))
      if (collect) flags.push({ top: W(0, hgt - .02, 0), ry, k })
      top = hgt
      break
    }
    case 'cairn': {
      const stones = Math.min(2 + size, 6)
      for (let q = 0; q < stones; q++) P(UNIT.ico0, ((h >> q) % 3 - 1) * .02, q * .11, 0, .3 - q * .035, .14, .26 - q * .03, q % 2 ? C('#b4afa6') : C('#9a958c'), 0, 0, { ry: q })
      top = stones * .11 + .1
      break
    }
    case 'treasury': {
      // The session's bill: a domed treasury, its coins piling beside the door.
      P(UNIT.cube, 0, 0, 0, .7, .4, .6, C('#d8cba8'))
      for (const ox of [-.28, -.1, .1, .28]) P(UNIT.cyl8, ox, 0, .31, .07, .4, .07, C('#efe6cf'))
      P(UNIT.cube, 0, .4, 0, .78, .06, .68, C('#c9b98f'))
      P(UNIT.ico1, 0, .3, 0, .5, .5, .46, C('#e3c26b'), .2)
      const coins = Math.min(30, Math.round(Math.log2((D.world.cost || 0) * 10 + 1) * 4))
      for (let q = 0; q < coins; q++) {
        const a = q * 2.4, r = .1 + (q % 7) * .03
        P(UNIT.cyl8, .5 + Math.cos(a) * r, Math.floor(q / 7) * .025, .3 + Math.sin(a) * r, .1, .02, .1, C('#f2c94c'), .3)
      }
      halo(W(.5, .1, .3), [1, .8, .3], .5 + coins * .02)
      top = .9
      break
    }
    case 'monolith': {
      P(UNIT.cube, 0, 0, 0, .22, 1.9, .56, C('#2b2b36'))
      for (let q = 0; q < 5; q++) P(UNIT.cube, .111, .3 + q * .3, 0, .005, .04, .3 - (q % 2) * .1, C('#b48cff'), 3)
      halo(W(.15, 1, 0), [.7, .5, 1], 1.3)
      top = 1.9
      break
    }
  }
  if (collect) {
    picks.push({ p: W(0, top + .1, 0), label: labelOf(f), kind: 'feature' })
    featureTops.set(f.id, W(0, top, 0))
    fixedTags.push({ p: W(0, top + .3, 0), group: FEATURE_GROUP[f.kind] || 'tools', make: () => featureTag(f) })
    // The last test run hangs over the watchtower worked most lately.
    if (f.style === 'test') fixedTags.push({ p: W(0, top + .8, 0), group: 'tests', make: () => (f === lastTower() ? testRunTag() : null) })
  }
}
const featureTops = new Map()
const anchors = new Map()  // buildings' walls, for bridges to tie on
const forges = []       // forge doors and chimneys: the GPU's heat shows there
const beams = []        // lighthouse lamps: dev servers

// Watchtowers fly the last test run's colors; before any run, their own scorch decides.
const testFlagColor = f => {
  const t = D.world.tests
  return (t ? t.failed > 0 : f.isScorched) ? C('#d9534f') : C('#5cb85c')
}
// A building whose file git has not seen committed, in a repository with a remote.
const isDirtyFile = f => {
  const g = D.world.git
  if (!g || !g.hasRemote || f.kind !== 'house' || !f.key.startsWith('file:')) return false
  return g.dirty.includes(f.key.slice(5).replace(/\\/g, '/').toLowerCase())
}
// Scaffolding: poles at the corners and planks at each storey.
const scaffold = (m, W, height, half) => {
  const wood = C('#b5895a')
  const corners = [[-half, -half], [half, -half], [half, half], [-half, half]]
  for (const [x, z] of corners) rod(m, W(x, 0, z), W(x, height + .2, z), .03, wood, 0)
  for (let y = .35; y < height; y += .45) {
    for (let q = 0; q < 4; q++) {
      const [x0, z0] = corners[q], [x1, z1] = corners[(q + 1) % 4]
      rod(m, W(x0, y, z0), W(x1, y, z1), .025, wood, 0)
    }
  }
}

const glowOf = touchedAt => {
  if (!touchedAt) return 0
  const minutes = (Date.now() - touchedAt) / 60000
  return minutes < 0 ? 1 : Math.pow(Math.max(0, 1 - minutes / 10), 1.5)
}
const fmtTime = s => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`)
const fmtTokens = n => (n < 1000 ? `${Math.round(n)}` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`)
// What a building's walls tell of its file's history (as hooks/world.ts historyText).
const historyOf = f => {
  if (f.kind !== 'house') return ''
  const edits = f.edits || [], turns = new Set(edits.map(e => e.turn)).size, stage = weathering(f)
  const tested = (D.bridges || []).filter(b => b.test === f.id).map(b => D.world.features.find(g => g.id === b.subject)).filter(Boolean).map(g => nameOf(g.key))
  return [
    tested.length ? `tests ${tested.join(', ')}` : '',
    edits.length ? `${edits.length}${edits.length === 12 ? '+' : ''} ${edits.length === 1 ? 'edit' : 'edits'} banded on its walls${turns > 1 ? ` (${turns} prompts)` : ''}` : '',
    stage ? `${['', 'weathering', 'mossy', 'ivy-grown', 'overgrown'][stage]}: untouched ${fmtTime((D.now - f.touchedAt) / 1000)}` : '',
    f.isWounded ? 'an edit failed here' : '',
    f.scars ? `patched after ${f.scars} failed ${f.scars === 1 ? 'edit' : 'edits'}` : '',
  ].filter(Boolean).map(s => ` · ${s}`).join('')
}
const labelOf = f => {
  let note = f.size > 1 ? ` (×${f.size})` : ''
  return `${f.label}${note}${f.isScorched ? ' · scorched by an error' : ''}${historyOf(f)}`
}

// ------------------------------------------------------------------ the disc and the turtle
// The island is a disc of rock on a turtle's back, swimming through space.
// The sea spills over its rim all round and falls away into spray, as thick
// as the context is full. Under the rock hang roots below the trees (files
// read, longer the more often), and stones. The turtle carries the
// conversation (drawTurtle): its shell weathers with the session's age, pale
// and dusty and pocked, and its plates carry a growth ring for each
// compaction.

const RIM_FALL = 3.2  // how far the sheet falls before it is all spray
// The air over the disc: how far out it reaches past the rim's middle, and how high, in sea radii.
const AIR_WIDE = 1.55, AIR_HIGH = .45
// The rim's foot, where the rock beneath begins.
const discFoot = () => BOTTOM * LH - .55
// How deep the rock hangs below the rim's foot at a point (its middle lowest).
const UNDER_SAG = .12
const underAt = (x, z) => {
  const Rs = I.seaRadius, q = Math.min(1, Math.hypot(x, z) / Rs), a = Math.atan2(z, x)
  const bump = .18 * Math.sin(a * 5 + q * 7 + I.seed) + .12 * Math.sin(a * 11 - q * 9) + .1 * Math.sin(q * 23 + a * 3)
  return discFoot() - Rs * UNDER_SAG * (1 - q * q) - bump * (1 - q) * Math.min(1, q * 4)
}

// The turtle's frame: the way it swims (f), its right (r), its shell's size.
const TURTLE_YAW = -.35
const shellOf = () => {
  const Rs = I.seaRadius, h = TURTLE_YAW
  const f = [Math.sin(h), 0, Math.cos(h)], r = [Math.cos(h), 0, -Math.sin(h)]
  const L = Rs * .74, W = Rs * .64, H = Rs * .3
  const top = discFoot() - Rs * (UNDER_SAG - .015)  // pressed a little up into the rock
  return { Rs, f, r, L, W, H, top, base: top - H }
}
// A point in the turtle's frame: a along it, b to its right, at height y.
const atShell = (S, a, b, y) => [S.f[0] * a + S.r[0] * b, y, S.f[2] * a + S.r[2] * b]
// How high the shell rises over a point, or null off it.
const shellY = (x, z) => {
  const S = shellOf(), a = (x * S.f[0] + z * S.f[2]) / S.L, b = (x * S.r[0] + z * S.r[2]) / S.W, q = a * a + b * b
  return q >= 1.05 ? null : S.base + S.H * (Math.pow(Math.max(0, 1 - q), .55) + .08)
}

const buildDisc = m => {
  const Rs = I.seaRadius, lip = seaY() - .04, foot = discFoot(), floor = BOTTOM * LH - .004, n = 128
  const rock = C('#6f655b'), dark = C('#4f4842'), bed = cmul(TOP[BIOME.seabed], .78)
  const ring = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r]
  m.mat = MAT.ground
  // The floor under the sea, closing the rock beneath the water.
  for (let k = 0; k < n; k++) {
    const a0 = k / n * TAU, a1 = (k + 1) / n * TAU
    m.tri([0, floor, 0], ring(a1, Rs, floor), ring(a0, Rs, floor), bed)
  }
  m.mat = MAT.cliff
  for (let k = 0; k < n; k++) {
    const a0 = k / n * TAU, a1 = (k + 1) / n * TAU, am = (a0 + a1) / 2, out = [Math.cos(am), 0, Math.sin(am)]
    const v = .88 + .2 * rand2(k, 3, I.seed)
    // The lip the sea pours over, its inside face, and the cliff of the rim in layers.
    m.quad(ring(a0, Rs - .14, lip), ring(a1, Rs - .14, lip), ring(a1, Rs, lip), ring(a0, Rs, lip), [0, 1, 0], cmul(dark, .9))
    m.quad(ring(a0, Rs - .14, floor), ring(a1, Rs - .14, floor), ring(a1, Rs - .14, lip), ring(a0, Rs - .14, lip), scl(out, -1), cmul(dark, .8))
    const rows = 4
    for (let q = 0; q < rows; q++) {
      const y0 = mix(lip, foot, q / rows), y1 = mix(lip, foot, (q + 1) / rows)
      m.quad(ring(a0, Rs, y0), ring(a1, Rs, y0), ring(a1, Rs, y1), ring(a0, Rs, y1), out, cmul(STRATA[(q + 1) % STRATA.length], v * (1 - q * .08)))
    }
  }
  // The rock beneath, sagging to its middle, layered as it goes down.
  const rings = 12
  const under = (a, q) => { const x = Math.cos(a) * Rs * q, z = Math.sin(a) * Rs * q; return [x, underAt(x, z), z] }
  for (let q = 0; q < rings; q++) for (let k = 0; k < n; k++) {
    const a0 = k / n * TAU, a1 = (k + 1) / n * TAU, q0 = 1 - q / rings, q1 = 1 - (q + 1) / rings
    const p = [under(a0, q0), under(a1, q0), under(a1, q1), under(a0, q1)]
    const col = cmul(STRATA[(q + 3) % STRATA.length], (.62 + .14 * rand2(k, q, I.seed + 9)) * (1 - q / rings * .25))
    m.quad(p[0], p[1], p[2], p[3], [0, -1, 0], col)
  }
  m.mat = MAT.plain
  // Stones hanging from the rock, where the shell leaves room.
  const S = shellOf()
  for (let k = 0; k < 26; k++) {
    const a = rand2(k, 1, I.seed + 31) * TAU, q = .3 + .65 * Math.sqrt(rand2(k, 2, I.seed + 31))
    const x = Math.cos(a) * Rs * q, z = Math.sin(a) * Rs * q, y = underAt(x, z) + .1
    const s = shellY(x, z), room = s === null ? 9 : y - s - .2
    const len = Math.min(room, .5 + 1.4 * rand2(k, 3, I.seed + 31))
    if (len < .35) continue
    m.put(UNIT.cone8, { x, y, z, sx: .3 + len * .25, sy: len, sz: .3 + len * .25, rx: Math.PI, ry: a }, cmul(STRATA[k % STRATA.length], .7))
  }
  // Roots under the trees: each file read, hanging longer the more it was read.
  const brown = C('#5a4130')
  for (const f of D.world.features) {
    if (f.kind !== 'tree') continue
    const x = f.x + .5, z = f.y + .5
    if (Math.hypot(x, z) > Rs - .4) continue
    const y = underAt(x, z) + .05, s = shellY(x, z), room = s === null ? 9 : y - s - .15
    const len = Math.min(room, .5 + .3 * Math.min(f.size, 8))
    if (len < .3) continue
    const pts = [], radii = []
    for (let q = 0; q <= 6; q++) {
      const u = q / 6, sw = Math.sin(u * 5 + f.id) * .12 * u
      pts.push([x + sw, y - len * u, z + Math.cos(u * 4 + f.id) * .1 * u]); radii.push(.07 * (1 - u * .8))
    }
    m.tube(pts, radii, brown, 0, 5)
  }
  // The spray, said where it falls.
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * TAU
    picks.push({ p: [Math.cos(a) * (Rs + .5), seaY() - RIM_FALL * .6, Math.sin(a) * (Rs + .5)], label: `The sea pours over the rim; its spray is as thick as the context is full (${Math.round(D.world.tide)}%)` })
  }
}

// The sea pours over the rim all the way round: a sheet curling out and down,
// fading as it falls (drawn by the water's shader; its depth says how far down).
const buildRimFall = water => {
  const Rs = I.seaRadius, y0 = seaY() - .02, segs = 128, rows = 7
  const at = (a, t) => { const r = Rs + .02 + .55 * Math.sqrt(t); return [Math.cos(a) * r, y0 - RIM_FALL * t, Math.sin(a) * r, -1.01 - t] }
  for (let k = 0; k < segs; k++) for (let q = 0; q < rows; q++) {
    const a0 = k / segs * TAU, a1 = (k + 1) / segs * TAU, t0 = (q / rows) ** 1.4, t1 = ((q + 1) / rows) ** 1.4
    const A = at(a0, t0), B = at(a1, t0), Cc = at(a1, t1), Dd = at(a0, t1)
    water.push(...A, ...B, ...Cc, ...A, ...Cc, ...Dd)
  }
}

// The carapace: a teardrop, wide at the shoulders and drawn out behind, a
// ridge down its spine, its plates (five down the spine, four each side, a
// ring of 24 round the edge, notched at the back where they meet) raised
// with grooves between. The shader paints them (shellOf in LIT_FS): flames
// from each plate's middle, dust and craters as the session ages, a growth
// ring near each plate's edge for each compaction. Beneath, the pale belly
// plates. Built once for the disc's size.
const SCUTES = (() => {
  const out = [[.64, 0], [.32, 0], [0, 0], [-.32, 0], [-.62, 0]]
  for (const u of [.44, .13, -.18, -.47]) out.push([u, .5], [u, -.5])
  for (let k = 0; k < 24; k++) { const a = (k + .5) / 24 * TAU; out.push([Math.cos(a) * .94, Math.sin(a) * .94]) }
  return out
})()
const SCUTES_FLAT = new Float32Array(SCUTES.flat())
const plateAt = (u, v) => {
  let d1 = 9, d2 = 9, k1 = 0
  SCUTES.forEach(([su, sv], k) => { const d = Math.hypot(u - su, (v - sv) * 1.1); if (d < d1) { d2 = d1; d1 = d; k1 = k } else if (d < d2) d2 = d })
  return { d1, d2, k: k1, inner: d1 / Math.max(1e-3, d1 + d2) * 2 }
}
// Where the shell's surface is, from q (0 middle to 1 edge) and the turn t round it.
const shellAB = (S, q, t) => {
  const notch = 1 - .045 * Math.max(0, -Math.cos(t)) * Math.pow(.5 + .5 * Math.cos(t * 24), 6)
  const flare = 1 + .03 * Math.max(0, q - .9) / .1
  const x = q * notch * flare * Math.cos(t), y = q * notch * flare * Math.sin(t)
  return [S.L * x * (1 + .08 * Math.max(0, -x) ** 2), S.W * y * (1 + .1 * x)]
}
const shellRise = (S, a, b, q) => {
  const u = a / S.L, v = b / S.W, P = plateAt(u, v)
  const groove = 1 - sstep(0, .045, P.d2 - P.d1)
  return S.base + S.H * Math.pow(Math.max(0, 1 - q * q), .55)
    + S.H * .05 * Math.exp(-((v / .13) ** 2)) * (1 - q * q)
    + S.H * .018 * (1 - P.inner * P.inner) - S.H * .035 * groove
}
const shellMesh = { key: '', m: null }
const buildTurtle = m => {
  const S = shellOf(), key = `${S.Rs}|${S.base}`
  if (shellMesh.key !== key) { shellMesh.key = key; shellMesh.m = turtleShell(S) }
  const d = shellMesh.m.d
  for (let k = 0; k < d.length; k++) m.d.push(d[k])
  m.n += shellMesh.m.n
}
const turtleShell = S => {
  const m = new Mesh(), nq = 44, nt = 160, Rs = S.Rs
  // The top: a grid out from the middle, each corner's normal from its neighbours.
  const grid = []
  for (let i = 0; i <= nq; i++) {
    const row = []
    for (let j = 0; j < nt; j++) {
      const q = i / nq, t = j / nt * TAU, [a, b] = shellAB(S, q, t)
      row.push({ p: atShell(S, a, b, shellRise(S, a, b, q)), a, b })
    }
    grid.push(row)
  }
  const at = (i, j) => grid[clamp(i, 0, nq)][(j + nt) % nt].p
  for (let i = 0; i <= nq; i++) for (let j = 0; j < nt; j++) {
    const g = grid[i][j]
    g.n = i === 0 ? [0, 1, 0] : norm(cross(sub(at(i + 1, j), at(i - 1, j)), sub(at(i, j + 1), at(i, j - 1))))
    // Each plate a shade of its own, for the shader to paint over.
    const k = plateAt(g.a / S.L, g.b / S.W).k, r1 = rand2(k, 7, 77), r2 = rand2(k, 9, 77)
    g.c = [.85 + .3 * r1, .85 + .26 * r1 + .04 * r2, .85 + .2 * r1 - .04 * r2]
  }
  m.mat = MAT.shell
  for (let i = 0; i < nq; i++) for (let j = 0; j < nt; j++) {
    const a = grid[i][j], b = grid[i][(j + 1) % nt], c = grid[i + 1][(j + 1) % nt], d = grid[i + 1][j]
    m.triN(a.p, d.p, c.p, a.n, d.n, c.n, a.c, 0, [a.c, d.c, c.c])
    m.triN(a.p, c.p, b.p, a.n, c.n, b.n, a.c, 0, [a.c, c.c, b.c])
  }
  // The edge: a thick lip, then the underside of the edge plates tucking in to the belly.
  const lip = Rs * .028, tuck = .86, belly = Rs * .05
  const under = j => { const t = j / nt * TAU, [a, b] = shellAB(S, tuck, t); return atShell(S, a, b, S.base - lip - Rs * .02) }
  for (let j = 0; j < nt; j++) {
    const a = grid[nq][j].p, b = grid[nq][(j + 1) % nt].p, out = norm([a[0], 0, a[2]])
    const a2 = [a[0], a[1] - lip, a[2]], b2 = [b[0], b[1] - lip, b[2]]
    m.mat = MAT.shell
    m.quad(a, b, b2, a2, out, grid[nq][j].c)
    m.mat = MAT.plain
    m.quad(a2, b2, under(j + 1), under(j), [out[0], -2, out[2]], C('#4a3f26'))
  }
  // The belly: pale plates, seamed down the middle and across.
  const nb = 18, cream = C('#d4c493'), seam = C('#8a7a4e')
  const bp = (i, j) => {
    const q = tuck * i / nb, t = j / nt * TAU, [a, b] = shellAB(S, q, t)
    const y = S.base - lip - Rs * .02 - belly * Math.pow(Math.max(0, 1 - (q / tuck) ** 2), .6)
    const u = a / S.L, v = b / S.W
    const line = Math.min(Math.abs(v), ...[.5, .22, -.08, -.38].map(c => Math.abs(u - c) * 1.3))
    return { p: atShell(S, a, b, y), c: line < .02 ? seam : cmul(cream, .92 + .1 * rand2(Math.round(u * 6), Math.sign(v), 5)) }
  }
  for (let i = 0; i < nb; i++) for (let j = 0; j < nt; j++) {
    const a = bp(i, j), b = bp(i, j + 1), c = bp(i + 1, j + 1), d = bp(i + 1, j)
    m.tri(a.p, c.p, d.p, a.c, 0, [0, 0, 0], [a.c, c.c, d.c])
    m.tri(a.p, b.p, c.p, a.c, 0, [0, 0, 0], [a.c, b.c, c.c])
  }
  return m
}

const buildWater = list => {
  const Rs = I.seaRadius, y = seaY(), rings = 44, segs = 128
  const vert = (r, a) => {
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    const [i, j] = cellAt(x, z)
    return [x, y, z, Math.max(0, I.sea - level(i, j))]
  }
  for (let q = 0; q < rings; q++) for (let s = 0; s < segs; s++) {
    const r0 = Rs * q / rings, r1 = Rs * (q + 1) / rings, a0 = s / segs * TAU, a1 = (s + 1) / segs * TAU
    const A = vert(r0, a0), B = vert(r1, a0), Cc = vert(r1, a1), Dd = vert(r0, a1)
    list.push(...A, ...Dd, ...Cc, ...A, ...Cc, ...B)
  }
}

const rebuild = () => {
  const fm = new Mesh()
  FM = fm; fineRanges.length = 0
  halos.length = 0; emitters.length = 0; forges.length = 0; beams.length = 0; blades.length = 0; flags.length = 0; picks.length = 0
  featureTops.clear(); anchors.clear(); fixedTags.length = 0
  const m = new Mesh(), water = []
  buildTerrain(m, water)
  buildRimFall(water)
  streamWater = water.slice()
  buildDecor(m)
  buildDisc(m)
  buildTurtle(m)
  buildHarbor(m)
  buildLighthouses(m)
  for (const f of D.world.features) {
    if (growing(f.id)) continue
    const start = fm.n
    structure(m, f, 1, true)
    fineAt([f.x + .5, level(f.x, f.y) * LH + .8, f.y + .5], start)
  }
  buildSolids()
  buildStreets(m)
  buildDistricts(m)
  buildBridges(m)
  findRiver()
  FM = null
  fineData = new Float32Array(fm.d)
  upload(G_.fine, fineData)
  buildWater(water)
  statData = new Float32Array(m.d)
  upload(G_.stat, statData)
  buildGrass(true)
  upload(G_.water, water)
  lanternPicks()
}
// Detail by distance: the small parts of buildings, districts and bridges go in a mesh of
// their own, kept in ranges by where they stand, and are drawn only near the eye.
let FM = null
const fineRanges = []
let fineData = new Float32Array(0)
const fineAt = (c, start) => { if (FM && FM.n > start) fineRanges.push({ c, start, count: FM.n - start }) }
let lodEye = [0, 0, 0]
const drawFine = () => {
  if (!G_.fine.count) return
  gl.bindVertexArray(G_.fine.a)
  const lim = QL().lod ** 2
  let s = -1, e = -1
  for (const r of fineRanges) {
    const dx = r.c[0] - lodEye[0], dy = r.c[1] - lodEye[1], dz = r.c[2] - lodEye[2]
    if (dx * dx + dy * dy + dz * dz > lim) continue
    if (r.start === e) { e += r.count; continue }
    if (s >= 0) gl.drawArrays(gl.TRIANGLES, s, e - s)
    s = r.start; e = r.start + r.count
  }
  if (s >= 0) gl.drawArrays(gl.TRIANGLES, s, e - s)
}
// The island: its mesh, the fine parts near the eye, and this frame's moving things.
const drawWorld = (fine = true) => {
  gl.bindVertexArray(G_.stat.a); gl.drawArrays(gl.TRIANGLES, 0, G_.stat.count)
  if (fine) drawFine()
  gl.bindVertexArray(G_.dyn.a); gl.drawArrays(gl.TRIANGLES, 0, G_.dyn.count)
}
const growing = id => { const t = born.get(id); return t !== undefined && now - t < GROW }

// ------------------------------------------------------------------ streets

// Imports become streets: out of one file's plot at its corner, along the
// lines between plots, and in at the other's (hooks/world.ts routeOf), so
// streets run between the buildings and merge where they share a way; the
// more imports share a stretch, the wider it is. A file only read is reached
// by a footpath. A file three or more others import stands on a paved
// square, lamps at its corners.
const STONE = C('#b8ad99'), DIRT = C('#a3865f')
const routeOf = (a, b) => {
  const ca = [a.x + (b.x > a.x ? 1 : 0), a.y + (b.y > a.y ? 1 : 0)], cb = [b.x + (a.x > b.x ? 1 : 0), b.y + (a.y > b.y ? 1 : 0)]
  return [[a.x + .5, a.y + .5], ca, [cb[0], ca[1]], cb, [b.x + .5, b.y + .5]]
}
// On the lines between plots a street rides the highest ground beside it, or the sea.
const streetY = (x, z) => {
  let y = I.sea
  for (const [dx, dz] of [[-.02, -.02], [.02, -.02], [-.02, .02], [.02, .02]]) { const [i, j] = cellAt(x + dx, z + dz); if (inside(i, j)) y = Math.max(y, level(i, j)) }
  return y * LH + .03
}
const ribbon = (m, a, b, width, col) => {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .25))
  const d = norm([b[0] - a[0], 0, b[1] - a[1]]), side = [-d[2] * width / 2, 0, d[0] * width / 2]
  for (let q = 0; q < n; q++) {
    const p0 = [mix(a[0], b[0], q / n), mix(a[1], b[1], q / n)], p1 = [mix(a[0], b[0], (q + 1) / n), mix(a[1], b[1], (q + 1) / n)]
    const y0 = streetY(p0[0], p0[1]), y1 = streetY(p1[0], p1[1])
    const A = [p0[0] - side[0], y0, p0[1] - side[2]], B = [p0[0] + side[0], y0, p0[1] + side[2]]
    const Cc = [p1[0] + side[0], y1, p1[1] + side[2]], Dd = [p1[0] - side[0], y1, p1[1] - side[2]]
    m.quad(A, B, Cc, Dd, [0, 1, 0], cmul(col, .9 + rand2(Math.round(p0[0] * 8), Math.round(p0[1] * 8), 5) * .2))
  }
}
const buildStreets = m => {
  const streets = D.streets || []
  if (!streets.length) return
  const byId = new Map(D.world.features.map(f => [f.id, f]))
  const edges = new Map(), lanes = new Map(), imported = new Map()
  for (const s of streets) {
    const a = byId.get(s.from), b = byId.get(s.to)
    if (!a || !b) continue
    imported.set(b.id, (imported.get(b.id) || 0) + 1)
    const r = routeOf(a, b)
    for (const [fid, from, to] of [[a.id, r[0], r[1]], [b.id, r[4], r[3]]]) {
      const key = `${fid}:${to}`, had = lanes.get(key)
      lanes.set(key, { from, to, isPath: had ? had.isPath && s.isPath : s.isPath })
    }
    // Along the lines between plots, a unit at a time, so shared stretches are counted once each.
    for (const [p, q] of [[r[1], r[2]], [r[2], r[3]]]) {
      const steps = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1])
      const dx = Math.sign(q[0] - p[0]), dz = Math.sign(q[1] - p[1])
      for (let k = 0; k < steps; k++) {
        const u = [p[0] + dx * k, p[1] + dz * k], v = [u[0] + dx, u[1] + dz]
        const key = u[0] < v[0] || (u[0] === v[0] && u[1] < v[1]) ? `${u}|${v}` : `${v}|${u}`
        const had = edges.get(key)
        edges.set(key, { u, v, n: (had ? had.n : 0) + 1, isPath: had ? had.isPath && s.isPath : s.isPath })
      }
    }
  }
  for (const e of edges.values()) ribbon(m, e.u, e.v, e.isPath ? .08 : .14 + .04 * Math.min(3, e.n - 1), e.isPath ? DIRT : STONE)
  // From the corner in to the door, as far as the building's wall.
  for (const l of lanes.values()) ribbon(m, l.to, [mix(l.to[0], l.from[0], .5), mix(l.to[1], l.from[1], .5)], l.isPath ? .08 : .11, l.isPath ? DIRT : STONE)
  for (const [id, n] of imported) {
    const f = byId.get(id)
    if (!f || n < 3) continue
    const cx = f.x + .5, cz = f.y + .5, y = level(f.x, f.y) * LH
    m.put(UNIT.cyl12, { x: cx, y: y + .004, z: cz, sx: .98, sy: .02, sz: .98 }, cmul(STONE, 1.05))
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const lx = cx + sx * .4, lz = cz + sz * .4
      m.put(UNIT.cyl6, { x: lx, y, z: lz, sx: .025, sy: .36, sz: .025 }, C('#3a3a3a'))
      m.put(UNIT.ico0, { x: lx, y: y + .34, z: lz, sx: .07, sy: .07, sz: .07 }, C('#ffd88a'), -2)
      halos.push({ p: [lx, y + .38, lz], c: [1, .8, .45], s: .5, night: true })
    }
    picks.push({ p: [cx, y + .2, cz + .45], label: `${nameOf(f.key)}: a square, imported by ${n} files on the island`, kind: 'square' })
  }
}

// ------------------------------------------------------------------ districts and bridges

// Each folder a district (hooks/world.ts districtsOf): its plots paved in
// its own stone, walled along the lines between plots where it meets the
// rest of the town (a hedge for a quarter, a folder inside another on the
// island), open where a street runs, and a gate with its name.
const PAVING = [
  { name: 'flagstones', col: C('#cbbfa6'), rows: 3, cols: 3 },
  { name: 'cobbles', col: C('#a7a299'), rows: 5, cols: 5 },
  { name: 'brick', col: C('#b0735c'), rows: 6, cols: 3, isBrick: true },
  { name: 'slate', col: C('#7f8a94'), rows: 4, cols: 4 },
]
const WALL_STONE = C('#9d9486'), HEDGE = C('#3e6e35')
const pave = (m, x, z, y, kind) => {
  const P = PAVING[kind] || PAVING[0], gap = .022, lo = .02, span = 1 - 2 * lo
  const rh = (span - (P.rows - 1) * gap) / P.rows, cw = (span - (P.cols - 1) * gap) / P.cols
  for (let r = 0; r < P.rows; r++) {
    const z0 = z + lo + r * (rh + gap), z1 = z0 + rh, shift = P.isBrick && r % 2 ? (cw + gap) / 2 : 0
    for (let c = shift ? -1 : 0; c < P.cols; c++) {
      const x0 = Math.max(x + lo, x + lo + c * (cw + gap) + shift), x1 = Math.min(x + 1 - lo, x + lo + c * (cw + gap) + shift + cw)
      if (x1 - x0 < .02) continue
      m.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], cmul(P.col, .9 + rand2(Math.round(x0 * 40), Math.round(z0 * 40), 17 + kind) * .18))
    }
  }
}
const buildDistricts = m => {
  for (const d of D.districts || []) {
    // Far off, each plot is one flat stone; near, its tiles (fine).
    const fm = FM || m
    for (const [x, z] of d.cells) {
      const y = level(x, z) * LH + .008
      m.quad([x + .02, y, z + .02], [x + .98, y, z + .02], [x + .98, y, z + .98], [x + .02, y, z + .98], [0, 1, 0], cmul(PAVING[d.pave].col, .82))
      const start = fm.n
      pave(fm, x, z, y + .004, d.pave)
      fineAt([x + .5, y, z + .5], start)
    }
    const isHedge = d.parent !== undefined
    // The wall's foot on a line between plots: the higher ground beside it.
    const lineAt = e => { const mx = (e[0] + e[2]) / 2, mz = (e[1] + e[3]) / 2; return { mx, mz, y: streetY(mx, mz) - .03, ry: e[1] === e[3] ? 0 : Math.PI / 2 } }
    for (const e of d.walls) {
      const { mx, mz, y, ry } = lineAt(e)
      const tone = .9 + rand2(Math.round(mx * 4), Math.round(mz * 4), 23) * .16, start = fm.n
      if (isHedge) {
        m.put(UNIT.cube, { x: mx, y, z: mz, sx: 1.04, sy: .2, sz: .13, ry }, cmul(HEDGE, tone))
        for (let q = 0; q < 3; q++) fm.put(UNIT.ico1, { x: mx + (ry ? 0 : (q - 1) * .33), y: y + .13, z: mz + (ry ? (q - 1) * .33 : 0), sx: .36, sy: .14, sz: .16, ry }, cmul(HEDGE, tone * 1.15))
      } else {
        m.put(UNIT.cube, { x: mx, y, z: mz, sx: 1.06, sy: .26, sz: .08, ry }, cmul(WALL_STONE, tone))
        fm.put(UNIT.cube, { x: mx, y: y + .26, z: mz, sx: 1.08, sy: .03, sz: .11, ry }, cmul(WALL_STONE, tone * 1.18))
        for (let q = 0; q < 3; q++) fm.put(UNIT.cube, { x: mx + (ry ? 0 : (q - 1) * .34), y: y + .29, z: mz + (ry ? (q - 1) * .34 : 0), sx: .12, sy: .07, sz: .09, ry }, cmul(WALL_STONE, tone * 1.05))
      }
      fineAt([mx, y, mz], start)
    }
    const plots = new Set(d.cells.map(c => `${c[0]},${c[1]}`)), mine = D.world.features.filter(f => f.kind === 'house' && plots.has(`${f.x},${f.y}`))
    const label = `${d.name}/ · ${d.parent ? `a quarter of ${d.parent}/` : 'a district'} · ${d.files} files${d.lines ? `, ${d.lines.toLocaleString('en-US')} lines` : ''} · paved in ${PAVING[d.pave].name}`
    if (d.gate) {
      // A gate in the wall nearest the town's heart: two posts, a lintel, its name on a board.
      const { mx, mz, y, ry } = lineAt(d.gate), al = ry ? [0, 1] : [1, 0]
      const post = isHedge ? cmul(HEDGE, 1.1) : cmul(WALL_STONE, 1.08)
      for (const s of [-1, 1]) m.put(UNIT.cube, { x: mx + al[0] * s * .4, y, z: mz + al[1] * s * .4, sx: .12, sy: .62, sz: .12, ry }, post)
      if (isHedge) arcRod(m, [mx - al[0] * .4, y + .6, mz - al[1] * .4], [mx + al[0] * .4, y + .6, mz + al[1] * .4], .18, .05, cmul(HEDGE, 1.2), 0, 8)
      else m.put(UNIT.cube, { x: mx, y: y + .62, z: mz, sx: .96, sy: .08, sz: .13, ry }, cmul(WALL_STONE, 1.15))
      m.put(UNIT.cube, { x: mx, y: y + .43, z: mz, sx: .4, sy: .12, sz: .03, ry }, cmix(C('#7a5a3c'), PAVING[d.pave].col, .35))
      picks.push({ p: [mx, y + .75, mz], label, kind: 'gate' })
      fixedTags.push({ p: [mx, y + .95, mz], group: 'folders', style: 'name', make: () => gateTag(d, mine) })
    } else {
      const [cx, cz] = d.cells.reduce((s, c) => [s[0] + c[0] + .5, s[1] + c[1] + .5], [0, 0]).map(v => v / d.cells.length)
      const [ci, cj] = d.cells[0]
      picks.push({ p: [cx, level(ci, cj) * LH + .3, cz], label, kind: 'gate' })
      fixedTags.push({ p: [cx, level(ci, cj) * LH + 1.6, cz], group: 'folders', style: 'name', make: () => gateTag(d, mine) })
    }
  }
}

// A test joined to what it tests by a rope bridge, from its watchtower's top
// to the other's top floor: planks on two ropes, hand ropes above, and
// bunting in the last test run's colors.
const buildBridges = m => {
  const byId = new Map(D.world.features.map(f => [f.id, f]))
  for (const b of D.bridges || []) {
    const A = anchors.get(b.test), B = anchors.get(b.subject), test = byId.get(b.test), subject = byId.get(b.subject)
    if (b.isFar || !A || !B || !test || !subject) continue
    const dir = norm([B.p[0] - A.p[0], 0, B.p[2] - A.p[2]]), side = [-dir[2], 0, dir[0]]
    const a = [A.p[0] + dir[0] * A.half, A.p[1] + A.h - .02, A.p[2] + dir[2] * A.half]
    const e = [B.p[0] - dir[0] * B.half, B.p[1] + Math.max(.2, B.h * .8), B.p[2] - dir[2] * B.half]
    const len = Math.hypot(e[0] - a[0], e[2] - a[2]), sag = .05 + len * .07
    if (len < .05) continue
    const at = (t, off, lift) => [mix(a[0], e[0], t) + side[0] * off, mix(a[1], e[1], t) - sag * 4 * t * (1 - t) + lift, mix(a[2], e[2], t) + side[2] * off]
    const n = Math.max(6, Math.round(len / .075)), ry = Math.atan2(-dir[2], dir[0]), rope = C('#c9b48a'), flag = testFlagColor(test)
    // Far off, one deck rope; near, the planks, hand ropes and bunting (fine).
    const fm = FM || m, start = fm.n
    for (let q = 0; q < 6; q++) rod(m, at(q / 6, 0, -.01), at((q + 1) / 6, 0, -.01), .05, C('#8a6a48'), 0)
    for (let q = 0; q <= n; q++) { const p = at(q / n, 0, -.006); fm.put(UNIT.cube, { x: p[0], y: p[1], z: p[2], sx: .13, sy: .012, sz: .035, ry }, cmul(C('#8a6a48'), .9 + (q % 3) * .07)) }
    const segs = Math.ceil(n / 2)
    for (const off of [-.07, .07]) {
      for (let q = 0; q < segs; q++) {
        rod(fm, at(q / segs, off, 0), at((q + 1) / segs, off, 0), .01, rope, 0)
        rod(fm, at(q / segs, off, .13), at((q + 1) / segs, off, .13), .01, rope, 0)
        if (q % 2 === 0) rod(fm, at(q / segs, off, 0), at(q / segs, off, .13), .006, rope, 0)
        if (q % 3 === 1) { const p = at((q + .5) / segs, off, .1); fm.put(UNIT.pyr, { x: p[0], y: p[1], z: p[2], sx: .05, sy: .06, sz: .012, ry: ry + Math.PI / 2, rx: Math.PI }, flag, .3) }
      }
    }
    fineAt(at(.5, 0, 0), start)
    const t = D.world.tests
    const mid = at(.5, 0, .2)
    picks.push({ p: mid, label: `A rope bridge: ${nameOf(test.key)} tests ${nameOf(subject.key)}${t ? ` · last run ${t.passed} passed, ${t.failed} failed` : ''}`, kind: 'bridge' })
    fixedTags.push({ p: at(.5, 0, .35), group: 'tests', make: () => ({ text: `${nameOf(test.key)} → ${nameOf(subject.key)}`, rank: .2, at: test.touchedAt, key: `bridge:${b.test}:${b.subject}` }) })
  }
}
const GROW = 1.6

// ------------------------------------------------------------------ tool effects

// A glowing rod from a to b: a thin box laid along the segment.
const rod = (m, a, b, width, color, e) => {
  const d = sub(b, a), len = Math.hypot(d[0], d[1], d[2])
  if (len < 1e-4) return
  const rx = Math.acos(clamp(d[1] / len, -1, 1)), ry = Math.atan2(d[0], d[2])
  m.put(UNIT.cube, { x: a[0], y: a[1], z: a[2], sx: width, sy: len, sz: width, rx, ry }, color, e)
}
const arcRod = (m, a, b, lift, width, color, e, steps = 10) => {
  const mid = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + lift, (a[2] + b[2]) / 2]
  const at = t => [0, 1, 2].map(k => (1 - t) * (1 - t) * a[k] + 2 * (1 - t) * t * mid[k] + t * t * b[k])
  for (let q = 0; q < steps; q++) rod(m, at(q / steps), at((q + 1) / steps), width, color, e)
  return at
}
const boltRods = (m, from, to, seed, jag, color, e, width) => {
  let prev = from
  const steps = 8
  for (let q = 1; q <= steps; q++) {
    const t = q / steps
    const p = q === steps ? to : [
      mix(from[0], to[0], t) + (rand2(seed, q, 5) - .5) * jag,
      mix(from[1], to[1], t),
      mix(from[2], to[2], t) + (rand2(seed, q, 6) - .5) * jag,
    ]
    rod(m, prev, p, width, color, e)
    prev = p
  }
}
const KIND_COLOR = {
  read: C('#8ff0b0'), write: C('#ffb84a'), edit: C('#ffd27a'), bash: C('#ff9a4a'), search: C('#7fe3ff'), web: C('#cfe6ff'),
  agent: C('#c39bff'), skill: C('#ff9ad8'), mcp: C('#7ff7e3'), other: C('#ffffff'),
}
const toolKind = tool => {
  if (tool === 'Read') return 'read'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edit'
  if (tool === 'Bash' || tool === 'PowerShell') return 'bash'
  if (tool === 'Grep' || tool === 'Glob') return 'search'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (tool === 'Agent' || tool === 'Task') return 'agent'
  if (tool === 'Skill') return 'skill'
  if (tool.startsWith('mcp__')) return 'mcp'
  return 'other'
}
// How a tentacle works, by what its call does there: how thick it is, how
// long it takes to reach, how it wriggles, how high over its target the tip
// stays, the sound as it takes hold and the one it makes again (every so
// many seconds, so loud) while it holds, and what it is said to be doing.
const MANNER = {
  read:   { thick: .72, reach: .8, speed: 1.4, wig: .1,  hover: 0,   sound: 'sip',     hum: 'sip',    every: 3.2, gain: .18, verb: 'drinks in' },
  write:  { thick: 1.3, reach: .7, speed: 1.1, wig: .07, hover: .5,  sound: 'glug',    hum: 'glug',   every: 3.6, gain: .2,  verb: 'pours itself into' },
  edit:   { thick: .9,  reach: .3, speed: 4,   wig: .05, hover: 0,   sound: 'tap',     hum: 'tap',    every: 1.1, gain: .16, verb: 'picks at' },
  bash:   { thick: 1.1, reach: .6, speed: 2,   wig: .08, hover: 0,   sound: 'squelch', hum: 'sizzle', every: 3,   gain: .14, verb: 'coils round the forge' },
  search: { thick: .75, reach: .5, speed: 1.6, wig: .12, hover: 1,   sound: 'sonar',   hum: 'sonar',  every: 2.8, gain: .2,  verb: 'sweeps an eye over the land' },
  agent:  { thick: 1,   reach: .6, speed: 2,   wig: .12, hover: 0,   sound: 'splat',   hum: '',       every: 0,   gain: 0,   verb: 'lays an egg in the nest' },
  skill:  { thick: .9,  reach: .6, speed: 1.3, wig: .1,  hover: .3,  sound: 'chime',   hum: 'chime',  every: 4.5, gain: .1,  verb: 'blooms over the shrine' },
  mcp:    { thick: .95, reach: .5, speed: 2.5, wig: .08, hover: .45, sound: 'chime',   hum: 'zap',    every: 2.4, gain: .1,  verb: 'sparks against the crystal' },
  other:  { thick: 1,   reach: .5, speed: 2.5, wig: .14, hover: 0,   sound: 'splat',   hum: '',       every: 0,   gain: 0,   verb: 'touches' },
}
const mannerOf = tool => tool === 'Write' ? 'write' : toolKind(tool)
// A failed call's tentacle snatches back over a second and a bit.
const recoilOf = (ev, t) => ev.isError ? sstep(0, 1.3, (t - (ev.failedAt ?? ev.at + 1500)) / 1000) : 0
const burst = new Set()
const EFFECT = 5

// ------------------------------------------------------------------ the creature

// The conversation's creature. Your first prompt hatches it; each one after
// wakes it, small again: its legs grow with the time the turn runs and its
// body with the tokens it eats, and it sprouts an eye as it feeds. It crawls
// to the middle of the files it works on and reaches for each with a
// tentacle, its eyes on the latest. When the turn is done, or Claude waits
// on you, it sleeps. Its subagents are spawnlings, drawn by the same hand:
// smaller, colored by their agent type, their eyes by their model.
// The same rules the pane draws by (hooks/world.ts).
const TENTACLE = 24
const crawlMs = b => clamp(Math.hypot(b.x - b.fromX, b.y - b.fromY) * 900, 1200, 9000)
const beastAt = (b, t) => { const k = sstep(0, 1, (t - b.movedAt) / crawlMs(b)); return [mix(b.fromX, b.x, k), mix(b.fromY, b.y, k)] }
const beastShape = (b, t) => {
  const seconds = Math.max(0, ((b.doneAt ?? t) - b.bornAt) / 1000)
  return {
    seconds, tokens: b.tokens,
    reach: .5 + Math.min(2.6, Math.sqrt(seconds) * .075),
    body: Math.min(1.25, .2 + .11 * Math.log1p(b.tokens / 4000)),
    eyes: Math.min(13, 3 + Math.floor(Math.log2(1 + b.tokens / 25000))),
  }
}
// A spawnling: three fifths the size, smaller again each level deeper, fewer eyes.
const spawnScale = s => .6 * Math.pow(.75, Math.max(0, (s.depth || 1) - 1))
const spawnShape = (s, t, parent) => {
  const g = beastShape(s, t), k = spawnScale(s)
  const capB = parent ? Math.max(.13, parent.body * .8) : Infinity, capR = parent ? Math.max(.3, parent.reach * .85) : Infinity
  return { ...g, reach: Math.min(capR, g.reach * k), body: Math.min(capB, Math.max(.13, g.body * k)), eyes: Math.min(7, 2 + Math.floor(Math.log2(1 + s.tokens / 25000))) }
}
const homeAt = s => s.outcome === 'done' && s.doneAt !== undefined ? s.movedAt + crawlMs(s) : undefined
const ABSORB = 1.6
// A spawnling's voice by its model: the bigger the model, the lower it sounds (all higher than the creature's own).
const VOICE = { haiku: 1.6, sonnet: 1.4, opus: 1.2, fable: 1.1, other: 1.35 }
// How much a returning spawnling brings home, 0 to 1, by the length of its answer.
const haul = s => clamp(Math.log10(1 + (s.answer || 0) / 200) / 2.5, 0, 1)
// The built-in agent types' colors; any other type a color from its name, clear of the creature's violet.
const BROOD_HUES = { explore: 172, plan: 222, 'general-purpose': 36, 'claude-code-guide': 335, 'statusline-setup': 96 }
const broodHue = (type, name) => {
  const known = BROOD_HUES[String(type).toLowerCase()]
  if (known !== undefined) return known
  const h = hashStr(type === 'teammate' && name ? name : String(type)) % 360
  return h >= 250 && h <= 310 ? (h + 75) % 360 : h
}
// Eyes by the model: Opus lime (the creature's own), Sonnet gold, Haiku ice blue, Fable rose.
const familyOf = model => { const m = String(model || '').toLowerCase(); return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : m.includes('fable') ? 'fable' : 'other' }
const EYES = {
  opus: [C('#b8ff3a'), [.7, 1, .25]], sonnet: [C('#ffc43a'), [1, .8, .25]], haiku: [C('#8fe6ff'), [.55, .9, 1]],
  fable: [C('#ff7ad1'), [1, .45, .8]], other: [C('#e8e2ff'), [.9, .88, 1]],
}
const modelName = model => {
  const f = familyOf(model)
  if (f === 'other') return model ? String(model) : 'an unknown model'
  const v = /(\d+)[-.](\d+)/.exec(model)
  return `${f[0].toUpperCase()}${f.slice(1)}${v ? ` ${v[1]}.${v[2]}` : ''}`
}
const BLOB = icosphere(2).map(t => t.map(q => [q[0] * 2, (q[1] - .5) * 2, q[2] * 2]))
const SKIN = C('#3b1a4c'), CREVICE = C('#14071c'), SHEEN = C('#7a4a98'), LEG = C('#1d0f26'), LID = C('#2b1438'), SUCKER = C('#c9a6dc')
const IRIS = C('#b8ff3a'), SCLERA = C('#efe9cf'), PUPIL = C('#0b0610')
// The creature's own skin, and a spawnling's in its type's hue; one that failed or was stopped greys and reddens.
const VIOLET = { skin: SKIN, crevice: CREVICE, sheen: SHEEN, leg: LEG, lid: LID, sucker: SUCKER, drip: [.55, .38, .85], mote: [.75, .5, 1], aura: [.55, .35, .85], ring: [.85, .7, 1] }
const skinOf = (hue, hurt) => {
  const tone = (s, l) => hurt ? cmix(hsl(hue, s, l), hsl(5, .3, l * .9), .55) : hsl(hue, s, l)
  const raw = (s, l) => tone(s, l).map(v => Math.sqrt(v))
  return { skin: tone(.6, .42), crevice: tone(.6, .12), sheen: tone(.55, .66), leg: tone(.45, .13), lid: tone(.45, .2), sucker: tone(.45, .78), drip: raw(.55, .5), mote: raw(.7, .68), aura: raw(.6, .55), ring: raw(.6, .8) }
}
const ground = (x, z) => Math.max(groundY(x, z), seaY())
const ball = (m, p, r, col, e = 0, sy = 1) => m.put(UNIT.ico1, { x: p[0], y: p[1] - r * sy, z: p[2], sx: r * 2, sy: r * 2 * sy, sz: r * 2 }, col, e)
const cubic = (a, b, c, d, u) => { const v = 1 - u; return [0, 1, 2].map(k => v * v * v * a[k] + 3 * v * v * u * b[k] + 3 * v * u * u * c[k] + u * u * u * d[k]) }
const topOf = id => {
  const t = featureTops.get(id)
  if (t) return t
  const f = D.world.features.find(q => q.id === id)
  return f ? [f.x + .5, level(f.x, f.y) * LH + .8, f.y + .5] : undefined
}
const nameOf = key => key.replace(/^(file|read):/, '').split(/[\\/]/).pop()

// What the page draws: eased toward the data, so a creature never jumps.
// The conversation's creature keeps `beast`; each spawnling its own, by agent id.
const creatureState = () => ({ turn: -1, x: 0, z: 0, y: 0, heading: 0, body: .2, reach: .5, sleep: 0, feet: [], wave: null, gaze: null, dil: .35, tokens: 0, tokAt: 0, rate: 0, vein: 0, flash: 0, c: null, R: 0 })
const beast = creatureState()
const kin = new Map()
const kinCrowns = new Map()  // each spawnling's crown this frame, for its lightning and its messages
let beastCrown = null
const grip = new Map()  // each tentacle's stage: reaching, holding, letting go
let camEye = null       // where the camera stands this frame, for glints
let nightLevel = 0      // how dark it is, 0 day to 1 night
// Where feet have landed lately: the grass there lies pressed flat a while.
const footprints = []
const landed = (st, p, reach, pitch = 1) => {
  footprints.push({ x: p[0], z: p[1], at: now, r: .22 + reach * .12 })
  if (footprints.length > 12) footprints.shift()
  const y = standAt(p[0], p[1])
  for (let k = 0; k < 5; k++) spawn({ p: [p[0] + rnd(-.08, .08), y + .03, p[1] + rnd(-.08, .08)], v: [rnd(-.3, .3), rnd(.1, .35), rnd(-.3, .3)], life: rnd(.6, 1.1), size: .16 + reach * .05, grow: .8, c: [.55, .48, .38], a: .32 })
  // A ring of dust kicked out along the ground.
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * TAU + rnd(-.2, .2)
    spawn({ p: [p[0] + Math.cos(a) * .08, y + .03, p[1] + Math.sin(a) * .08], v: [Math.cos(a) * (.6 + reach * .3), .08, Math.sin(a) * (.6 + reach * .3)], life: rnd(.4, .6), size: .1 + reach * .04, grow: 1.4, c: [.6, .52, .4], a: .26, drag: 3 })
  }
  play('thud', { at: [p[0], y, p[1]], gain: .3 + st.body * .55, rate: (1.3 - st.body * .5) * pitch, gap: .05 })
  shake = Math.max(shake, st.body * .02)
}
// How fast it is eating tokens: the veins pulse with it.
const feed = (st, b, t) => {
  if (b.tokens !== st.tokens) {
    const secs = Math.max(1, (t - (st.tokAt || t)) / 1000)
    if (st.tokAt && b.tokens > st.tokens) st.rate = mix(st.rate, (b.tokens - st.tokens) / secs, .5)
    st.tokens = b.tokens; st.tokAt = t
  } else if (t - st.tokAt > 30000) st.rate *= .98
  const want = b.doneAt !== undefined ? 0 : clamp(Math.log10(1 + st.rate / 3000) / 2, 0, 1)
  st.vein = mix(st.vein, want, .05)
}

// What it dreams of, asleep: the thing it worked on most in its last turn.
const dreamOf = (w, b) => {
  const counts = new Map()
  for (const ev of w.events || []) if (!ev.agent && ev.target !== undefined && ev.at >= b.bornAt) counts.set(ev.target, (counts.get(ev.target) || 0) + 1)
  let best, most = 0
  for (const [id, n] of counts) if (n >= most) { most = n; best = id }
  return best === undefined ? null : topOf(best) || null
}

const drawBeast = (m, dt) => {
  const w = D.world, b = w.beast, t = Date.now()
  beastCrown = null
  // Walls it pressed against glisten a few seconds, then dry.
  for (let k = wetSpots.length - 1; k >= 0; k--) {
    const s = wetSpots[k], age = now - s.at
    if (age > 6) { wetSpots.splice(k, 1); continue }
    glows.push([s.p[0], s.p[1], s.p[2], .3, .8, .75, 1, .14 * (1 - age / 6)])
  }
  drawWave(beast, dt)
  beast.flash = Math.max(0, beast.flash - dt * .45)
  if (b) {
    const S = beastShape(b, t)
    const isDone = b.doneAt !== undefined
    feed(beast, b, t)
    const [tx, tz] = beastAt(b, t)
    if (beast.turn !== b.turn) {
      // The first creature hatches; after that a new turn wakes it where it slept.
      if (beast.turn === -1) Object.assign(beast, { x: tx, z: tz, y: ground(tx, tz), body: .05, reach: .2, feet: [], sleep: isDone ? 1 : 0 })
      beast.turn = b.turn
      if (t - b.bornAt < 4000 && !isDone) {
        sparkleBurst([tx, ground(tx, tz) + .2, tz], [.8, .6, 1])
        play('growl', { at: [tx, ground(tx, tz) + .5, tz], gain: .75 })
        for (let k = 0; k < 24; k++) spawn({ p: [tx + rnd(-.3, .3), ground(tx, tz) + .5, tz + rnd(-.3, .3)], v: [rnd(-.6, .6), rnd(.2, .7), rnd(-.6, .6)], life: rnd(1.2, 2.2), size: .35, grow: .9, c: [.78, .72, .9], a: .3, drag: 1.2 })
        beast.wave = { p: [tx, ground(tx, tz) + .05, tz], t: 0, r: 1.5, c: [.85, .7, 1] }
      }
    }
    const [ir, ig] = EYES[b.model ? familyOf(b.model) : 'opus']
    // Its eyes on a child it waits on, when its tentacles hold nothing.
    const waitOn = [...(w.brood || [])].reverse().find(s => !s.parent && !s.isBackground && s.doneAt === undefined && kin.get(s.id)?.c)
    const act = w.activity || {}
    const names = [...new Set(w.features.filter(f => f.touchedAt && !f.by && t - f.touchedAt < 180000 && /^(file|read):/.test(f.key)).sort((p, q) => q.touchedAt - p.touchedAt).map(f => nameOf(f.key)))].slice(0, 4)
    const state = isDone ? `asleep after turn ${b.turn}, “${b.prompt}” · worked` : `at work on turn ${b.turn}, “${b.prompt}” · working`
    const crown = drawCreature(m, dt, t, b, beast, S, {
      seed: b.turn, P: VIOLET, mat: MAT.skin, iris: ir, irisGlow: ig, agent: undefined, isDone, drowsy: isDone, attend: !!w.waiting && !isDone,
      proto: true, mouths: true, chew: act.kind === 'writing' && !isDone, boil: act.kind === 'thinking' && w.isWorking === true && !isDone,
      heardAt: w.heardAt ?? 0, dreamOf: isDone ? dreamOf(w, b) : null, lookUp: risingLantern(),
      dil: (act.kind === 'writing' ? .65 : act.kind === 'thinking' ? .12 : .35), watch: waitOn ? kin.get(waitOn.id).c : null,
      pitch: 1, loud: 1, full: true,
      label: `The creature, ${state} ${fmtTime(S.seconds)} · ${fmtTokens(S.tokens)} tokens · ${S.eyes} eyes${b.model ? ` (${modelName(b.model)})` : ''}${names.length ? ` · in the middle of ${names.join(', ')}` : ''}`,
    })
    beastCrown = crown
    const words = signsOver(m, dt, crown, beast, isDone)
    // Its label: what it is doing (or that it sleeps); beneath, its model and what it has eaten.
    tags.push({ p: [crown[0], crown[1] + .9, crown[2]], group: 'claude', key: 'beast', text: words || (isDone ? `asleep after turn ${b.turn}` : 'the creature'), sub: `${b.model ? `${modelName(b.model)} · ` : ''}${fmtTokens(S.tokens)} tokens · ${fmtTime(S.seconds)}`, rank: words ? 1 : .6, live: !isDone || !!w.waiting, at: b.doneAt })
  }
  drawBrood(m, dt, t)
}

// What Claude is doing: the spinner's own words over the creature; a violet
// swirl while it thinks, pages fluttering while it writes. Asleep, z's drift
// up: amber when it is you it waits on.
const signsOver = (m, dt, crown, st, isDone) => {
  const w = D.world, act = w.activity || {}, c = st.c, R = st.R
  if (w.waiting || isDone) {
    if (Math.random() < dt * 1.2) spawn({ p: [crown[0] + .2, crown[1] + .2, crown[2]], v: [.15, .45, 0], life: 2.4, size: .22, c: w.waiting ? [1, .85, .45] : [.8, .86, 1], a: .8, add: true })
    return w.waiting ? `👁 waiting on you · ${w.waiting.reason}` : ''
  } else if (w.isWorking) {
    if (act.kind === 'thinking') {
      // Faint now: its body boils with the thinking itself.
      for (let k = 0; k < 6; k++) {
        const a = now * 1.6 + k / 6 * TAU, r = R * 1.5 + .4 + Math.sin(now * 2 + k) * .12
        glows.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a * 2 + now) * .15, c[2] + Math.sin(a) * r, .35, .75, .55, 1, .35])
      }
    } else if (act.kind === 'writing') {
      for (let k = 0; k < 6; k++) {
        const u = (now * .45 + k / 6) % 1, a = k * 1.7 + now * .3
        const p = [crown[0] + Math.cos(a) * (.3 + u * .9), crown[1] + u * 2.2, crown[2] + Math.sin(a) * (.3 + u * .9)]
        const flap = Math.sin(now * 9 + k) * .08
        m.sheet([p[0] - .08, p[1], p[2]], [p[0] + .08, p[1] + flap, p[2]], [p[0] + .08, p[1] - .12 + flap, p[2] + .02], [p[0] - .08, p[1] - .12, p[2] + .02], C('#fffaf0'), .6)
      }
    }
    return act.verb ? `${act.verb}…` : act.kind === 'thinking' ? '✦ thinking…' : act.kind === 'writing' ? '✎ writing…' : ''
  }
  return ''
}

// The brood: each subagent's spawnling. It hatches at its nest, works on its
// own, and with its answer crawls home to its parent and is absorbed; failed
// or stopped, it curls up where it stands. A teammate sleeps between
// messages. A silk thread ties each to a parent that waits on it.
const spawnLabel = (s, S) => {
  const who = s.isTeammate && s.name ? `${s.name}, a ${s.type} teammate` : s.isFork ? 'A fork of its parent' : `A ${s.type} spawnling`
  const state = s.outcome === 'done' ? 'home with its answer' : s.outcome === 'failed' ? 'failed, curled up' : s.outcome === 'aborted' ? 'stopped, curled up'
    : s.outcome === 'idle' ? 'asleep until a message comes' : s.isBackground ? 'at work in the background' : 'at work while its parent waits'
  return `${who} · “${s.task}” · ${state} · ${modelName(s.model)} eyes · ${fmtTime(S.seconds)} · ${fmtTokens(s.tokens)} tokens · ${s.calls} tool ${s.calls === 1 ? 'call' : 'calls'}`
}
const parentState = s => s.parent ? kin.get(s.parent) : beast
const drawBrood = (m, dt, t) => {
  const brood = D.world.brood || []
  const seen = new Set()
  kinCrowns.clear()
  // The nearest few are drawn whole; the rest plainer, so a swarm stays smooth.
  const eye = camEye || [0, 10, 0]
  const near = brood.filter(s => s.doneAt === undefined).map(s => [s.id, Math.hypot(s.x - eye[0], s.y - eye[2])]).sort((p, q) => p[1] - q[1]).slice(0, 8).map(p => p[0])
  for (const s of brood) {
    let st = kin.get(s.id)
    const home = homeAt(s)
    const par = parentState(s)
    // Always a little smaller than its parent, whatever it has eaten.
    const S = spawnShape(s, t, par && par.c ? par : undefined)
    let [tx, tz] = beastAt(s, t)
    // Home with its answer: it crawls to where its parent stands now, and sinks into it.
    let absorb = 0
    if (home !== undefined) {
      if (t - home > ABSORB * 1000) { if (st) kin.delete(s.id); continue }
      if (par && par.c) {
        const k = sstep(0, 1, (t - s.movedAt) / crawlMs(s))
        tx = mix(s.fromX, par.x, k); tz = mix(s.fromY, par.z, k)
      }
      absorb = clamp((t - home) / (ABSORB * 1000), 0, 1)
    }
    if (!st) {
      // Seen for the first time: one just laid cracks out of its egg at the nest.
      st = creatureState()
      Object.assign(st, { x: tx, z: tz, y: ground(tx, tz), body: t - s.bornAt < 4000 ? .03 : S.body, reach: t - s.bornAt < 4000 ? .1 : S.reach, sleep: s.doneAt !== undefined && home === undefined ? 1 : 0 })
      kin.set(s.id, st)
      if (t - s.bornAt < 4000) {
        const p = [tx, ground(tx, tz) + .15, tz], col = skinOf(s.hue, false).mote
        sparkleBurst(p, col)
        for (let k = 0; k < 10; k++) spawn({ p: [...p], v: [rnd(-.7, .7), rnd(.5, 1.3), rnd(-.7, .7)], life: rnd(.6, 1), size: .05, c: [.98, .95, .88], a: 1, buoy: -6, drag: .4 })
        play('pop', { at: p, gain: .4, rate: VOICE[familyOf(s.model)] })
        st.wave = { p: [tx, ground(tx, tz) + .05, tz], t: 0, r: .8, c: col }
      }
    }
    seen.add(s.id)
    drawWave(st, dt)
    st.flash = Math.max(0, st.flash - dt * .45)
    if (absorb > 0 && !st.absorbed) {
      // It sinks in: the parent's veins flash with how much it brings back.
      st.absorbed = true
      const big = haul(s)
      if (par) par.flash = Math.max(par.flash, clamp(big, .35, 1))
      const p = par && par.c ? par.c : [tx, ground(tx, tz) + .4, tz]
      // A gulp as it goes in: louder and deeper the longer the answer it carries.
      play('slurp', { at: p, gain: .3 + .5 * big, rate: 1.5 - .7 * big })
      if (big > .45) play('glug', { at: p, gain: .2 + .4 * big, rate: .85 - .3 * big, delay: .18 })
      for (let k = 0; k < 16; k++) spawn({ p: [...p], v: [rnd(-.5, .5), rnd(.2, .9), rnd(-.5, .5)], life: rnd(.5, 1), size: .06, c: skinOf(s.hue, false).mote, a: .9, add: true, drag: .8 })
    }
    if (absorb > 0 && par && par.c) { tx = mix(tx, par.c[0], absorb); tz = mix(tz, par.c[2], absorb) }
    feed(st, s, t)
    const hurt = s.outcome === 'failed' || s.outcome === 'aborted'
    const voice = VOICE[familyOf(s.model)]
    // A tick for each of its tool calls, at its own pitch; a crack when it fails.
    if (st.calls === undefined) st.calls = s.calls
    else if (s.calls > st.calls) {
      for (let q = 0; q < Math.min(3, s.calls - st.calls); q++) play('tap', { at: [tx, st.y + .3, tz], gain: .12, rate: voice * 1.25, delay: q * .12 })
      st.calls = s.calls
    }
    if (hurt && !st.hurt) { st.hurt = true; if (t - s.doneAt < 5000) play('crack', { at: [tx, st.y + .3, tz], gain: .35, rate: voice }) }
    const P = s.isFork && !hurt ? VIOLET : skinOf(s.hue, hurt)
    const vein = clamp(Math.max(st.vein, st.flash), 0, 1)
    const [ir, ig] = EYES[familyOf(s.model)]
    const shrink = 1 - absorb
    const isNear = near.includes(s.id)
    const kidWait = [...brood].reverse().find(q => q.parent === s.id && !q.isBackground && q.doneAt === undefined && kin.get(q.id)?.c)
    const crown = drawCreature(m, dt, t, { ...s, x: tx, y: tz, fromX: tx, fromY: tz, movedAt: 0 }, st, { ...S, body: S.body * shrink, reach: S.reach * shrink }, {
      seed: hashStr(s.id) % 997, P, mat: MAT.skin + .1 + .3 * vein, iris: ir, irisGlow: ig, agent: s.id,
      isDone: s.doneAt !== undefined && home === undefined, drowsy: s.doneAt !== undefined && home === undefined, letGo: s.doneAt !== undefined,
      dil: .35, watch: kidWait ? kin.get(kidWait.id).c : null, pitch: voice, loud: .6, full: isNear, proto: near.indexOf(s.id) >= 0 && near.indexOf(s.id) < 2, label: spawnLabel(s, S),
    })
    kinCrowns.set(s.id, crown)
    // Asleep: pale z's.
    if (s.doneAt !== undefined && home === undefined && Math.random() < dt * .8) spawn({ p: [crown[0] + .12, crown[1] + .1, crown[2]], v: [.1, .35, 0], life: 2, size: .14, c: hurt ? [1, .7, .65] : [.8, .86, 1], a: .7, add: true })
    // Its label: who it is (a teammate by its name), its model and calls; beneath, its task while it works.
    if (absorb === 0) {
      const who = s.isTeammate && s.name ? s.name : s.isFork ? 'fork' : s.type
      const state = s.outcome === 'failed' ? ' · failed' : s.outcome === 'aborted' ? ' · stopped' : s.outcome === 'idle' ? ' · asleep' : s.outcome === 'done' ? ' · home' : ''
      tags.push({
        p: [crown[0], crown[1] + .45, crown[2]], group: 'claude', key: `spawn:${s.id}`, dim: true,
        text: `${hurt ? '✖ ' : ''}${who} · ${modelName(s.model)} · ${s.calls} ${s.calls === 1 ? 'call' : 'calls'}${state}`,
        sub: s.doneAt === undefined ? clipText(s.task, 48) : '',
        rank: s.doneAt === undefined ? .75 : hurt ? .5 : .35, live: s.doneAt === undefined, at: s.doneAt ?? s.lastAt,
      })
    }
  }
  for (const id of kin.keys()) if (!seen.has(id)) kin.delete(id)
  // Silk: a thin thread from each parent that waits on its child, glinting as it trembles.
  for (const s of brood) {
    if (s.isBackground || s.doneAt !== undefined) continue
    const st = kin.get(s.id), par = parentState(s)
    if (!st || !st.c || !par || !par.c) continue
    const a = par.c, b = st.c, span = Math.hypot(b[0] - a[0], b[2] - a[2])
    const sag = .12 + span * .12
    const pts = [], rs = []
    for (let q = 0; q <= 14; q++) {
      const u = q / 14, p = [mix(a[0], b[0], u), mix(a[1], b[1], u) - sag * Math.sin(Math.PI * u) + .015 * Math.sin(now * 3 + q), mix(a[2], b[2], u)]
      p[1] = Math.max(p[1], ground(p[0], p[2]) + .06)
      pts.push(p); rs.push(.008)
    }
    m.mat = MAT.gloss
    m.tube(pts, rs, C('#e8e4f0'), .25, 4)
    m.mat = MAT.plain
    const g = pts[Math.floor(((now * .35 + hashStr(s.id) % 7 / 7) % 1) * 14)]
    glows.push([g[0], g[1], g[2], .14, .95, .95, 1, .45])
  }
}

// ------------------------------------------------------------------ protoplasm
// The creature's body is no ball but a heap of soft lobes run together under
// one skin: a field of blobs whose surface is found on a small grid each
// frame. The lobes drift, swell and fold back in as fast as it eats tokens;
// one bulges toward each thing a tentacle holds; springs pull them after the
// body, so they trail its crawl and pour after it. The town's buildings,
// trees and nests are solid to it: the skin presses flat against a wall,
// drapes over a roof, and squeezes thin between two houses.
const ISO = .25        // the skin: where the blobs' sum crosses this (a lone blob's lies at .71 of its reach)
const KEEP = .06       // how near a wall the skin comes before it presses flat
const solids = new Map()   // "i,j" → the box of the thing on that plot
const solidOf = f => {
  const t = featureTops.get(f.id)
  if (!t) return null
  const sh = f.shape
  const half = f.kind === 'house' ? Math.min(.46, ((sh ? sh.footprint : .56) + (sh && sh.wings ? .2 : 0)) / 2 + .04)
    : f.kind === 'tree' ? .3 : f.kind === 'camp' ? .42 : .32
  const cx = f.x + .5, cz = f.y + .5, y0 = level(f.x, f.y) * LH
  // A tree is squeezed past, not climbed.
  return { x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half, y0, y1: Math.max(y0 + .15, t[1] - .08), climb: f.kind !== 'tree' }
}
const buildSolids = () => {
  solids.clear()
  for (const f of D.world.features) { const s = solidOf(f); if (s) solids.set(`${f.x},${f.y}`, s) }
}
// Where a foot or a body can stand: the ground, or the roof of the thing on that plot.
const standAt = (x, z) => {
  const g = ground(x, z), s = solids.get(`${Math.floor(x)},${Math.floor(z)}`)
  return s && s.climb && x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1 ? Math.max(g, s.y1) : g
}
const standUnder = (x, z, r) => Math.max(standAt(x, z), standAt(x + r, z), standAt(x - r, z), standAt(x, z + r), standAt(x, z - r))
const solidsNear = (x, z, r) => {
  const out = []
  for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) for (let j = Math.floor(z - r); j <= Math.floor(z + r); j++) {
    const s = solids.get(`${i},${j}`)
    if (s) out.push(s)
  }
  return out
}
// How far a point is outside a box (negative inside).
const sdBox = (x, y, z, s) => {
  const qx = Math.abs(x - (s.x0 + s.x1) / 2) - (s.x1 - s.x0) / 2
  const qy = Math.abs(y - (s.y0 + s.y1) / 2) - (s.y1 - s.y0) / 2
  const qz = Math.abs(z - (s.z0 + s.z1) / 2) - (s.z1 - s.z0) / 2
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0)
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0)
}
const press = d => { if (d >= KEEP) return 1; if (d <= 0) return 0; const u = d / KEEP; return u * u * (3 - 2 * u) }
// The ground's height at a point, without making garbage (it is asked for every sample).
const groundFast = (x, z) => Math.max(level(Math.floor(x), Math.floor(z)) * LH, I.sea * LH)
// The body's field at a point: each blob [x, y, z, reach², weight, squash] adds
// (1 - d²/reach²)²; the things it touches, and the ground, press it to nothing inside them.
const bodyField = (balls, boxes) => (x, y, z) => {
  let s = 0
  for (let k = 0; k < balls.length; k++) {
    const b = balls[k], dx = x - b[0], dy = (y - b[1]) * b[5], dz = z - b[2], d2 = dx * dx + dy * dy + dz * dz
    if (d2 < b[3]) { const u = 1 - d2 / b[3]; s += u * u * b[4] }
  }
  if (s === 0) return 0
  for (let k = 0; k < boxes.length; k++) s *= press(sdBox(x, y, z, boxes[k]))
  return s * press(y - groundFast(x, z))
}
// Its skin: surface nets over the field, on a grid `dims` cells a side from lo,
// h apart. Each blob is laid only into the cells it reaches; the walls and the
// ground press it flat; each corner of the skin sits where it crosses its cell,
// facing the way the field falls, read off the grid. Gives the corners, their
// normals, and the triangles as index triples facing out.
let netVals = new Float32Array(8192), netIdx = new Int32Array(8192)
const CUBE_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]
const netSurface = (balls, boxes, lo, h, dims) => {
  const [nx, ny, nz] = dims, V = nx * ny * nz, step = [1, nx, nx * ny]
  if (netVals.length < V) { netVals = new Float32Array(V); netIdx = new Int32Array(V) }
  const vals = netVals, idx = netIdx, g = [0, 0, 0, 0, 0, 0, 0, 0]
  vals.fill(0, 0, V)
  for (const b of balls) {
    const r = Math.sqrt(b[3]), ry = r / b[5]
    const i0 = Math.max(0, Math.floor((b[0] - r - lo[0]) / h)), i1 = Math.min(nx - 1, Math.ceil((b[0] + r - lo[0]) / h))
    const j0 = Math.max(0, Math.floor((b[1] - ry - lo[1]) / h)), j1 = Math.min(ny - 1, Math.ceil((b[1] + ry - lo[1]) / h))
    const k0 = Math.max(0, Math.floor((b[2] - r - lo[2]) / h)), k1 = Math.min(nz - 1, Math.ceil((b[2] + r - lo[2]) / h))
    for (let k = k0; k <= k1; k++) {
      const dz = lo[2] + k * h - b[2]
      for (let j = j0; j <= j1; j++) {
        const dy = (lo[1] + j * h - b[1]) * b[5], dyz = dy * dy + dz * dz
        if (dyz >= b[3]) continue
        let p = i0 + nx * (j + ny * k)
        for (let i = i0; i <= i1; i++, p++) {
          const dx = lo[0] + i * h - b[0], d2 = dx * dx + dyz
          if (d2 < b[3]) { const u = 1 - d2 / b[3]; vals[p] += u * u * b[4] }
        }
      }
    }
  }
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = lo[0] + i * h, z = lo[2] + k * h, fl = groundFast(x, z)
    for (let j = 0, p = i + nx * ny * k; j < ny; j++, p += nx) {
      let s = vals[p]
      if (s > 0) {
        const y = lo[1] + j * h
        for (let q = 0; q < boxes.length; q++) s *= press(sdBox(x, y, z, boxes[q]))
        s *= press(y - fl)
      }
      vals[p] = s - ISO
    }
  }
  // A corner in each cell the skin passes through (the middle of where it
  // crosses the cell's edges), and with it the quads of the edges that run
  // from the cell's low corner, whose other three cells are already done.
  const verts = [], ns = [], tris = []
  const gradAt = (p, i, j, k, out, w) => {
    out[0] += w * (vals[i < nx - 1 ? p + 1 : p] - vals[i > 0 ? p - 1 : p])
    out[1] += w * (vals[j < ny - 1 ? p + nx : p] - vals[j > 0 ? p - nx : p])
    out[2] += w * (vals[k < nz - 1 ? p + step[2] : p] - vals[k > 0 ? p - step[2] : p])
  }
  const gr = [0, 0, 0], at = [0, 0, 0]
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const p = i + nx * (j + ny * k)
    idx[p] = -1
    let mask = 0
    for (let c = 0; c < 8; c++) { const v = vals[p + (c & 1) + ((c >> 1) & 1) * step[1] + (c >> 2) * step[2]]; g[c] = v; if (v > 0) mask |= 1 << c }
    if (mask === 0 || mask === 255) continue
    let ax = 0, ay = 0, az = 0, n = 0
    for (const [a, b] of CUBE_EDGES) {
      if (((mask >> a) & 1) === ((mask >> b) & 1)) continue
      const t = g[a] / (g[a] - g[b])
      ax += (a & 1) + ((b & 1) - (a & 1)) * t
      ay += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t
      az += (a >> 2) + ((b >> 2) - (a >> 2)) * t
      n++
    }
    ax /= n; ay /= n; az /= n
    idx[p] = verts.length
    verts.push([lo[0] + (i + ax) * h, lo[1] + (j + ay) * h, lo[2] + (k + az) * h])
    // Its normal: the field's slope at the cell's corners, blended to where it sits; outward is downhill.
    gr[0] = gr[1] = gr[2] = 0
    for (let c = 0; c < 8; c++) {
      const ci = c & 1, cj = (c >> 1) & 1, ck = c >> 2
      gradAt(p + ci + cj * step[1] + ck * step[2], i + ci, j + cj, k + ck, gr, (ci ? ax : 1 - ax) * (cj ? ay : 1 - ay) * (ck ? az : 1 - az))
    }
    ns.push(Math.hypot(gr[0], gr[1], gr[2]) < 1e-9 ? [0, 1, 0] : norm([-gr[0], -gr[1], -gr[2]]))
    at[0] = i; at[1] = j; at[2] = k
    const inside = (mask & 1) !== 0
    for (let d = 0; d < 3; d++) {
      if (inside === ((mask & (1 << (1 << d))) !== 0)) continue
      const u = (d + 1) % 3, v = (d + 2) % 3
      if (at[u] < 1 || at[v] < 1) continue
      const c00 = idx[p - step[u] - step[v]], c10 = idx[p - step[v]], c11 = idx[p], c01 = idx[p - step[u]]
      if (c00 < 0 || c10 < 0 || c01 < 0) continue
      if (inside) tris.push(c00, c10, c11, c00, c11, c01)
      else tris.push(c00, c11, c10, c00, c01, c11)
    }
  }
  return { verts, ns, tris }
}
// The skin's outward normal: the way the field falls fastest.
const fieldNormal = (field, p, e) => {
  const n = [field(p[0] - e, p[1], p[2]) - field(p[0] + e, p[1], p[2]), field(p[0], p[1] - e, p[2]) - field(p[0], p[1] + e, p[2]), field(p[0], p[1], p[2] - e) - field(p[0], p[1], p[2] + e)]
  return Math.hypot(n[0], n[1], n[2]) < 1e-9 ? [0, 1, 0] : norm(n)
}
// Where a ray from inside the body comes out through its skin: stepped out, then halved down to it.
const skinAlong = (field, c, d, reach, h) => {
  const f = t => field(c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t)
  let t0 = 0, t1 = reach
  for (let t = h * .5; t < reach; t += h * .5) { if (f(t) < ISO) { t1 = t; break } t0 = t }
  for (let k = 0; k < 5; k++) { const tm = (t0 + t1) / 2; if (f(tm) < ISO) t1 = tm; else t0 = tm }
  const t = (t0 + t1) / 2
  return [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t]
}

// The lobes: each wanders about its own place in the heap (`st.phase` runs as
// fast as it eats); one swells toward each thing it holds; one surges ahead
// as it crawls while the rest trail on springs; asleep they settle low. None
// passes through a thing: pushed out the shortest way, it pools against it,
// and the wall keeps a wet sheen a few seconds.
const wetSpots = []
const stepLobes = (st, c, R, dt, seed, n, pulls, move, boxes) => {
  const L = st.lobes || (st.lobes = [])
  while (L.length < n) L.push({ p: [...c], v: [0, 0, 0], r: R * .3, wetAt: 0 })
  L.length = n
  const ph = st.phase, sleep = st.sleep, speed = Math.hypot(move[0], move[2]), settle = st.settle
  for (let k = 0; k < n; k++) {
    const l = L[k]
    const a = k / n * TAU + seed + .8 * Math.sin(ph * .37 + k * 1.9)
    const e = -.15 + .5 * (rand2(k, 21, seed) - .5) + .35 * Math.sin(ph * .29 + k * 2.3) - .45 * sleep
    let dir = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]
    let dist = R * (.58 + .16 * Math.sin(ph * .53 + k * 1.3)) * (1 + .15 * settle)
    let r = R * (.44 + .14 * Math.sin(ph * .61 + k * 2.9)) * (.85 + .3 * rand2(k, 22, seed))
    if (k < pulls.length) { dir = norm(add(scl(dir, .25), scl(pulls[k], .75))); dist = R * .75; r *= 1.12 }
    else if (k === n - 1 && speed > .02) {
      const f = clamp(speed * 3, 0, 1)
      dir = norm(add(scl(dir, 1 - .8 * f), scl(norm(move), .8 * f))); dist = mix(dist, R * .8, f)
    }
    l.r = r
    const goal = [c[0] + dir[0] * dist, c[1] + dir[1] * dist * .8, c[2] + dir[2] * dist]
    if (Math.hypot(l.p[0] - goal[0], l.p[1] - goal[1], l.p[2] - goal[2]) > R * 5) { l.p = [...goal]; l.v = [0, 0, 0] }
    for (let q = 0; q < 3; q++) { l.v[q] += ((goal[q] - l.p[q]) * 32 - l.v[q] * 6.5) * dt; l.p[q] += l.v[q] * dt }
    for (const s of boxes) {
      const m = r * .45
      if (l.p[0] < s.x0 - m || l.p[0] > s.x1 + m || l.p[2] < s.z0 - m || l.p[2] > s.z1 + m || l.p[1] > s.y1 + m || l.p[1] < s.y0) continue
      const outs = [[l.p[0] - (s.x0 - m), 0, -1], [s.x1 + m - l.p[0], 0, 1], [l.p[2] - (s.z0 - m), 2, -1], [s.z1 + m - l.p[2], 2, 1], [s.y1 + m - l.p[1], 1, 1]]
      const [depth, axis, sign] = outs.reduce((p, q) => (q[0] < p[0] ? q : p))
      l.p[axis] += depth * sign
      if (l.v[axis] * sign < 0) l.v[axis] = 0
      if (axis !== 1 && now - l.wetAt > .35) {
        l.wetAt = now
        const spot = [...l.p]
        spot[axis] = axis === 0 ? (sign < 0 ? s.x0 : s.x1) : (sign < 0 ? s.z0 : s.z1)
        wetSpots.push({ p: spot, at: now })
        if (wetSpots.length > 30) wetSpots.shift()
      }
    }
    const fl = ground(l.p[0], l.p[2]) + r * .3
    if (l.p[1] < fl) { l.p[1] = fl; if (l.v[1] < 0) l.v[1] = 0 }
  }
}
// A jolt through the lobes: a twitch in its sleep, or a shiver when you speak to it.
const kick = (st, amount) => {
  for (const l of st.lobes || []) { const d = norm([rnd(-1, 1), rnd(-.3, 1), rnd(-1, 1)]); for (let q = 0; q < 3; q++) l.v[q] += d[q] * amount }
}
// The body drawn: lobes and core run together, deep-colored in the seams
// between them and bright where one swells alone, a faint sheen creeping
// over it, pale where it presses on something. Gives back its field, so
// eyes, mouths and bubbles can find the skin.
const SHIMMER = C('#5fb3c9')
const drawProtoplasm = (m, st, c, R, P, seed, fine, boxes) => {
  const ys = 1 + .14 * st.settle + .22 * st.sleep
  const balls = [[c[0], c[1], c[2], (R * .64 / .707) ** 2, 1, ys]]
  for (const l of st.lobes) balls.push([l.p[0], l.p[1], l.p[2], (l.r / .707) ** 2, 1, ys])
  const field = bodyField(balls, boxes)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const b of balls) { const s = Math.sqrt(b[3]) * .9; for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], b[q] - s); hi[q] = Math.max(hi[q], b[q] + s) } }
  const h = Math.max(R / (fine ? 5.5 : 4), Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 20)
  const dims = [0, 1, 2].map(q => Math.ceil((hi[q] - lo[q]) / h) + 3)
  for (let q = 0; q < 3; q++) lo[q] -= h
  const { verts, ns, tris } = netSurface(balls, boxes, lo, h, dims)
  const ax = norm([Math.sin(now * .13 + seed), .6, Math.cos(now * .11 + seed)])
  const cols = verts.map((p, k) => {
    let sum = 0, top = 0
    for (const b of balls) {
      const dx = p[0] - b[0], dy = (p[1] - b[1]) * b[5], dz = p[2] - b[2], d2 = dx * dx + dy * dy + dz * dz
      if (d2 < b[3]) { const u = 1 - d2 / b[3], v = u * u; sum += v; top = Math.max(top, v) }
    }
    const seam = sum > 0 ? clamp((1 - top / sum) * 1.8, 0, .85) : 0
    let touch = 0
    for (const s of boxes) touch = Math.max(touch, 1 - clamp(sdBox(p[0], p[1], p[2], s) / (KEEP * 2.5), 0, 1))
    const n = ns[k], shine = Math.max(0, n[1]) * .3, pale = touch * .35
    const glint = .07 * (.5 + .5 * Math.sin((n[0] * ax[0] + n[1] * ax[1] + n[2] * ax[2]) * 5 + now * .7))
    const out = [0, 0, 0]
    for (let q = 0; q < 3; q++) {
      let v = P.skin[q] + (P.crevice[q] - P.skin[q]) * seam
      v += (P.sheen[q] - v) * shine
      v += (SHIMMER[q] - v) * glint
      out[q] = v + (P.sucker[q] - v) * pale
    }
    return out
  })
  for (let q = 0; q < tris.length; q += 3) {
    const a = tris[q], b = tris[q + 1], d = tris[q + 2]
    m.triN(verts[a], verts[b], verts[d], ns[a], ns[b], ns[d], P.skin, 0, [cols[a], cols[b], cols[d]])
  }
  return { field, h }
}

// Lanterns: your ideas. A new one rises from the creature to its place, and its eyes follow it up.
const lanternBorn = new Map()   // id → { at, from }
let lanternsSeen = false
const lanternHome = l => { const R = I.R; return [clamp(l.x, -R, R), (7 + (l.id % 4) * 1.3) * LH + Math.sin(now * .8 + l.id) * .15, clamp(l.y, -R, R)] }
const lanternAt = l => {
  const home = lanternHome(l), b = lanternBorn.get(l.id)
  const u = b && b.from ? sstep(0, 1, (now - b.at) / 3.5) : 1
  return u >= 1 ? home : [mix(b.from[0], home[0], u), mix(b.from[1], home[1], u) + Math.sin(u * Math.PI) * 1.2, mix(b.from[2], home[2], u)]
}
const risingLantern = () => {
  let best = null, at = -Infinity
  for (const l of D.world.lanterns) { const b = lanternBorn.get(l.id); if (b && now - b.at < 6 && b.at > at) { best = l; at = b.at } }
  return best ? lanternAt(best) : null
}

// One creature: the conversation's, or a spawnling. `look` says whose it is
// and how it is drawn: its seed, its skin (P), its veins (mat), its eyes, the
// loop whose calls it answers (agent), whether it sleeps, what it watches.
// Returns its crown.
// Sent: a left click on the ground sends the conversation's creature there.
// It crawls over at its own pace, stays, and after SENT_HOLD seconds crawls
// back to where its own rules put it (the middle of its work), the same way.
const SENT_HOLD = 20, SENT_PACE = 1.6
const sent = { to: null, at: 0, x: 0, z: 0, on: false }
const sentAt = (st, tx, tz, dt) => {
  if (!sent.on) return [tx, tz]
  if (sent.to && now - sent.at > SENT_HOLD) sent.to = null
  const goal = sent.to || [tx, tz], dx = goal[0] - sent.x, dz = goal[1] - sent.z, d = Math.hypot(dx, dz), v = SENT_PACE * dt
  if (d > v) { sent.x += dx / d * v; sent.z += dz / d * v }
  else { sent.x = goal[0]; sent.z = goal[1]; if (!sent.to) sent.on = false }
  return [sent.x, sent.z]
}
const sendTo = (x, z) => {
  if (!D || !D.world.beast) return
  if (!sent.on) { sent.on = true; sent.x = beast.x; sent.z = beast.z }
  sent.to = [x, z]; sent.at = now
  // A ring where it was sent, in its own violet.
  const y = Math.max(standAt(x, z), seaY()) + .05
  for (let k = 0; k < 18; k++) { const a = k / 18 * TAU; spawn({ p: [x + Math.cos(a) * .1, y, z + Math.sin(a) * .1], v: [Math.cos(a) * .9, .05, Math.sin(a) * .9], life: .8, size: .12, c: [.78, .6, 1], a: .8, add: true, drag: 2.2 }) }
  play('tap', { at: [x, y, z], gain: .35, rate: .8 })
}

const drawCreature = (m, dt, t, b, st, S, look) => {
  const P = look.P
  const cry = (name, o) => play(name, { ...o, gain: (o.gain ?? 1) * look.loud, rate: (o.rate ?? 1) * look.pitch })
  let [tx, tz] = beastAt(b, t)
  // The conversation's own creature goes where you sent it, for a while.
  if (look.agent === undefined) [tx, tz] = sentAt(st, tx, tz, dt)
  const px = st.x, pz = st.z
  st.x = mix(st.x, tx, Math.min(1, dt * 5)); st.z = mix(st.z, tz, Math.min(1, dt * 5))
  // What it holds: the latest thing each of its tool calls worked on, a
  // tentacle apiece; one whose call failed is let go once it has snatched back.
  const latest = new Map()
  let lastCall = null
  for (const ev of D.world.events || []) {
    const since = (t - ev.at) / 1000
    if (ev.agent !== look.agent || ev.at < b.bornAt || since < 0) continue
    if (!['SendMessage', 'git-commit', 'presence-return'].includes(ev.tool) && (!lastCall || ev.at >= lastCall.at)) lastCall = ev
    if (ev.target === undefined || since > TENTACLE || toolKind(ev.tool) === 'web') continue
    latest.delete(ev.target)
    if (recoilOf(ev, t) < 1) latest.set(ev.target, ev)
  }
  const held = look.letGo ? [] : [...latest.values()].slice(look.full ? -8 : -3)
  // A blink runs across its eyes each time it moves on to its next call.
  const callAt = lastCall ? lastCall.at : 0
  if (st.callAt === undefined) st.callAt = callAt
  else if (callAt > st.callAt) { st.callAt = callAt; st.waveAt = now }
  // It turns to face where its tentacles reach, the newest counting most;
  // holding nothing, it faces the way it crawls; waiting on you, it faces you.
  let fx = 0, fz = 0
  held.forEach((ev, k) => {
    const p = topOf(ev.target)
    const dx = p ? p[0] - st.x : 0, dz = p ? p[2] - st.z : 0, l = Math.hypot(dx, dz)
    if (l > .05) { fx += dx / l * (1 + k); fz += dz / l * (1 + k) }
  })
  const vx = st.x - px, vz = st.z - pz
  if (look.attend && camEye) st.heading = lerpAngle(st.heading, Math.atan2(camEye[0] - st.x, camEye[2] - st.z), Math.min(1, dt * 1.6))
  else if (Math.hypot(fx, fz) > .4 && !look.drowsy) st.heading = lerpAngle(st.heading, Math.atan2(fx, fz), Math.min(1, dt * 2.2))
  else if (Math.hypot(vx, vz) > dt * .05) st.heading = lerpAngle(st.heading, Math.atan2(vx, vz), Math.min(1, dt * 4))
  st.body = mix(st.body, S.body, Math.min(1, dt * 1.5))
  st.reach = mix(st.reach, S.reach, Math.min(1, dt * 1.5))
  // Asleep its lids roll down; waiting on you they hang heavy, and it watches you.
  st.sleep = mix(st.sleep, look.drowsy ? 1 : look.attend ? .4 : 0, Math.min(1, dt * 1.6))
  if (look.drowsy && st.wasAwake) cry('sigh', { at: [st.x, st.y + .6, st.z], gain: .55 })
  st.wasAwake = !look.drowsy
  if (look.drowsy && st.sleep > .8 && now - (st.snoreAt ?? 0) > 6.5) { st.snoreAt = now; cry('sigh', { at: [st.x, st.y + .4, st.z], gain: .16, rate: .72 }) }
  // It stands on what is under it: the ground, or a roof it has climbed.
  st.y = mix(st.y, standUnder(st.x, st.z, st.body * .3), Math.min(1, dt * 3))
  const body = st.body, reach = st.reach, sleep = st.sleep, seed = look.seed
  const lift = (reach * .62 + body * .55) * (1 - .55 * sleep)
  const R = body * (1 + .045 * Math.sin(now * (2.4 - 1.5 * sleep)))
  const c = [st.x, st.y + lift, st.z]
  // You spoke to it while it worked: a shiver runs through it.
  if (look.heardAt !== undefined) {
    if (st.heardAt === undefined) st.heardAt = look.heardAt
    else if (look.heardAt > st.heardAt) { st.heardAt = look.heardAt; st.shiverAt = now; kick(st, body * 2.5) }
  }
  const shiver = st.shiverAt !== undefined ? Math.max(0, 1 - (now - st.shiverAt) / 1.2) : 0
  if (shiver > 0) { c[0] += Math.sin(now * 47) * R * .03 * shiver; c[2] += Math.cos(now * 53) * R * .03 * shiver }
  st.c = c; st.R = R
  // Asleep after its turn, now and then it twitches in a dream, and one eye
  // cracks open on the thing it worked on most that turn.
  let dream = 0
  if (look.dreamOf && sleep > .85) {
    if (st.dreamAt === undefined) st.dreamAt = now
    else if (now - st.dreamAt > 16 + rand2(Math.floor(st.dreamAt), 7, seed) * 8) { st.dreamAt = now; kick(st, body * 1.6) }
    const u = now - st.dreamAt
    dream = u < 2.4 ? Math.sin(u / 2.4 * Math.PI) : 0
  }
  const grips = sleep < .5 && !look.attend ? held : []
  // Between calls it tastes the air toward what it touched last.
  const taste = !look.isDone && !look.letGo && !look.drowsy && !look.attend && grips.length === 0 && lastCall && lastCall.target !== undefined && t - lastCall.at < 120000 ? topOf(lastCall.target) : null

  // Its protoplasm: the lobes move first, so the legs and the skin follow them.
  const proto = look.proto && Q.level > 0
  if (proto) {
    st.phase = (st.phase || 0) + dt * (.25 + 1.6 * st.vein) * (1 - .85 * sleep)
    const move = [vx / Math.max(dt, 1e-3), 0, vz / Math.max(dt, 1e-3)]
    st.settle = mix(st.settle ?? 0, 1 - clamp(Math.hypot(move[0], move[2]) * 2, 0, 1), Math.min(1, dt * 2))
    const pulls = grips.slice(-3).map(ev => topOf(ev.target)).filter(Boolean).map(p => norm([p[0] - c[0], Math.min(0, p[1] - c[1]) * .3, p[2] - c[2]]))
    const lobes = look.agent ? clamp(4 + Math.round((body - .13) / .3), 4, 6) : clamp(5 + Math.round((body - .2) / .26), 5, 9)
    st.boxes = solidsNear(c[0], c[2], R * 2.2)
    stepLobes(st, c, R, dt, seed, lobes, pulls, move, st.boxes)
  }

  // Eight legs, curving high like a spider's, a ripple running down each.
  // Each foot stays planted until the body has moved on from it, then steps,
  // never beside a stepping neighbour; it lands on the ground or a roof, and
  // where it lands dust puffs and the grass is pressed flat; a planted foot grips with a sucker.
  m.mat = look.mat
  const legW = .035 + body * .07
  for (let k = 0; k < 8; k++) {
    const a = st.heading + (k + .5) / 8 * TAU + (rand2(k, 3, seed) - .5) * .3
    const dir = [Math.sin(a), 0, Math.cos(a)]
    const spread = body + reach * (1.1 + .25 * sleep)
    const ideal = [st.x + dir[0] * spread, st.z + dir[2] * spread]
    let f = st.feet[k]
    if (!f || Math.hypot(f.p[0] - ideal[0], f.p[1] - ideal[1]) > spread * 2.5) f = st.feet[k] = { p: [...ideal], from: [...ideal], to: [...ideal], u: 1 }
    const busy = q => { const n = st.feet[(q + 8) % 8]; return n && n.u < 1 }
    if (f.u >= 1 && !busy(k - 1) && !busy(k + 1) && Math.hypot(f.p[0] - ideal[0], f.p[1] - ideal[1]) > reach * .45) {
      const over = [ideal[0] - f.p[0], ideal[1] - f.p[1]]
      f.from = [...f.p]; f.to = [ideal[0] + over[0] * .3, ideal[1] + over[1] * .3]; f.u = 0
    }
    let arc = 0
    if (f.u < 1) {
      f.u = Math.min(1, f.u + dt / .22)
      const e = sstep(0, 1, f.u)
      f.p = [mix(f.from[0], f.to[0], e), mix(f.from[1], f.to[1], e)]
      arc = Math.sin(Math.PI * f.u) * reach * .35
      if (f.u >= 1) landed(st, f.p, reach, look.pitch)
    }
    const foot = [f.p[0], standAt(f.p[0], f.p[1]) + arc, f.p[1]]
    const root = [c[0] + dir[0] * R * .7, c[1] - R * .2, c[2] + dir[2] * R * .7]
    const high = Math.max(root[1], foot[1])
    const hip = [root[0] + dir[0] * reach * .35, high + reach * (.8 - .5 * sleep), root[2] + dir[2] * reach * .35]
    const ankle = [mix(root[0], foot[0], .8), high + reach * (.45 - .3 * sleep), mix(root[2], foot[2], .8)]
    const side = [dir[2], 0, -dir[0]], wave = legW * (.9 + (f.u < 1 ? 1.2 : 0) + st.vein * .8) * (1 - .7 * sleep)
    const pts = [], rs = []
    for (let q = 0; q <= 9; q++) {
      const u = q / 9, p = cubic(root, hip, ankle, foot, u), s = Math.sin(Math.PI * u) * wave * Math.sin(now * 3.1 - u * 6 + k * 1.3)
      pts.push([p[0] + side[0] * s, p[1] + s * .35, p[2] + side[2] * s]); rs.push(legW * mix(.55, .18, u))
    }
    m.tube(pts, rs, P.leg, 0, look.full ? 6 : 4)
    if (look.full && f.u >= 1) m.ellipsoid([foot[0], foot[1] + legW * .05, foot[2]], [legW * .42, 0, 0], [0, legW * .1, 0], [0, 0, legW * .42], cmul(P.sucker, .55))
  }

  // Tendrils hang from its belly and sway.
  if (look.full) for (let k = 0; k < 6; k++) {
    const a = k / 6 * TAU + st.heading
    const start = [c[0] + Math.sin(a) * R * .45, c[1] - R * .7, c[2] + Math.cos(a) * R * .45]
    const len = Math.min(R * (.9 + rand2(k, 5, seed) * .8), Math.max(.05, start[1] - standAt(start[0], start[2]) - .05))
    const pts = [start]
    for (let q = 1; q <= 5; q++) {
      const prev = pts[q - 1]
      pts.push([prev[0] + Math.sin(now * 1.3 + k + q * .6) * q * .012, prev[1] - len / 5, prev[2] + Math.cos(now * 1.1 + k * 2 + q * .5) * q * .012])
    }
    m.tube(pts, pts.map((_, q) => legW * .42 * (1 - q * .16)), P.leg, 0, 5)
  }

  // The body: lobes under one skin, rearranging as it feeds (or, plainer, a lumpy breathing ball).
  let skin = null
  if (proto) skin = drawProtoplasm(m, st, c, R, P, seed, !look.agent, st.boxes)
  else {
    const lump = d => .1 * Math.sin(d[0] * 3.1 + now * 1.3 + seed) * Math.cos(d[2] * 2.7 - now * .9) + .06 * Math.sin(d[1] * 5 + now * 2.1)
    for (const tri of BLOB) {
      const ls = tri.map(lump)
      const ps = tri.map((d, q) => { const r = R * (1 + ls[q]); return [c[0] + d[0] * r, c[1] + d[1] * r * .88, c[2] + d[2] * r] })
      const ns = tri.map(d => norm([d[0], d[1] / .88, d[2]]))
      const cols = ls.map((l, q) => cmix(cmix(P.crevice, P.skin, clamp(.5 + l * 6, 0, 1)), P.sheen, Math.max(0, tri[q][1]) * .35))
      m.triN(ps[0], ps[1], ps[2], ns[0], ns[1], ns[2], P.skin, 0, cols)
    }
  }
  // A point on its skin the way d points, and which way the skin faces there.
  const onSkin = d => {
    if (!skin) return { p: [c[0] + d[0] * R * .96, c[1] + d[1] * R * .96 * .88, c[2] + d[2] * R * .96], n: d }
    const p = skinAlong(skin.field, c, d, R * 2.4, skin.h)
    return { p, n: norm(add(fieldNormal(skin.field, p, skin.h * .35), d)) }
  }

  // Its eyes turn to what matters most: a lantern rising, you while it waits
  // on you, the newest thing it holds, what it dreams of, what it tastes, a child it waits on.
  const newest = look.lookUp || (look.attend ? camEye : null) || (grips.length ? topOf(grips[grips.length - 1].target) : null) || (dream > .2 ? look.dreamOf : null) || taste || look.watch
  st.gaze = newest ? (st.gaze ? st.gaze.map((v, k) => mix(v, newest[k], Math.min(1, dt * 5))) : [...newest]) : null
  // Pupils: thin slits while it thinks, wide while it writes, wider at night.
  st.dil = mix(st.dil, clamp(look.dil + nightLevel * .3, 0, 1), Math.min(1, dt * 2))

  // Eyes: more as it feeds, each blinking in its own time; lids roll down to sleep.
  const eyeOn = (d, r) => { const s = onSkin(d); return { d: s.n, p: s.p, r } }
  const eyeAt = (theta, elev, r) => eyeOn([Math.sin(theta) * Math.cos(elev), Math.sin(elev), Math.cos(theta) * Math.cos(elev)], r)
  // Its face: the way it is heading, a little above level.
  const face = [Math.sin(st.heading) * Math.cos(.3), Math.sin(.3), Math.cos(st.heading) * Math.cos(.3)]
  const faceSide = norm(cross(face, [0, 1, 0])), faceUp = cross(faceSide, face)
  const faceDir = (rho, phi) => norm(add(scl(face, Math.cos(rho)), scl(add(scl(faceSide, Math.cos(phi)), scl(faceUp, Math.sin(phi) * .8)), Math.sin(rho))))
  const faceEye = (rho, phi, r) => eyeOn(faceDir(rho, phi), r)
  // Pupils of four kinds: a slit, round, a bar, and two side by side.
  const drawEye = (e, iris, glow, blink, o) => {
    const shut = Math.min(Math.max(sleep, blink), 1 - o.peek)
    const side0 = cross(e.d, [0, 1, 0]), side = Math.hypot(...side0) < 1e-3 ? [1, 0, 0] : norm(side0), up = cross(side, e.d)
    const sq = 1 - .9 * shut
    m.mat = MAT.gloss
    m.ellipsoid(e.p, scl(side, e.r), scl(up, e.r * sq), scl(e.d, e.r), SCLERA, .25)
    if (shut < .7) {
      let lk = e.d
      if (st.gaze) {
        lk = norm(add(e.d, scl(norm(sub(st.gaze, e.p)), 1.6)))
        if (dot(lk, e.d) < .3) lk = norm(add(lk, scl(e.d, .8)))
      }
      const ls0 = cross(lk, [0, 1, 0]), lside = Math.hypot(...ls0) < 1e-3 ? side : norm(ls0), lup = cross(lside, lk)
      const ip = add(e.p, scl(lk, e.r * .86)), pp = add(ip, scl(lk, e.r * .15)), dil = st.dil
      m.ellipsoid(ip, scl(lside, e.r * .56), scl(lup, e.r * .56 * sq), scl(lk, e.r * .2), iris, 2.2)
      if (o.pupil === 1) m.ellipsoid(pp, scl(lside, e.r * (.12 + .2 * dil)), scl(lup, e.r * (.12 + .2 * dil) * sq), scl(lk, e.r * .08), PUPIL)
      else if (o.pupil === 2) m.ellipsoid(pp, scl(lside, e.r * .44), scl(lup, e.r * (.05 + .14 * dil) * sq), scl(lk, e.r * .08), PUPIL)
      else if (o.pupil === 3) for (const s of [-1, 1]) m.ellipsoid(add(pp, scl(lside, e.r * .2 * s)), scl(lside, e.r * (.07 + .07 * dil)), scl(lup, e.r * (.07 + .07 * dil) * sq), scl(lk, e.r * .08), PUPIL)
      else m.ellipsoid(pp, scl(lside, e.r * (.07 + .24 * dil)), scl(lup, e.r * .5 * sq), scl(lk, e.r * .08), PUPIL)
      const toCam = camEye ? norm(sub(camEye, e.p)) : e.d
      const glint = add(e.p, scl(norm(add(add(e.d, scl(toCam, .7)), [0, .5, 0])), e.r * .93))
      m.ellipsoid(glint, [e.r * .11, 0, 0], [0, e.r * .11, 0], [0, 0, e.r * .11], [1, 1, 1], 4)
      glows.push([ip[0], ip[1], ip[2], e.r * 3, ...glow, .28 * (1 - shut)])
    }
    // The lid: a brow above the open eye, rolling down over it to close.
    m.mat = look.mat
    m.ellipsoid(add(e.p, scl(up, e.r * (1 - shut) * .78)), scl(side, e.r * 1.08), scl(up, e.r * (.26 + .78 * shut)), scl(e.d, e.r * 1.07), P.lid)
  }
  const blinkOf = (period, offset) => { const ph = ((now + offset) % period) / period; return ph > .95 ? Math.sin((ph - .95) / .05 * Math.PI) : 0 }
  // Waiting on you, all its eyes blink together, slow.
  const slowBlink = k => { const ph = ((now + k * .05) % 6.5) / 6.5; return ph > .92 ? Math.sin((ph - .92) / .08 * Math.PI) : 0 }
  // The blink that runs across its eyes when it moves on to its next call, side to side.
  const waveOf = e => {
    if (st.waveAt === undefined) return 0
    const u = (now - st.waveAt - (dot(e.d, faceSide) + 1) * .22) / .2
    return u > 0 && u < 1 ? Math.sin(u * Math.PI) : 0
  }
  // Most crowd its face, the biggest in the middle, spiralling out smaller;
  // every fifth looks out behind. They ride the skin as the lobes move, now
  // and then one sinks and opens again elsewhere, and a new one swells up from inside and opens.
  const eyes = look.full ? S.eyes : Math.min(2, S.eyes)
  if (st.eyeBorn === undefined) st.eyeBorn = Array(eyes).fill(-99)
  st.eyeBorn.length = Math.min(st.eyeBorn.length, eyes)
  while (st.eyeBorn.length < eyes) st.eyeBorn.push(now)
  const onFace = eyes - Math.floor(eyes / 5), drift = proto ? st.phase : 0
  for (let k = 0; k < eyes; k++) {
    const jitter = .85 + rand2(k, 13, seed) * .3
    const cyc = proto && k > 0 ? drift / (40 + rand2(k, 17, seed) * 40) + rand2(k, 18, seed) : 0
    const hop = Math.floor(cyc), u = cyc - hop
    const sink = proto && k > 0 ? (u < .05 ? 1 - u / .05 : u > .95 ? (u - .95) / .05 : 0) : 0
    let e
    if (k % 5 === 4) e = eyeAt(st.heading + Math.PI + (rand2(k, 11, seed) - .5) * 2.4 + hop * 1.3, (rand2(k, 12, seed) - .2) * .9, body * .11 * jitter)
    else {
      const j = k - Math.floor((k + 1) / 5)
      const rho = .95 * Math.sqrt(j / Math.max(1, onFace)) * (1 + .12 * Math.sin(drift * .23 + k)), phi = j * 2.39996 + rand2(k, 11, seed) * .4 + .25 * Math.sin(drift * .3 + k * 1.7) + hop * 2.39996
      e = faceEye(rho, phi, body * (j === 0 ? .25 : .19 - .07 * Math.sqrt(j / onFace)) * jitter)
    }
    const age = now - st.eyeBorn[k]
    e.r *= sstep(0, 1.1, age) * (1 - .65 * sink)
    if (e.r < .004) continue
    const blink = Math.max(blinkOf(3 + rand2(k, 14, seed) * 4, rand2(k, 15, seed) * 9), waveOf(e), sink, 1 - sstep(.9, 1.6, age), look.attend ? slowBlink(k) : 0)
    drawEye(e, look.iris, look.irisGlow, blink, { pupil: k === 0 ? 0 : Math.floor(rand2(k, 16, seed) * 4), peek: k === 0 ? dream * .55 : 0 })
  }

  // Mouths in the seams below its eyes: shut while it thinks, chewing while it writes its answer.
  if (skin && look.mouths) {
    const count = 1 + (body > .55 ? 1 : 0) + (body > .95 ? 1 : 0)
    for (let k = 0; k < count; k++) {
      const s = onSkin(faceDir(1.05, -Math.PI / 2 + (count === 1 ? 0 : (k / (count - 1) - .5) * 1.4))), n = s.n
      const sd0 = cross(n, [0, 1, 0]), sd = Math.hypot(...sd0) < 1e-3 ? faceSide : norm(sd0), up = cross(sd, n)
      const chew = look.chew ? .25 + .75 * Math.abs(Math.sin(now * (3 + 7 * st.vein) + k * 1.7)) : .05
      const w = R * (k === Math.floor(count / 2) ? .3 : .21), gape = w * .45 * chew, mid = add(s.p, scl(n, -w * .05))
      // The dark of its throat, flush with the skin; lips rolled round it, bowing apart as it opens; small teeth above.
      m.ellipsoid(mid, scl(sd, w * .95), scl(up, Math.max(gape, w * .03)), scl(n, w * .1), PUPIL)
      for (const v of [1, -1]) {
        const lip = []
        for (let q = 0; q <= 8; q++) { const u = q / 4 - 1; lip.push(add(add(mid, scl(sd, u * w)), add(scl(up, v * gape * (1 - u * u)), scl(n, w * .05)))) }
        m.tube(lip, lip.map((_, q) => w * .08 * (1 - .55 * Math.abs(q / 4 - 1))), P.lid, 0, 5)
      }
      if (chew > .3) for (let q = 1; q <= 5; q++) {
        const u = q / 3 - 1, at = add(add(mid, scl(sd, u * w * .85)), scl(up, gape * (1 - u * u) - w * .06))
        m.ellipsoid(add(at, scl(n, w * .03)), scl(sd, w * .04), scl(up, w * .08), scl(n, w * .04), cmul(SCLERA, .9))
      }
    }
  }

  // Thinking, it boils: bubbles rise through its skin, swell and pop.
  if (skin && look.boil && Math.random() < dt * 4) (st.bubbles || (st.bubbles = [])).push({ d: norm([rnd(-1, 1), rnd(-.1, 1), rnd(-1, 1)]), at: now, life: rnd(.8, 1.6), r: R * rnd(.08, .16) })
  if (st.bubbles && st.bubbles.length) {
    m.mat = MAT.gloss
    for (const bb of st.bubbles) {
      const u = (now - bb.at) / bb.life, s = skin ? onSkin(bb.d) : null
      if (!s) continue
      if (u >= 1) {
        for (let q = 0; q < 5; q++) spawn({ p: [...s.p], v: add(scl(s.n, rnd(.3, .7)), [rnd(-.2, .2), rnd(0, .2), rnd(-.2, .2)]), life: .4, size: .035, c: P.mote, a: .8, add: true, drag: 1 })
        if (Math.random() < .3) cry('pop', { at: s.p, gain: .06, rate: rnd(1.6, 2.2) })
        continue
      }
      const r = bb.r * sstep(0, .8, u)
      m.ellipsoid(add(s.p, scl(s.n, r * .35)), [r, 0, 0], [0, r, 0], [0, 0, r], cmix(P.sheen, [1, 1, 1], .25), .35)
    }
    st.bubbles = st.bubbles.filter(bb => now - bb.at < bb.life)
    m.mat = look.mat
  }

  // Between calls it tastes the air: a feeler pokes out toward what it touched last, and draws back.
  if (taste) {
    const cyc = ((now + seed * .37) % 5.5) / 5.5, out = cyc < .5 ? Math.sin(cyc / .5 * Math.PI) : 0
    if (out > .02) {
      const flat = [taste[0] - c[0], 0, taste[2] - c[2]], to = Math.hypot(flat[0], flat[2]) > .05 ? norm(flat) : [face[0], 0, face[2]]
      const d = norm([to[0], -.15, to[2]]), base = onSkin(d).p, len = (.15 + R * .9) * out
      const sideT = norm(cross(d, [0, 1, 0])), pts = []
      for (let q = 0; q <= 6; q++) {
        const u = q / 6, w = Math.sin(now * 7 + u * 5) * .03 * u
        pts.push([base[0] + d[0] * len * u + sideT[0] * w, base[1] + d[1] * len * u + Math.sin(u * Math.PI) * len * .15, base[2] + d[2] * len * u + sideT[2] * w])
      }
      m.tube(pts, pts.map((_, q) => legW * (.5 - q * .055)), P.leg, 0, 5)
      const tip = pts[pts.length - 1], r = legW * .3
      m.ellipsoid(tip, [r, 0, 0], [0, r, 0], [0, 0, r], P.sucker, .2)
    }
  }

  const crown = [c[0], c[1] + R * .9, c[2]]
  if (Math.random() < dt * 1.1) spawn({ p: [c[0] + rnd(-.45, .45) * R, c[1] - R * .8, c[2] + rnd(-.45, .45) * R], v: [0, -.15, 0], life: 1.2, size: .05, c: P.drip, a: .8, buoy: -7 })
  if (Math.random() < dt * 3 * (1 - sleep * .7) * (look.full ? 1 : .4)) {
    const a = rnd(0, TAU), e = rnd(-.2, 1)
    spawn({ p: [c[0] + Math.cos(a) * Math.cos(e) * R, c[1] + Math.sin(e) * R * .88, c[2] + Math.sin(a) * Math.cos(e) * R], v: [rnd(-.05, .05), rnd(.15, .35), rnd(-.05, .05)], life: rnd(2, 3.5), size: .07, c: P.mote, a: .75, add: true, drag: .2 })
  }
  glows.push([c[0], c[1], c[2], R * 3 + .5, ...P.aura, .14 * (1 - sleep * .6)])

  // Tentacles: up out of its back, over, and down onto what each tool call
  // works on, kept clear of the ground. Each works in the way of its call
  // (MANNER): a read is drunk in, swallowed up the tentacle; a new file is
  // poured into from above; an edit is picked at with pincers; a shell
  // command's forge is coiled round and squeezed; a search hangs an eye over
  // its beacon, sweeping a beam; an egg is laid in a nest; a shrine blooms; an
  // MCP crystal is sparked. It holds a while and lets go; a failed call
  // snatches back, red.
  m.mat = look.mat
  for (const ev of grips) {
    const target = topOf(ev.target)
    if (!target) continue
    const kind = mannerOf(ev.tool), M = MANNER[kind], col = KIND_COLOR[kind].map(v => Math.sqrt(v))
    const since = (t - ev.at) / 1000, recoil = recoilOf(ev, t), id = ev.id
    const out = sstep(0, M.reach, since) * (1 - sstep(TENTACLE - 1.2, TENTACLE, since)) * (1 - recoil)
    if (out < .02) continue
    const work = sstep(.85, 1, out) * (1 - recoil)  // fully out: its tip at work
    // Where the tip goes: onto the thing, or over it.
    let tip = [target[0], target[1] + M.hover, target[2]]
    if (kind === 'search') { const a = now * 1.1 + id; tip = [tip[0] + Math.cos(a) * .35, tip[1] + .1 * Math.sin(now * 1.3 + id), tip[2] + Math.sin(a) * .35] }
    else if (kind === 'read') tip[1] += .06 * Math.abs(Math.sin(now * 2.2 + id))
    else if (kind === 'edit') { const a = now * 9 + id; tip = [tip[0] + Math.cos(a) * .07, tip[1] + .05 * Math.abs(Math.sin(now * 13 + id)), tip[2] + Math.sin(a * 1.3) * .07] }
    else if (kind === 'write' || kind === 'skill') tip[1] += .05 * Math.sin(now * 1.6 + id)
    const isCoil = kind === 'bash'
    const root = [c[0], c[1] + R * .55, c[2]]
    const end = isCoil ? [target[0] + .3, target[1] + .45, target[2]] : tip
    const span = Math.hypot(end[0] - root[0], end[2] - root[2])
    const peak = Math.max(root[1], end[1]) + .8 + span * .35
    const c1 = [mix(root[0], end[0], .15), peak, mix(root[2], end[2], .15)]
    const c2 = [mix(root[0], end[0], .85), peak, mix(root[2], end[2], .85)]
    const side = norm(cross(sub(end, root), [0, 1, 0]))
    const spasm = 1 + recoil * 5, ph = now * M.speed + id
    const at = u => {
      const p = cubic(root, c1, c2, end, u), s = Math.sin(Math.PI * u)
      const wig = Math.sin(ph * 2 + u * 7) * M.wig * s * spasm
      const q = [p[0] + side[0] * wig, p[1] + Math.cos(ph * 1.5 + u * 5) * M.wig * .4 * s * spasm + recoil * s * 1.2, p[2] + side[2] * wig]
      if (u < .97) q[1] = Math.max(q[1], ground(q[0], q[2]) + .15)
      return q
    }
    const full = Array.from({ length: 19 }, (_, q) => at(q / 18))
    if (isCoil) {
      // Twice round the forge, winding down it.
      const a0 = Math.atan2(end[2] - target[2], end[0] - target[0])
      for (let q = 1; q <= 14; q++) {
        const u = q / 14, a = a0 + u * 2.2 * TAU, r = .3 - u * .06
        full.push([target[0] + Math.cos(a) * r, target[1] + .45 - u * .8 + .03 * Math.sin(now * 6 - q), target[2] + Math.sin(a) * r])
      }
    }
    // How thick along its length: a swallow travels up a reading tentacle, a
    // gulp down a writing one, an egg down a laying one; a coil squeezes.
    const n = full.length - 1, base = (body * .085 + .015) * M.thick, tipR = isCoil ? base * .55 : .012 * M.thick
    const flow = (now * .7 + id * .3) % 1, swallow = kind === 'read' ? 1 - flow : flow
    const radii = full.map((_, q) => {
      let r = q <= 18 ? mix(base, tipR, q / 18) : mix(base * .55, base * .3, (q - 18) / 14)
      if (kind === 'read' || kind === 'write' || kind === 'agent') r *= 1 + .9 * Math.exp(-((q / n - swallow) ** 2) / .003) * work
      if (isCoil) r *= 1 + .18 * Math.sin(now * 7 - q * .6) * work
      return r
    })
    // Its working end takes the call's color; a coil glows like the forge; a failure reddens it.
    const cols = full.map((_, q) => {
      let k = cmix(P.leg, cmul(col, .55), sstep(.55, 1, q / n) * .55)
      if (isCoil && q > 18) k = cmix(P.leg, [.75, .25, .06], .45 + .25 * Math.sin(now * 7 - q * .6))
      return ev.isError ? cmix(k, [.55, .06, .05], .35 + recoil * .5) : k
    })
    // As much of it as has reached out.
    const x = out * n, whole = Math.floor(x), f = x - whole
    const pts = full.slice(0, whole + 1), rs = radii.slice(0, whole + 1), cs = cols.slice(0, whole + 1)
    if (whole < n && f > .01) { pts.push(full[whole].map((v, k) => mix(v, full[whole + 1][k], f))); rs.push(mix(radii[whole], radii[whole + 1], f)); cs.push(cols[whole + 1]) }
    if (pts.length < 2) continue
    const head = pts[pts.length - 1], dir = norm(sub(head, pts[pts.length - 2]))
    const hs0 = cross(dir, [0, 1, 0]), hs = Math.hypot(...hs0) < 1e-3 ? [1, 0, 0] : norm(hs0), hu = cross(hs, dir)

    // Its sounds: reaching out, taking hold, at work, letting go, snatching back.
    let g0 = grip.get(id)
    if (!g0) { g0 = { stage: since > M.reach + .1 ? (since > TENTACLE - 1.2 ? 3 : 2) : 0, next: since + M.every }; grip.set(id, g0); if (grip.size > 64) grip.delete(grip.keys().next().value) }
    if (g0.stage === 0) { g0.stage = 1; cry('squelch', { at: root, gain: .3 + body * .35, rate: { read: 1.25, write: .8, edit: 1.4, bash: .75, search: 1.1 }[kind] ?? 1, gap: .06 }) }
    if (g0.stage === 1 && since >= M.reach) {
      g0.stage = 2
      cry(M.sound, { at: tip, gain: .5, rate: isCoil ? .7 : 1, gap: .05 })
      if (!['search', 'mcp', 'write', 'skill'].includes(kind)) for (let k = 0; k < 12; k++) spawn({ p: [...target], v: [rnd(-.8, .8), rnd(.3, 1.2), rnd(-.8, .8)], life: rnd(.5, 1), size: rnd(.04, .07), c: k % 2 ? P.drip : col, a: .9, buoy: -8, drag: .5 })
    }
    if (g0.stage === 2 && M.every && since >= g0.next) { g0.next = since + M.every * rnd(.75, 1.3); cry(M.hum, { at: tip, gain: M.gain, rate: rnd(.92, 1.08), gap: .3 }) }
    if (g0.stage === 2 && since >= TENTACLE - 1.2) { g0.stage = 3; cry('slurp', { at: tip, gain: .4, gap: .06 }) }
    if (recoil > 0 && g0.stage < 4) {
      g0.stage = 4
      cry('slurp', { at: head, gain: .5, rate: 1.8 })
      for (let k = 0; k < 14; k++) spawn({ p: [...head], v: [rnd(-1, 1), rnd(.4, 1.5), rnd(-1, 1)], life: rnd(.4, .8), size: rnd(.04, .07), c: [.85, .15, .1], a: .9, buoy: -8, drag: .5 })
    }
    if (g0.stage === 2 && !['write', 'bash', 'search', 'mcp'].includes(kind) && Math.random() < dt) {
      const d = pts[Math.min(pts.length - 1, 4 + Math.floor(Math.random() * 12))]
      spawn({ p: [d[0], d[1] - .03, d[2]], v: [0, -.2, 0], life: 1.1, size: .045, c: P.drip, a: .85, buoy: -7 })
    }

    m.tube(pts, rs, P.leg, 0, look.full ? 6 : 4, cs)
    if (look.full) for (let q = 3; q < pts.length - 2; q += 3) {
      const p = pts[q], r = rs[q] * .45
      m.ellipsoid([p[0], p[1] - rs[q] * .85, p[2]], [r, 0, 0], [0, r * .6, 0], [0, 0, r], P.sucker)
    }

    // Its tip at work.
    if (work > .05) switch (kind) {
      case 'read': {
        // A mouth sucks at the file; green motes rise into it.
        const open = (.7 + .3 * Math.sin(now * 4.4 + id)) * work
        m.ellipsoid(add(head, scl(dir, .02)), scl(hs, base * 1.4 * open), scl(hu, base * 1.4 * open), scl(dir, base * .35), cmix(P.leg, col, .35))
        if (Math.random() < dt * 8 * work) {
          const a = rnd(0, TAU), from = [target[0] + Math.cos(a) * .35, target[1] - .1, target[2] + Math.sin(a) * .35]
          spawn({ p: from, v: scl(sub(head, from), 1.6), life: .6, size: .06, c: col, a: .9, add: true })
        }
        break
      }
      case 'write': {
        // A spout pours gold down into the new file.
        m.ellipsoid(add(head, scl(dir, -.02)), scl(hs, base * 1.5 * work), scl(hu, base * 1.5 * work), scl(dir, base * .7), cmix(P.leg, col, .3))
        if (Math.random() < dt * 14 * work) spawn({ p: add(head, [rnd(-.03, .03), -.04, rnd(-.03, .03)]), v: [rnd(-.05, .05), -.6, rnd(-.05, .05)], life: .75, size: rnd(.05, .08), c: col, a: .95, buoy: -6 })
        if (Math.random() < dt * 3 * work) spawn({ p: [target[0] + rnd(-.15, .15), target[1] + .02, target[2] + rnd(-.15, .15)], v: [rnd(-.3, .3), rnd(.3, .7), rnd(-.3, .3)], life: .5, size: .05, c: col, a: .9, add: true, buoy: -2 })
        break
      }
      case 'edit': {
        // Pincers pick at it, quick, and sparks chip off.
        const open = .35 + .3 * Math.sin(now * 14 + id)
        for (let k = 0; k < 3; k++) {
          const a = k / 3 * TAU + now * 2, rad = add(scl(hs, Math.cos(a)), scl(hu, Math.sin(a)))
          const p1 = add(head, scl(norm(add(dir, scl(rad, open * 1.6))), .09 * work))
          const p2 = add(p1, scl(norm(add(dir, scl(rad, -open))), .07 * work))
          m.tube([head, p1, p2], [base * .5, base * .35, base * .12], cmix(P.leg, col, .25), 0, 5)
        }
        if (Math.random() < dt * 10 * work) spawn({ p: [...target], v: [rnd(-.9, .9), rnd(.4, 1.2), rnd(-.9, .9)], life: rnd(.15, .3), size: .045, c: [1, .9, .55], a: 1, add: true, buoy: -6 })
        break
      }
      case 'bash': {
        // Coiled round the forge, squeezing: embers fly and smoke rises.
        if (Math.random() < dt * 12 * work) {
          const p = pts[Math.min(pts.length - 1, 19 + Math.floor(Math.random() * 14))]
          spawn({ p: [...p], v: [rnd(-.3, .3), rnd(.5, 1.2), rnd(-.3, .3)], life: rnd(.5, 1), size: .05, c: [1, .55, .15], a: 1, add: true, buoy: 1 })
        }
        if (Math.random() < dt * .7 * work) spawn({ p: [target[0], target[1] + .5, target[2]], v: [rnd(-.1, .1), .45, rnd(-.1, .1)], life: 1.6, size: .2, grow: .6, c: [.35, .33, .32], a: .22, drag: .3 })
        break
      }
      case 'search': {
        // An eye on a stalk hangs over it, sweeping a beam across the land.
        const er = (.07 + body * .05) * work, ep = add(head, scl(dir, er * .7))
        const lk = norm(sub([target[0], target[1] - .2, target[2]], ep))
        const ls0 = cross(lk, [0, 1, 0]), ls = Math.hypot(...ls0) < 1e-3 ? [1, 0, 0] : norm(ls0), lu = cross(ls, lk)
        const ip = add(ep, scl(lk, er * .86))
        m.mat = MAT.gloss
        m.ellipsoid(ep, [er, 0, 0], [0, er, 0], [0, 0, er], SCLERA, .25)
        m.ellipsoid(ip, scl(ls, er * .55), scl(lu, er * .55), scl(lk, er * .2), col, 2)
        m.ellipsoid(add(ip, scl(lk, er * .15)), scl(ls, er * .15), scl(lu, er * .45), scl(lk, er * .08), PUPIL)
        m.mat = look.mat
        const spot = [target[0] + (tip[0] - target[0]) * 1.6, 0, target[2] + (tip[2] - target[2]) * 1.6]
        spot[1] = ground(spot[0], spot[2]) + .05
        for (let q = 1; q <= 5; q++) { const p = add(ep, scl(sub(spot, ep), q / 5)); glows.push([p[0], p[1], p[2], .12 + q * .08, ...col, .35 * work]) }
        glows.push([spot[0], spot[1], spot[2], .7, ...col, .6 * work])
        break
      }
      case 'agent': {
        // An egg swells at its tip, in the color of the nest's kind, and drops into the nest.
        const nest = D.world.features.find(q => q.id === ev.target)
        const egg = nest && nest.kind === 'camp' ? hsl(broodHue(nest.key.replace(/^camp:/, '')), .5, .72) : cmix(P.leg, col, .5)
        if (g0.bud === undefined) g0.bud = since + 1.2
        if (since >= g0.bud) {
          g0.bud = since + rnd(1.1, 1.8)
          spawn({ p: [...head], v: [rnd(-.15, .15), -.2, rnd(-.15, .15)], life: 1, size: .12, c: egg.map(v => Math.sqrt(v)), a: .95, buoy: -6, drag: .4 })
          cry('pop', { at: head, gain: .22, rate: rnd(.7, .9), gap: .2 })
        }
        const ripe = (.02 + .06 * clamp(1 - (g0.bud - since) / 1.5, 0, 1)) * work
        m.ellipsoid(add(head, scl(dir, ripe)), [ripe * .8, 0, 0], [0, ripe, 0], [0, 0, ripe * .8], egg, .3)
        break
      }
      case 'skill': {
        // Its tip blooms open in petals over the shrine.
        const open = (.5 + .25 * Math.sin(now * 1.2 + id)) * work
        for (let k = 0; k < 5; k++) {
          const a = k / 5 * TAU + now * .5, rad = add(scl(hs, Math.cos(a)), scl(hu, Math.sin(a)))
          const pd = norm(add(scl(rad, Math.sin(open * 1.4)), scl(dir, Math.cos(open * 1.4)))), tw = norm(cross(dir, rad)), nn = cross(pd, tw)
          m.ellipsoid(add(head, scl(pd, .1 * work)), scl(pd, .11 * work), scl(tw, .055 * work), scl(nn, .015), col, .5)
        }
        if (Math.random() < dt * 5 * work) spawn({ p: add(head, [rnd(-.1, .1), 0, rnd(-.1, .1)]), v: [rnd(-.2, .2), rnd(.2, .5), rnd(-.2, .2)], life: rnd(.8, 1.4), size: .05, c: col, a: .9, add: true, drag: .5 })
        break
      }
      case 'mcp': {
        // Crystal spines along it; sparks leap from its tip to the crystal.
        m.mat = MAT.gloss
        for (let q = 4; q < pts.length - 1; q += 3) { const p = pts[q], r = rs[q] * work; m.ellipsoid(add(p, [0, r * 1.4, 0]), [r * .35, 0, 0], [0, r * 1.2, 0], [0, 0, r * .35], col, .8) }
        m.mat = MAT.plain
        if (Math.sin(now * 23 + id) > -.3) boltRods(m, head, target, id + Math.floor(now * 12), .25, col, 5 * work, .025)
        m.mat = look.mat
        break
      }
    }

    // A glow at its working end, and a pulse running along it: up into the
    // body for a read, down into the work for the rest.
    glows.push([head[0], head[1], head[2], .35 + .15 * Math.sin(now * 8 + id), ...col, .5 * out])
    const pulse = pts[Math.round(swallow * (pts.length - 1))]
    glows.push([pulse[0], pulse[1], pulse[2], .25, ...col, .5 * out])
    // Hovered, it says what it is doing.
    const thing = D.world.features.find(q => q.id === ev.target)
    if (thing && out > .5) creaturePicks.push({ p: head, label: `A tentacle ${M.verb} ${/^(file|read):/.test(thing.key) ? nameOf(thing.key) : `· ${thing.label}`}${ev.isError ? ' · the call failed' : ''}` })
    if (thing && out > .5) tags.push({ p: [head[0], head[1] + .3, head[2]], group: 'activity', key: `grip:${ev.id}`, text: `${ev.isError ? '✖ ' : ''}${ev.tool} · ${/^(file|read):/.test(thing.key) ? nameOf(thing.key) : clipText(thing.label, 30)}`, rank: ev.isError ? .6 : .45, live: true, at: ev.at })
  }
  m.mat = MAT.plain
  creaturePicks.push({ p: crown, label: look.label })
  return crown
}

// A ring of light spreads where a creature hatches.
const drawWave = (st, dt) => {
  const wv = st.wave
  if (!wv) return
  wv.t += dt
  if (wv.t > 1.3) { st.wave = null; return }
  for (let q = 0; q < 32; q++) {
    const a = q / 32 * TAU, r = wv.r * sstep(0, 1, wv.t / 1.3)
    glows.push([wv.p[0] + Math.cos(a) * r, wv.p[1], wv.p[2] + Math.sin(a) * r, .45, ...wv.c, 1 - wv.t / 1.3])
  }
}

// Each tool call answers from the creature for a few seconds: lightning up
// for the web, red lightning down on an error, sparks where a tentacle grips.
const crownFor = agent => agent ? kinCrowns.get(agent) : beastCrown
const drawEffects = m => {
  const w = D.world
  for (const ev of w.events || []) {
    const age = (Date.now() - ev.at) / 1000
    if (ev.at <= 0 || age < 0 || age > EFFECT || ev.tool === 'git-commit' || ev.tool === 'presence-return') continue
    // Lightning and rings answer from whichever creature made the call.
    const crown = crownFor(ev.agent)
    if (ev.tool === 'SendMessage') { drawParcel(m, ev, age); continue }
    const fade = age < .25 ? age / .25 : 1 - (age - .25) / (EFFECT - .25)
    const kind = toolKind(ev.tool)
    const target = ev.target !== undefined ? topOf(ev.target) : undefined
    const flicker = .7 + .3 * Math.sin(now * 40 + ev.id)
    if (ev.isError && target) {
      boltRods(m, [target[0] + .6, target[1] + 9, target[2] + .3], target, ev.id, 1.1, C('#ff5a4a'), 6 * fade * flicker, .05 * fade + .01)
      glows.push([target[0], target[1], target[2], 2.4 * fade, 1, .3, .25, fade])
      if (!burst.has(ev.id)) {
        burst.add(ev.id); sparkleBurst(target, [1, .35, .25])
        if (age < 1.5) { play('crack', { at: target, gain: .8 }); shake = Math.max(shake, .22); flash = Math.max(flash, .3); flashCol = [1, .35, .3] }
      }
    } else if (kind === 'web') {
      if (!crown) continue
      const sky = [crown[0] + (rand2(ev.id, 1, 3) - .5) * 4, crown[1] + 10, crown[2] + (rand2(ev.id, 2, 3) - .5) * 4]
      boltRods(m, crown, sky, ev.id, 1.3, KIND_COLOR.web, 7 * fade * flicker, .05 * fade + .01)
      if (!burst.has(`web${ev.id}`) && age < 1.5) { burst.add(`web${ev.id}`); play('zap', { at: crown, gain: .6 }); flash = Math.max(flash, .28); flashCol = [.8, .9, 1] }
      glows.push([crown[0], crown[1], crown[2], 3 * fade, .7, .85, 1, fade])
    } else if (target) {
      // A soft ring of the call's color; the tentacle itself does the rest.
      glows.push([target[0], target[1], target[2], (.8 + (1 - fade) * .9), ...KIND_COLOR[mannerOf(ev.tool)].map(v => Math.sqrt(v)), fade * .3])
      if (!burst.has(ev.id) && age < 1.5) {
        burst.add(ev.id)
        if (kind === 'bash') play('sizzle', { at: target, gain: .45 })
        if (kind === 'bash') for (let k = 0; k < 24; k++) spawn({ p: [...target], v: [rnd(-1, 1), rnd(.5, 2), rnd(-1, 1)], life: rnd(.4, 1), size: .07, c: [1, .6, .2], a: 1, add: true, buoy: -3 })
      }
    } else if (crown) {
      glows.push([crown[0], crown[1], crown[2], 2.2 * fade, 1, .85, .5, fade])
    }
  }
  // Recently worked things glow, fading over ten minutes.
  for (const f of w.features) {
    const g = glowOf(f.touchedAt)
    const t = featureTops.get(f.id)
    if (g > .05 && t) glows.push([t[0], t[1] - .3, t[2], 1.1 + g * .8, 1, .8, .5, g * .28])
  }
}

// A message between creatures: a parcel tossed from the sender over to the
// recipient, tumbling along its arc, caught with a pop.
const PARCEL = 1.6
const drawParcel = (m, ev, age) => {
  const a = crownFor(ev.agent), b = ev.to === 'main' ? beastCrown : ev.to ? kinCrowns.get(ev.to) : undefined
  if (!a || !b) return
  const u = clamp(age / PARCEL, 0, 1)
  if (!burst.has(`msg${ev.id}`) && age < 1) { burst.add(`msg${ev.id}`); play('whoosh', { at: a, gain: .35, rate: 1.3 }) }
  if (u >= 1) {
    if (!burst.has(`got${ev.id}`) && age < PARCEL + 1) { burst.add(`got${ev.id}`); play('pop', { at: b, gain: .3, rate: 1.1 }); sparkleBurst(b, [1, .9, .7]) }
    return
  }
  const span = Math.hypot(b[0] - a[0], b[2] - a[2])
  const p = [mix(a[0], b[0], u), mix(a[1], b[1], u) + (.6 + span * .3) * Math.sin(Math.PI * u), mix(a[2], b[2], u)]
  m.put(UNIT.cube, { x: p[0], y: p[1] - .045, z: p[2], sx: .13, sy: .09, sz: .09, ry: age * 5, rx: age * 3 }, C('#f1e3c0'))
  m.put(UNIT.cube, { x: p[0], y: p[1] - .047, z: p[2], sx: .135, sy: .095, sz: .02, ry: age * 5, rx: age * 3 }, C('#c0392b'))
  glows.push([p[0], p[1], p[2], .5, 1, .92, .7, .5])
  if (Math.random() < .5) spawn({ p: [...p], v: [0, -.1, 0], life: .5, size: .05, c: [1, .9, .7], a: .7, add: true })
  const from = ev.agent ? (D.world.brood || []).find(s => s.id === ev.agent) : undefined
  const to = ev.to === 'main' ? undefined : (D.world.brood || []).find(s => s.id === ev.to)
  const who = s => s ? (s.isTeammate && s.name ? s.name : `the ${s.type} spawnling`) : 'the creature'
  creaturePicks.push({ p, label: `A message from ${who(from)} to ${who(to)}` })
  const short = s => s ? (s.isTeammate && s.name ? s.name : s.type) : 'Claude'
  tags.push({ p: [p[0], p[1] + .25, p[2]], group: 'activity', key: `msg:${ev.id}`, text: `✉ ${short(from)} → ${short(to)}`, rank: .55, live: true, at: ev.at })
}

// ------------------------------------------------------------------ the machine and the repository

// The harbor: a pier from the shore. With a git remote the branch flies on its
// flag, commits to push wait at the pier, commits to pull ride offshore.
const harbor = { end: null, far: null, dir: null, side: null, flagTop: null }
const shipMesh = (m, x, y, z, heading, sail, scale = 1, hull = C('#6b4a33')) => {
  const { P } = body(m, x, y, z, heading)
  P(UNIT.wedge, 0, -.04 * scale, 0, .22 * scale, .12 * scale, .62 * scale, hull, 0, { rx: Math.PI })
  P(UNIT.cube, 0, .02 * scale, 0, .2 * scale, .03 * scale, .5 * scale, cmul(hull, 1.2))
  P(UNIT.cyl6, 0, .04 * scale, .02, .025 * scale, .55 * scale, .025 * scale, C('#5b3d27'))
  m.sheet(...[[0, .1, .05], [0, .55, .05], [0, .12, -.22]].map(([ox, oy, oz]) => body(m, x, y, z, heading).W(ox * scale, oy * scale, oz * scale)), body(m, x, y, z, heading).W(0, .1 * scale, -.2 * scale), sail)
}
const buildHarbor = m => {
  harbor.end = null
  const h = D.island.harbor
  if (!h) return
  const sea = seaY() + .06
  const dir = [h.di, 0, h.dj], side = [-h.dj, 0, h.di]
  const at = (t, s, y = sea) => [h.i + .5 + h.di * t + side[0] * s, y, h.j + .5 + h.dj * t + side[2] * s]
  const wood = C('#8a6a45')
  for (let t = .3; t < 2.5; t += .22) {
    const a = at(t, -.2), b = at(t, .2)
    m.put(UNIT.cube, { x: (a[0] + b[0]) / 2, y: sea, z: (a[2] + b[2]) / 2, sx: h.di ? .2 : .44, sy: .05, sz: h.di ? .44 : .2 }, cmul(wood, .9 + (t * 7 % 1) * .2))
  }
  for (const t of [.5, 1.2, 1.9, 2.4]) for (const s of [-.2, .2]) {
    const p = at(t, s, sea - .5)
    m.put(UNIT.cyl6, { x: p[0], y: p[1], z: p[2], sx: .06, sy: .62, sz: .06 }, C('#5b3d27'))
  }
  harbor.end = at(2.5, 0)
  harbor.dir = dir; harbor.side = side
  const reach = Math.max(1.5, I.seaRadius - .8 - Math.hypot(harbor.end[0], harbor.end[2]))
  harbor.far = at(2.5 + reach, 0)
  picks.push({ p: at(1.4, 0, sea + .3), label: D.world.git && D.world.git.hasRemote ? `The harbor · ${D.world.git.host || 'remote'} · branch ${D.world.git.branch || '?'}` : 'The harbor: ships sail in with downloads and out with uploads' })
  const git = D.world.git
  if (git && git.hasRemote) {
    const pole = at(2.35, .12)
    m.put(UNIT.cyl6, { x: pole[0], y: sea, z: pole[2], sx: .05, sy: 1.5, sz: .05 }, C('#5b4636'))
    harbor.flagTop = [pole[0], sea + 1.5, pole[2]]
    for (let k = 0; k < Math.min(4, git.ahead); k++) {
      const p = at(.8 + k * .5, k % 2 ? -.55 : .55)
      shipMesh(m, p[0], sea - .02, p[2], Math.atan2(dir[0], dir[2]), C('#f6f1e8'), .9)
      m.put(UNIT.cube, { x: p[0], y: sea + .04, z: p[2], sx: .12, sy: .1, sz: .12 }, C('#c89b62'))
      picks.push({ p: [p[0], sea + .5, p[2]], label: 'A commit waiting to be pushed' })
      if (k === 0) fixedTags.push({ p: [p[0], sea + .75, p[2]], group: 'git', make: () => ({ text: `↑ ${git.ahead} to push`, rank: .5, live: true }) })
    }
  } else harbor.flagTop = null
}

const buildLighthouses = m => {
  for (const l of D.island.lighthouses || []) {
    const y = level(l.i, l.j) * LH
    const { P, W } = frame(m, l.i + .5, y, l.j + .5, 0, 1)
    P(UNIT.cyl8, 0, 0, 0, .34, 1.5, .34, C('#f4f1ea'))
    for (const band of [.35, .85]) P(UNIT.cyl8, 0, band, 0, .35, .22, .35, C('#c0392b'))
    P(UNIT.cyl8, 0, 1.5, 0, .3, .22, .3, C('#fff3c4'), 4)
    P(UNIT.cone8, 0, 1.72, 0, .36, .26, .36, C('#3a3a3a'))
    beams.push({ lamp: W(0, 1.62, 0), seed: l.port })
    picks.push({ p: W(0, 1.9, 0), label: `${l.name} listening on :${l.port}` })
    fixedTags.push({ p: W(0, 2.15, 0), group: 'machine', make: () => ({ text: `${l.name} :${l.port}`, rank: .5, live: true }) })
  }
}

// ------------------------------------------------------------------ labels
// Floating labels, each in a group the Labels panel (N) can hide, ranked by
// how much its thing matters (0 to 1) and how lately it changed. Things that
// stay put are tagged as the island is built (`fixedTags`, worded afresh each
// frame so "2m ago" keeps time); moving things as they are drawn (`tags`).
// Each frame the best are placed first; one that would cover a label already
// placed, or stands behind a hill, waits its turn, and hovering still tells.
const TAG_GROUPS = [
  { id: 'claude', name: 'Claude', about: 'the creature, spawnlings, nests', c: '#b48cff' },
  { id: 'files', name: 'Files', about: 'buildings', c: '#ffcf73' },
  { id: 'folders', name: 'Folders', about: 'district gates', c: '#e8e2d0' },
  { id: 'reads', name: 'Reads', about: 'trees: files read', c: '#7fd18b' },
  { id: 'tools', name: 'Tools', about: 'forges, beacons, windmills, shrines, crystals', c: '#ff9c5a' },
  { id: 'tests', name: 'Tests', about: 'the last run, rope bridges', c: '#5cb85c' },
  { id: 'git', name: 'Git', about: 'branch and commits', c: '#d97757' },
  { id: 'machine', name: 'Machine', about: 'programs, servers, cost, weather', c: '#8fc3ff' },
  { id: 'ideas', name: 'Ideas', about: 'lanterns, monoliths', c: '#ffe08a' },
  { id: 'activity', name: 'Activity', about: 'tentacles, messages, townsfolk', c: '#ff7ad1' },
  { id: 'wildlife', name: 'Wildlife', about: 'animals', c: '#c9b48a' },
]
const GROUP_COLOR = Object.fromEntries(TAG_GROUPS.map(g => [g.id, g.c]))
// How many show: at most `max`, none ranked under `min` (a bar that rises with distance).
const DENSITY = [
  { name: 'Off', max: 0, min: 9 }, { name: 'Few', max: 8, min: .55 }, { name: 'Some', max: 25, min: .3 },
  { name: 'Lots', max: 60, min: .1 }, { name: 'All', max: 250, min: 0 },
]
const TAG_PRESETS = {
  claude: { groups: ['claude', 'activity'], density: 3 },
  town: { groups: ['files', 'folders', 'reads', 'tests', 'git'], density: 3 },
  machine: { groups: ['machine', 'git'], density: 3 },
  all: { groups: TAG_GROUPS.map(g => g.id), density: 4 },
}
const RECENT_MS = 600000
// The viewer's own choice, kept in this browser: groups shown, density, the
// density N goes back to, and whether only recent things are labelled.
const tagSet = (() => {
  const base = { groups: Object.fromEntries(TAG_GROUPS.map(g => [g.id, g.id !== 'wildlife'])), density: 2, back: 2, recent: false, query: '' }
  try {
    const s = JSON.parse(localStorage.getItem('terrarium.labels') || '{}')
    if (s && typeof s === 'object') {
      for (const g of TAG_GROUPS) if (typeof (s.groups || {})[g.id] === 'boolean') base.groups[g.id] = s.groups[g.id]
      if (Number.isInteger(s.density) && s.density >= 0 && s.density < DENSITY.length) base.density = s.density
      if (Number.isInteger(s.back) && s.back > 0 && s.back < DENSITY.length) base.back = s.back
      base.recent = s.recent === true
    }
  } catch { }
  return base
})()
const saveTags = () => { try { localStorage.setItem('terrarium.labels', JSON.stringify({ groups: tagSet.groups, density: tagSet.density, back: tagSet.back, recent: tagSet.recent })) } catch { } }

const fixedTags = []    // { p, group, style?, make: () => ({ text, rank, at?, live?, sub?, key? }) | null }
const tags = []         // this frame's: { p, group, text, rank, at?, live?, sub?, dim?, style?, key? }
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const ago = at => `${fmtTime(Math.max(0, (Date.now() - at) / 1000))} ago`
const fmtRate = b => (b < 1e3 ? `${Math.round(b)} B/s` : b < 1e6 ? `${Math.round(b / 1e3)} KB/s` : `${(b / 1e6).toFixed(1)} MB/s`)

// What each thing on the island is, in a few words; hovering gives the whole sentence.
const FEATURE_GROUP = { house: 'files', tree: 'reads', camp: 'claude', treasury: 'machine', monolith: 'ideas' }
const featureTag = f => {
  const at = f.touchedAt, fresh = at && Date.now() - at < 3600000 ? ` · ${ago(at)}` : ''
  const tail = s => s.slice(s.indexOf(':') + 1)
  switch (f.kind) {
    case 'house': {
      const hurt = f.isScorched === true || f.isWounded === true, busy = (D.busy || []).includes(f.id)
      return { text: `${hurt ? '⚠ ' : ''}${nameOf(f.key)}${f.shape ? ` · ${f.shape.lines} lines` : ''}${fresh}`, rank: .32 + (hurt ? .25 : 0) + (busy ? .2 : 0) + Math.min(.1, (f.size || 1) * .01), at, key: f.id }
    }
    case 'tree': return { text: `${nameOf(f.key)} · read ${f.size}×`, rank: .2, at, key: f.id }
    case 'camp': return { text: `${tail(f.key)} nest · ${f.size} ${f.size === 1 ? 'egg' : 'eggs'}`, rank: .3, at, key: f.id }
    case 'forge': return { text: `⚒ ${clipText(f.label, 40)}`, rank: .3, at, key: f.id }
    case 'beacon': return { text: `⌕ ${clipText(f.label.replace(/^Searched for /, ''), 36)}`, rank: .2, at, key: f.id }
    case 'windmill': {
      const host = /https?:\/\/([^/\s]+)/.exec(f.label)
      return { text: `🌐 ${host ? host[1] : clipText(tail(f.label).trim(), 36)}`, rank: .25, at, key: f.id }
    }
    case 'shrine': return { text: `✧ ${tail(f.key)}`, rank: .3, at, key: f.id }
    case 'crystal': return { text: `◆ ${tail(f.key)}`, rank: .3, at, key: f.id }
    case 'signpost': return { text: '? a question for you', rank: .3, at, key: f.id }
    case 'banner': return { text: '☰ the plan', rank: .25, at, key: f.id }
    case 'cairn': return { text: clipText(f.label, 30), rank: .2, at, key: f.id }
    case 'monolith': return { text: `▮ compaction ${tail(f.key)}`, rank: .3, at, key: f.id }
    case 'treasury': {
      const usd = `$${(D.world.cost ?? 0).toFixed(2)}`
      return { text: D.world.isFlatRate ? `≈${usd} at API prices` : usd, rank: .45, live: true, key: f.id }
    }
  }
  return null
}
// The last test run, over the watchtower worked most lately.
const testRunTag = () => {
  const t = D.world.tests
  if (!t) return null
  return { text: t.failed ? `✖ ${t.failed} failed · ${t.passed} passed` : `✔ ${t.passed} passed`, sub: clipText(t.command || '', 40), rank: t.failed ? .75 : .5, at: t.at }
}
let towerMemo = { v: -1, f: null }
const lastTower = () => {
  if (towerMemo.v !== version) towerMemo = { v: version, f: D.world.features.filter(f => f.style === 'test').sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0))[0] || null }
  return towerMemo.f
}
// The disk's reading floats over the river cell nearest the island's heart.
let riverSpot = null
const findRiver = () => {
  riverSpot = null
  let best = Infinity
  for (let i = -I.G; i < I.G; i++) for (let j = -I.G; j < I.G; j++) {
    const d = Math.hypot(i + .5, j + .5)
    if (d < best && biomeAt(i, j) === BIOME.river) { best = d; riverSpot = [i + .5, level(i, j) * LH + .5, j + .5] }
  }
}
// A folder's gate: its name, its files, and when one of them was last worked.
const gateTag = (d, mine) => {
  const at = Math.max(0, ...mine.map(f => f.touchedAt || 0))
  return { text: `${d.name}/ · ${d.files} ${d.files === 1 ? 'file' : 'files'}`, rank: .5, at: at || undefined, key: `gate:${d.dir}` }
}

// The machine's readings where their weather is: the context (rain and tide)
// and RAM (waves) on the sea before you, the disk over the river, the limits
// over the sun and the moon as they circle (only when the limits are reported).
const skyTags = (eye, sunPos, moonPos, sunP, moonP) => {
  const sys = D.world.system || {}, r = (I.R + I.seaRadius) / 2
  const len = Math.hypot(eye[0], eye[2]) || 1, ax = eye[0] / len, az = eye[2] / len
  const onSea = a => [(ax * Math.cos(a) - az * Math.sin(a)) * r, seaY() + .6, (ax * Math.sin(a) + az * Math.cos(a)) * r]
  tags.push({ p: onSea(-.85), group: 'machine', key: 'tide', text: `🌧 context ${Math.round(D.world.tide)}%`, rank: .4 + (D.world.tide > 70 ? .15 : 0), live: true })
  if (sys.ram !== undefined) tags.push({ p: onSea(.85), group: 'machine', key: 'ram', text: `🌊 RAM ${Math.round(sys.ram * 100)}%`, rank: .3, live: true })
  if (riverSpot && (sys.diskRead !== undefined || sys.diskWrite !== undefined)) tags.push({ p: riverSpot, group: 'machine', key: 'disk', text: `disk ${fmtRate((sys.diskRead || 0) + (sys.diskWrite || 0))}`, rank: .2, live: true })
  for (const [at, p, key, name] of [[sunPos, sunP, 'sun', 'session'], [moonPos, moonP, 'moon', 'week']]) {
    if (p === null) continue
    tags.push({ p: add(at, [0, I.seaRadius * .14, 0]), group: 'machine', key, text: `${key === 'sun' ? '☀' : '☾'} ${name} ${Math.round(p * 100)}% used`, rank: .35, live: true })
  }
}

// Is there a hill between the eye and p, or the disc's rock? The ground along
// the way, sampled; off the disc's edge there is only space.
const behindHill = (eye, p) => {
  const Rs = I.seaRadius
  for (let k = 1; k < 24; k++) {
    const u = k / 24, x = mix(eye[0], p[0], u), z = mix(eye[2], p[2], u), y = mix(eye[1], p[1], u)
    if (Math.hypot(x, z) > Rs) continue
    if (y < groundY(x, z) + .12 && y > underAt(x, z)) return true
  }
  return false
}

const tagLayer = (() => { const d = document.createElement('div'); d.id = 'tagLayer'; document.getElementById('gl').after(d); return d })()
const tagPool = []
const tagEl = k => {
  let el = tagPool[k]
  if (!el) {
    el = document.createElement('div')
    el.main = el.appendChild(document.createElement('span'))
    el.sub = el.appendChild(document.createElement('small'))
    el.was = {}
    tagLayer.appendChild(el); tagPool.push(el)
  }
  return el
}
// Only what changed is written to the page.
const setTag = (el, key, value, write) => { if (el.was[key] !== value) { el.was[key] = value; write(value) } }
let shownKeys = new Set()
const tagCounts = {}    // per group: [shown, in view], for the panel
let tagCrowded = 0      // how many waited their turn this frame, for the panel
const drawTags = (VP, eye) => {
  const d = DENSITY[tagSet.density], q = tagSet.query.trim().toLowerCase(), t = Date.now()
  for (const g of TAG_GROUPS) tagCounts[g.id] = [0, 0]
  const all = tags.slice()
  for (const f of fixedTags) { const v = f.make(); if (v) all.push({ p: f.p, group: f.group, style: f.style, ...v }) }
  const cand = []
  for (const tag of all) {
    const s = M4.apply(VP, tag.p)
    if (s[2] <= .2 || Math.abs(s[0]) > 1.02 || Math.abs(s[1]) > 1.04) continue
    tagCounts[tag.group][1]++
    if (!tagSet.groups[tag.group] || d.max === 0) continue
    const recent = tag.live || (tag.at !== undefined && t - tag.at < RECENT_MS)
    if (tagSet.recent && !recent) continue
    const hit = q !== '' && `${tag.text} ${tag.sub || ''}`.toLowerCase().includes(q)
    if (q && !hit) continue
    const key = `${tag.group}:${tag.key ?? tag.text}`
    const fresh = tag.live ? .25 : tag.at !== undefined ? .3 * Math.exp(-(t - tag.at) / RECENT_MS) : 0
    // From far off only what matters most, or changed lately: the bar rises with distance (not for a search, or All).
    const dist = s[2], bar = q || d.min === 0 ? 0 : d.min + clamp((dist - 28) / 60, 0, .25)
    if (tag.rank + fresh < bar) continue
    const score = tag.rank + fresh + .25 * clamp(1 - dist / 60, 0, 1) + .1 * (1 - Math.min(1, Math.hypot(s[0], s[1]))) + (shownKeys.has(key) ? .15 : 0)
    cand.push({ tag, key, hit, dist, score, x: (s[0] * .5 + .5) * innerWidth, y: (1 - (s[1] * .5 + .5)) * innerHeight })
  }
  cand.sort((a, b) => b.score - a.score)
  const placed = [], next = new Set()
  tagCrowded = 0
  for (const c of cand) {
    if (placed.length >= d.max) break
    const { tag } = c, isName = tag.style === 'name'
    // Farther labels are smaller and quieter.
    const sc = clamp(1.2 - c.dist / 55, .72, 1.05) * (tag.dim ? .88 : 1)
    const len = Math.max(tag.text.length, (tag.sub || '').length * .84)
    const w = (isName ? len * 7.6 : len * 6.6 + 18) * sc, h = (isName ? 15 : tag.sub ? 33 : 20) * sc
    const r = [c.x - w / 2 - 3, c.y - h - 3, c.x + w / 2 + 3, c.y + 1]
    if (placed.some(o => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) { tagCrowded++; continue }
    if (behindHill(eye, tag.p)) continue
    placed.push(r); next.add(c.key)
    c.sc = sc; c.alpha = clamp(1.25 - c.dist / 70, .6, 1) * (tag.dim ? .85 : 1)
    tagCounts[tag.group][0]++
  }
  shownKeys = next
  let k = 0
  for (const c of cand) {
    if (c.sc === undefined) continue
    const el = tagEl(k++), tag = c.tag
    setTag(el, 'show', true, () => { el.style.display = 'block' })
    setTag(el, 'cls', `tag${tag.style === 'name' ? ' name' : ''}${c.hit ? ' hit' : ''}`, v => { el.className = v })
    setTag(el, 'g', GROUP_COLOR[tag.group], v => el.style.setProperty('--g', v))
    setTag(el, 'text', tag.text, v => { el.main.textContent = v })
    setTag(el, 'sub', tag.sub || '', v => { el.sub.textContent = v })
    el.style.transform = `translate(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px) translate(-50%,-100%) scale(${c.sc.toFixed(3)})`
    setTag(el, 'alpha', c.alpha.toFixed(2), v => { el.style.opacity = v })
  }
  for (; k < tagPool.length; k++) setTag(tagPool[k], 'show', false, () => { tagPool[k].style.display = 'none' })
}

const testsGreen = () => { const t = D.world.tests; return !!t && t.failed === 0 && t.greenAt !== undefined && Date.now() - t.greenAt < 180000 }
const throughputOf = () => {
  const s = D.world.system || {}
  const scale = (b, lo, hi) => (!b || b <= lo ? 0 : Math.min(1, Math.log10(b / lo) / Math.log10(hi / lo)))
  return { disk: scale((s.diskRead || 0) + (s.diskWrite || 0), 1e5, 5e7), down: scale(s.netDown, 1e4, 2e7), up: scale(s.netUp, 1e4, 1e7) }
}

const drawMachine = m => {
  const w = D.world, sys = w.system || {}, flow = throughputOf()
  const sea = seaY()
  // Ships: commits to pull ride at anchor offshore; network traffic sails in and out.
  if (harbor.end) {
    const heading = Math.atan2(harbor.dir[0], harbor.dir[2])
    if (w.git && w.git.hasRemote) {
      for (let k = 0; k < Math.min(4, w.git.behind); k++) {
        const t = 3.6 + k * .8, s = (k % 2 ? -1 : 1) * (.7 + k * .2)
        const x = harbor.end[0] + harbor.dir[0] * (t - 2.5) + harbor.side[0] * s, z = harbor.end[2] + harbor.dir[2] * (t - 2.5) + harbor.side[2] * s
        shipMesh(m, x, sea - .02 + Math.sin(now * 1.3 + k) * .03, z, heading + Math.PI + Math.sin(now * .4 + k) * .1, C('#9fc4e8'), .9)
        creaturePicks.push({ p: [x, sea + .5, z], label: 'A commit to pull, waiting offshore' })
        if (k === 0) tags.push({ p: [x, sea + .8, z], group: 'git', key: 'pull', text: `↓ ${w.git.behind} to pull`, rank: .5, live: true })
      }
      if (harbor.flagTop) {
        const f = harbor.flagTop, wave = Math.sin(now * 4) * .04
        m.sheet(f, [f[0] + harbor.side[0] * .55, f[1] - .06 + wave, f[2] + harbor.side[2] * .55], [f[0] + harbor.side[0] * .55, f[1] - .3 + wave, f[2] + harbor.side[2] * .55], [f[0], f[1] - .3, f[2]], C('#d97757'))
        tags.push({ p: [f[0], f[1] + .25, f[2]], group: 'git', key: 'branch', text: `⎇ ${w.git.branch || '?'}${w.git.ahead ? ` ↑${w.git.ahead}` : ''}${w.git.behind ? ` ↓${w.git.behind}` : ''}${w.git.dirty.length ? ` · ${w.git.dirty.length} uncommitted` : ''}`, rank: .65, live: true })
      }
    }
    for (const [rate, inbound] of [[flow.down, true], [flow.up, false]]) {
      const count = Math.ceil(rate * 4), period = 14 - rate * 9
      for (let k = 0; k < count; k++) {
        const u = ((now / period) + k / count) % 1
        const t = inbound ? 1 - u : u
        const x = mix(harbor.end[0], harbor.far[0], t) + harbor.side[0] * (inbound ? .5 : -.5)
        const z = mix(harbor.end[2], harbor.far[2], t) + harbor.side[2] * (inbound ? .5 : -.5)
        shipMesh(m, x, sea - .02 + Math.sin(now * 2 + k) * .02, z, heading + (inbound ? Math.PI : 0), inbound ? C('#ffe9b0') : C('#c9f0d6'), .75, C('#4a3a2c'))
        creaturePicks.push({ p: [x, sea + .45, z], label: inbound ? 'Downloads sailing in' : 'Uploads sailing out' })
        if (k === 0) tags.push({ p: [x, sea + .75, z], group: 'machine', key: inbound ? 'down' : 'up', text: inbound ? `↓ ${fmtRate(sys.netDown || 0)} in` : `↑ ${fmtRate(sys.netUp || 0)} out`, rank: .25, live: true })
        if (Math.random() < .08) spawn({ p: [x, sea + .02, z], v: [rnd(-.1, .1), .05, rnd(-.1, .1)], life: .8, size: .12, c: [.95, .98, 1], a: .5 })
      }
    }
  }
  // Lighthouses sweep their beams: dev servers listening.
  for (const b of beams) {
    const a = now * 1.2 + b.seed
    const tip = [b.lamp[0] + Math.cos(a) * 3.2, b.lamp[1] - .3, b.lamp[2] + Math.sin(a) * 3.2]
    rod(m, b.lamp, tip, .05, C('#fff3c4'), 3)
    glows.push([b.lamp[0], b.lamp[1], b.lamp[2], 1.6, 1, .9, .6, .9])
  }
  // The GPU's heat: forges glow with its load, and haze rises from them when it runs hot.
  const gpu = sys.gpu
  for (const f of forges) {
    const load = gpu ? gpu.load : .3
    glows.push([f.door[0], f.door[1], f.door[2], .8 + load * 1.6, 1, .5, .15, .5 + load * .5])
    if (gpu && gpu.temp > 60 && Math.random() < .02) spawn({ p: [f.chimney[0] + rnd(-.1, .1), f.chimney[1], f.chimney[2] + rnd(-.1, .1)], v: [rnd(-.05, .05), .5, rnd(-.05, .05)], life: 1.6, size: .5, grow: .4, c: [1, .85, .7], a: .12 })
  }
  // One-shot bursts: fireworks for a commit, light when you come back.
  const crown = beastCrown || [0, seaY() + 2, 0]
  for (const ev of w.events || []) {
    const age = (Date.now() - ev.at) / 1000
    if (ev.at <= 0 || age < 0 || age > 6 || burst.has(ev.id)) continue
    if (ev.tool === 'git-commit') {
      burst.add(ev.id)
      shootingStar()
      for (let k = 0; k < 4; k++) play('firework', { at: harbor.end || crown, gain: .55, delay: k * .35 })
      const base = harbor.end || crown || [0, 2, 0]
      for (let b = 0; b < 4; b++) {
        const c = [[1, .4, .4], [1, .85, .3], [.4, .8, 1], [.75, .55, 1]][b]
        const center = [base[0] + rnd(-1.5, 1.5), base[1] + 3 + rnd(0, 2), base[2] + rnd(-1.5, 1.5)]
        for (let k = 0; k < 60; k++) {
          const a = rnd(0, TAU), e = rnd(-1, 1), sp = rnd(1.5, 2.5)
          spawn({ p: [...center], v: [Math.cos(a) * Math.sqrt(1 - e * e) * sp, e * sp, Math.sin(a) * Math.sqrt(1 - e * e) * sp], life: rnd(1, 1.8), size: .12, c, a: 1, add: true, buoy: -1.2, drag: 1.2 })
        }
      }
    } else if (ev.tool === 'presence-return' && crown) {
      burst.add(ev.id)
      sparkleBurst(crown, [1, .9, .6])
      for (let k = 0; k < 3; k++) sparkleBurst([crown[0], crown[1] + k, crown[2]], [1, .85, .5])
    }
  }
}

// Giants: programs over 2% of the CPU (hooks/world.ts procsOf), each drawn as
// what it is (ARCHETYPES, by its name): Claude violet with the creature's lime
// eyes, a browser with a glowing screen on its chest, an editor with a quill
// and a scroll, a runtime carrying a block in its language's color, a build
// tool with a hammer, a shell with a lantern, the system in grey stone with a
// shield, media with a lute. As tall as its load, as round as the memory its
// processes hold, bearded (and at last mossy) with the hours it has run,
// trailed by a small companion for each other process under its name.
// It climbs out of the ground when it gets busy and sits and sinks back when
// it stops; just over the line it sits and rests (and snores), at work it
// strides, very busy it stomps, and above a quarter of the CPU it steams; it
// leans into a climbing load and yawns as its load falls; it strains its face
// as it works. It goes where it belongs: a program listening on a port to its
// lighthouse, Claude after the creature, a build tool to the forge, an editor
// beside the file being edited, a program to the bigger one of its family
// (they nod as they meet); the rest wander. It walks round the town's
// buildings, its steps thudding and pressing the grass. When you come back
// to the keyboard, every giant turns and waves.
const ARCHETYPES = [
  ['claude', /^claude/i],
  ['browser', /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|iexplore|safari)$/i],
  ['editor', /^(code|code - insiders|cursor|windsurf|devenv|idea64|idea|pycharm64|webstorm64|rider64|clion64|goland64|sublime_text|notepad\+\+|zed|nvim|vim|emacs)$/i],
  ['build', /^(cargo|rustc|msbuild|cl|link|gcc|g\+\+|clang|clang\+\+|make|cmake|ninja|gradle|mvn|javac|tsc|esbuild|webpack|vite|rollup|swc)$/i],
  ['runtime', /^(node|bun|deno|python\d*|pythonw|py|java|javaw|dotnet|ruby|php|go|perl|lua|julia|r|rscript)$/i],
  ['shell', /^(powershell|pwsh|cmd|bash|sh|zsh|fish|windowsterminal|wt|conhost|openconsole|wezterm|wezterm-gui|alacritty|git|mintty)$/i],
  ['system', /^(system|registry|smss|csrss|wininit|services|lsass|svchost|msmpeng|nissrv|mssense|dwm|explorer|searchindexer|searchhost|searchapp|runtimebroker|wmiprvse|audiodg|taskmgr|sihost|ctfmon|spoolsv|memory compression|fontdrvhost|winlogon|startmenuexperiencehost|shellexperiencehost|textinputhost|securityhealthservice|kernel_task|launchd|windowserver|systemd|kworker)$/i],
  ['media', /^(spotify|steam|steamwebhelper|vlc|discord|obs64|obs|music\.ui|itunes|foobar2000|slack|teams|ms-teams|zoom)$/i],
]
const archetypeOf = name => (ARCHETYPES.find(([, re]) => re.test(name)) || ['plain'])[0]
const KIND_WORDS = { claude: 'Claude', browser: 'a browser', editor: 'an editor', build: 'a build tool', runtime: 'a runtime', shell: 'a shell', system: 'the system', media: 'a media', plain: 'a' }
// A runtime's block, in its language's color (GitHub's).
const LANG_BLOCK = { node: '#f1e05a', bun: '#f1e05a', deno: '#f1e05a', python: '#3572A5', pythonw: '#3572A5', py: '#3572A5', java: '#b07219', javaw: '#b07219', dotnet: '#512bd4', ruby: '#701516', php: '#4F5D95', go: '#00ADD8', perl: '#0298c3', lua: '#000080', julia: '#a270ba', r: '#198CE7', rscript: '#198CE7' }
const FAMILIES = [
  [/^(node|npm|npx|pnpm|yarn|bun|deno|tsc|esbuild|vite|webpack|rollup|swc)$/i, 'js'], [/^(python\d*|pythonw|py|pip\d*|uv|conda)$/i, 'py'],
  [/^(cargo|rustc|rust-analyzer)$/i, 'rust'], [/^(dotnet|msbuild|devenv|vbcscompiler)$/i, 'dotnet'], [/^(java|javaw|javac|gradle|mvn|idea64)$/i, 'jvm'],
  [/^(chrome|msedge|firefox|brave)$/i, 'web'], [/^claude/i, 'claude'], [/^(code|code - insiders)$/i, 'code'],
]
const familyOfProc = name => (FAMILIES.find(([re]) => re.test(name)) || [null, name])[1]
const fmtMem = mb => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`)
const GIANT_STONE = C('#8f877b'), BEARD_YOUNG = C('#6b4a2f'), BEARD_OLD = C('#e8e6e0'), GIANT_MOSS = C('#5d7a3a')
const giants = new Map()
let giantsSeen = false, giantWave
// Giants keep off the town: no cell with a building, a tree or a lighthouse (they step over a nest).
const giantAvoid = (i, j) => {
  const s = solids.get(`${i},${j}`)
  return (!!s && s.y1 - s.y0 > .45) || (D.island.lighthouses || []).some(l => l.i === i && l.j === j)
}
// Where a giant belongs, and how far it may wander from there.
const giantPlace = (g, p) => {
  const w = D.world, name = p.name.toLowerCase()
  if (g.kind === 'claude' && beast.c) { const a = beast.heading + Math.PI; return { at: [beast.x + Math.sin(a) * 2.4, beast.z + Math.cos(a) * 2.4], r: 1.2, why: 'following the creature' } }
  const light = (D.island.lighthouses || []).find(l => String(l.name || '').toLowerCase() === name)
  if (light) return { at: [light.i + .5, light.j + .5], r: 1.6, why: `standing by its lighthouse (:${light.port})` }
  const newest = kind => w.features.filter(f => f.kind === kind && f.touchedAt).sort((a, b) => b.touchedAt - a.touchedAt)[0]
  if (g.kind === 'build') { const f = newest('forge'); if (f) return { at: [f.x + .5, f.y + .5], r: 1.7, why: 'at the forge' } }
  if (g.kind === 'editor') { const f = newest('house'); if (f) return { at: [f.x + .5, f.y + .5], r: 1.9, why: `beside ${nameOf(f.key)}, the file being edited` } }
  const lead = [...giants.values()].filter(o => o !== g && o.fam === g.fam && o.goneAt === undefined && (o.p.cpu > p.cpu || (o.p.cpu === p.cpu && o.name < g.name))).sort((a, b) => b.p.cpu - a.p.cpu)[0]
  if (lead) return { at: [lead.x + .9, lead.z + .9], r: 1, why: `walking with ${lead.name}`, lead }
  return { at: g.wild, r: 4, why: '' }
}
const drawGiants = (m, dt, isAway) => {
  const procs = ((D.world.system && D.world.system.procs) || []).slice(0, 5)
  const names = new Set(procs.map(p => p.name))
  for (const g of giants.values()) if (!names.has(g.name) && g.goneAt === undefined) g.goneAt = now
  for (const p of procs) {
    let g = giants.get(p.name)
    if (!g) {
      const land = []
      for (let i = -I.G; i < I.G; i++) for (let j = -I.G; j < I.G; j++) if (walkable(i, j) && !giantAvoid(i, j)) land.push([i + .5, j + .5])
      const wild = land[hashStr(p.name) % Math.max(1, land.length)] || [0, 0]
      g = new Walker('giant', wild, 4, { speed: .35, hue: hashStr(p.name) % 360, avoid: giantAvoid })
      Object.assign(g, { name: p.name, wild, kind: archetypeOf(p.name), fam: familyOfProc(p.name), bornAt: giantsSeen ? now : -99, sit: 0, trail: [], sw: 0 })
      giants.set(p.name, g)
    }
    g.goneAt = undefined
    g.p = p
  }
  giantsSeen = true
  // You came back to the keyboard: every giant turns to you and waves.
  const back = D.world.returnedAt || 0
  if (giantWave === undefined) giantWave = back
  else if (back > giantWave) { giantWave = back; for (const g of giants.values()) g.waveAt = now }
  for (const [name, g] of giants) {
    drawGiant(m, dt, g, isAway)
    if (g.goneAt !== undefined && now - g.goneAt > 3.6) giants.delete(name)
  }
}
const drawGiant = (m, dt, g, isAway) => {
  const p = g.p, cpu = p.cpu, trend = p.trend || 0, gone = g.goneAt !== undefined
  const place = giantPlace(g, p)
  g.place = place
  // Where it is going: a new place far from the old sends it straight there.
  if (Math.hypot(place.at[0] - g.home[0], place.at[1] - g.home[1]) > place.r) { g.target = null; g.idle = Math.min(g.idle, .3) }
  g.home = place.at; g.radius = place.r
  g.target_scale = .9 + Math.sqrt(cpu) * 3.2
  g.scale = mix(g.scale || g.target_scale, g.target_scale, Math.min(1, dt * 2))
  const k = g.scale
  // Rest just over the line (or while you are away), stride at work, stomp when very busy.
  const resting = cpu < .05 || isAway || gone
  g.sit = mix(g.sit, resting ? 1 : 0, Math.min(1, dt * 1.5))
  g.speed = (.2 + Math.min(.7, cpu * 2)) * (1 + clamp(trend * 5, -.4, .6)) * Math.sqrt(k)
  const waving = g.waveAt !== undefined && now - g.waveAt < 3
  if (g.sit < .3 && !waving) g.update(dt)
  else { g.moving = false; g.settle(dt) }
  if (waving && camEye) g.heading = lerpAngle(g.heading, Math.atan2(camEye[0] - g.x, camEye[2] - g.z), Math.min(1, dt * 4))
  // Climbing out of the ground as it arrives; sinking back once it has sat down to go.
  const up = (g.bornAt < 0 ? 1 : sstep(0, 2.2, now - g.bornAt)) * (gone ? 1 - sstep(1, 3.5, now - g.goneAt) : 1)
  if (g.bornAt >= 0 && !g.risen) {
    g.risen = true
    play('thud', { at: [g.x, g.y, g.z], gain: .45, rate: .55 })
    for (let q = 0; q < 26; q++) { const a = rnd(0, TAU); spawn({ p: [g.x + Math.cos(a) * .3, g.y + .05, g.z + Math.sin(a) * .3], v: [Math.cos(a) * rnd(.4, .9), rnd(.2, .6), Math.sin(a) * rnd(.4, .9)], life: rnd(.8, 1.4), size: .25, grow: 1, c: [.55, .48, .38], a: .3, drag: 1.5 }) }
  }
  if (up < .02) return
  // Its trail, for its companions to follow.
  const last = g.trail[0]
  if (!last || Math.hypot(last[0] - g.x, last[1] - g.z) > .15) { g.trail.unshift([g.x, g.z]); g.trail.length = Math.min(g.trail.length, 40) }

  // Its build: memory makes it round, the hours it has run give it a beard (and moss).
  const gir = clamp(.8 + .25 * Math.log2(1 + (p.mem || 250) / 250), .8, 1.7)
  const hours = p.since ? Math.max(0, (Date.now() - p.since) / 3.6e6) : 0
  const strain = clamp((cpu - .04) / .3, 0, 1), stomp = cpu > .25
  const sit = g.sit, lean = clamp(trend * 4, -.2, .3) * (1 - sit)
  const yawning = g.yawnAt !== undefined && now - g.yawnAt < 2.6
  if (trend <= -.02 && cpu < .12 && !gone && now - (g.yawnAt ?? -99) > 30) { g.yawnAt = now; play('sigh', { at: [g.x, g.y + k, g.z], gain: .12, rate: .7 }) }
  const nodding = g.nodAt !== undefined && now - g.nodAt < 1
  if (place.lead && Math.hypot(place.lead.x - g.x, place.lead.z - g.z) < 2.5 && now - (g.nodAt ?? -99) > 18) { g.nodAt = now; place.lead.nodAt = now }

  const skin = g.kind === 'claude' ? hsl(282, .38, .42) : g.kind === 'system' ? GIANT_STONE : hsl(g.hue, .35, .55)
  const dark = cmul(skin, .72)
  const baseY = g.y - (1 - up) * k * 1.15 - sit * .26 * k
  const { W } = body(m, g.x, baseY, g.z, g.heading)
  const ch = Math.cos(g.heading), sh = Math.sin(g.heading)
  const X = [ch, 0, -sh], Y = [0, 1, 0], Z = [sh, 0, ch]
  const L = (ox, oy, oz) => W(ox * k, oy * k, oz * k)
  const ell = (o, r, col, e = 0, ax = X, ay = Y, az = Z) => m.ellipsoid(L(...o), scl(ax, r[0] * k), scl(ay, r[1] * k), scl(az, r[2] * k), col, e)
  const limb = (pts, r, col) => m.tube(pts.map(q => L(...q)), pts.map((_, q) => r * k * (1 - q * .12)), col, 0, 6)

  // Legs: striding, or folded in front as it sits; each footfall thuds and presses the grass.
  const swing = g.moving ? Math.sin(g.phase * .5) * .5 : 0
  const legR = .05 * (1 + (gir - 1) * .4)
  for (const sgn of [-1, 1]) {
    const hip = [sgn * .085 * gir, .46, 0]
    let knee, foot
    if (sit > .5) { knee = [sgn * .1 * gir, .46, .2]; foot = [sgn * .11 * gir, .27, .3] }
    else { const a = swing * sgn; knee = [sgn * .09 * gir, .46 - .23 * Math.cos(a), .23 * Math.sin(a) + .03]; foot = [sgn * .09 * gir, .46 - .46 * Math.cos(a), .46 * Math.sin(a)] }
    limb([hip, knee, foot], legR, dark)
    ell([foot[0], foot[1] + .02, foot[2] + .03], [.055, .028, .085], cmul(skin, .6))
  }
  const sw = Math.sign(swing)
  if (g.moving && sw !== 0 && sw !== g.sw) {
    const fx = g.x + Math.sin(g.heading) * .1 * k, fz = g.z + Math.cos(g.heading) * .1 * k
    footprints.push({ x: fx, z: fz, at: now, r: .15 + k * .06 })
    if (footprints.length > 12) footprints.shift()
    play('thud', { at: [fx, g.y, fz], gain: stomp ? .28 : .07 + .03 * k, rate: 1.25 - .12 * k, gap: .12 })
    if (stomp) {
      shake = Math.max(shake, .012 * k)
      for (let q = 0; q < 8; q++) spawn({ p: [fx + rnd(-.1, .1), g.y + .03, fz + rnd(-.1, .1)], v: [rnd(-.5, .5), rnd(.1, .4), rnd(-.5, .5)], life: rnd(.5, .9), size: .18, grow: .8, c: [.55, .48, .38], a: .25, drag: 2 })
    }
  }
  if (g.moving) g.sw = sw

  // Body: a round torso (a belly when it holds a lot), leaning into a climbing load.
  const tz = lean * .12
  ell([0, .62, tz * .5], [.17 * gir, .2, .13 * gir], skin)
  if (gir > 1.15) ell([0, .55, .05 * gir + tz * .4], [.15 * gir, .14, .12 * gir], cmul(skin, 1.04))
  // Arms: swinging opposite the legs; resting on its knees as it sits; up to wave, or stretched up in a yawn.
  const hands = []
  for (const sgn of [-1, 1]) {
    const sho = [sgn * (.17 * gir + .03), .78, tz]
    let elb, hand
    if (yawning) { elb = [sgn * (.2 * gir + .04), .95, tz]; hand = [sgn * (.18 * gir + .05), 1.12, tz + .02] }
    else if (waving && sgn > 0) { const wv = Math.sin(now * 9) * .06; elb = [.26 * gir, .9, tz + .04]; hand = [.27 * gir + wv, 1.06, tz + .05] }
    else if (sit > .5) { elb = [sgn * (.19 * gir + .02), .62, .1]; hand = [sgn * .1 * gir, .48, .22] }
    else { const b = -swing * sgn * .8; elb = [sgn * (.18 * gir + .04), .78 - .17 * Math.cos(b), .17 * Math.sin(b) + tz]; hand = [sgn * (.19 * gir + .04), .78 - .34 * Math.cos(b), .34 * Math.sin(b) + tz + .04] }
    limb([sho, elb, hand], .042 * (1 + (gir - 1) * .3), cmul(skin, .9))
    ell(hand, [.04, .04, .04], cmul(skin, .85))
    hands.push(hand)
  }
  const [lHand, rHand] = hands

  // Head and face: calm while idle, straining as it works; a yawn opens it wide; it nods to its kin.
  const nod = nodding ? Math.sin((now - g.nodAt) * Math.PI * 2) * .035 : 0
  const hy = .93 + nod * .3, hz = tz * 1.4 + nod
  ell([0, hy, hz], [.12, .13, .12], cmul(skin, 1.08))
  const eyeCol = g.kind === 'claude' ? EYES.opus[0] : C('#f4f1ea')
  for (const sgn of [-1, 1]) {
    ell([sgn * .045, hy + .02, hz + .1], [.025, g.sit > .9 ? .006 : .025, .015], eyeCol, g.kind === 'claude' ? 2 : 0)
    if (g.sit <= .9) ell([sgn * .045, hy + .02, hz + .115], [.011, .013, .006], C('#141018'))
    // Brows: level when calm, drawn down at the middle under load.
    const t = sgn * strain * .45, bx = add(scl(X, Math.cos(t)), scl(Y, Math.sin(t))), by = add(scl(X, -Math.sin(t)), scl(Y, Math.cos(t)))
    ell([sgn * .048, hy + .06, hz + .105], [.032, .008, .01], cmul(skin, .5), 0, bx, by, Z)
  }
  if (g.kind === 'claude') for (const sgn of [-1, 1]) glows.push([...L(sgn * .045, hy + .02, hz + .11), .12 * k, .7, 1, .25, .35])
  if (yawning) ell([0, hy - .06, hz + .1], [.035, .045, .02], C('#2a1416'))
  else if (stomp) { ell([0, hy - .055, hz + .1], [.045, .014, .015], C('#2a1416')); ell([0, hy - .055, hz + .108], [.04, .008, .01], C('#efe9dc')) }
  else ell([0, hy - .055, hz + .1], [.03 + .015 * strain, .006 + .008 * strain, .012], C('#2a1416'))
  // A beard as long as it has run (greying over two days), moss on its shoulders after a couple of hours.
  if (hours > .4) {
    const b = clamp(hours / 8, 0, 1)
    ell([0, hy - .08 - .05 * b, hz + .06], [.08, .04 + .09 * b, .06], cmix(BEARD_YOUNG, BEARD_OLD, clamp(hours / 48, 0, 1)))
  }
  if (hours > 2) for (let q = 0; q < Math.min(6, Math.floor(hours / 2)); q++) {
    // On top of its shoulders: on the torso's own curve.
    const sgn = q % 2 ? 1 : -1, u = rand2(q, 3, hashStr(g.name) % 997), dx = (.05 + u * .08) * gir
    ell([sgn * dx, .61 + .2 * Math.sqrt(Math.max(0, 1 - (dx / (.17 * gir)) ** 2)), tz * .5 + (u - .5) * .06], [.032, .022, .032], cmix(GIANT_MOSS, C('#7f9a4a'), u))
  }
  // Under heavy load, faint steam rises off it.
  if (cpu > .25 && Math.random() < dt * 3) spawn({ p: L(rnd(-.06, .06), 1.05, hz), v: [rnd(-.05, .05), .4, rnd(-.05, .05)], life: 1.6, size: .3 * Math.sqrt(k), grow: .5, c: [.95, .95, .95], a: .1, drag: .3 })
  // Asleep on its hill: a slow snore now and then.
  if (sit > .9 && !gone && now - (g.snoreAt ?? -99) > 7.5) { g.snoreAt = now; play('sigh', { at: L(0, hy, hz), gain: .06, rate: .55 }); spawn({ p: L(.08, hy + .1, hz), v: [.1, .3, 0], life: 2, size: .14, c: [.8, .86, 1], a: .6, add: true }) }

  // What it carries, by what it is.
  const toW = h => L(...h)
  switch (g.kind) {
    case 'claude':
      for (let q = 0; q < 3; q++) { const a = (q - 1) * .5; limb([[0, hy + .11, hz], [Math.sin(a) * .05, hy + .18, hz - .02], [Math.sin(a) * .09 + Math.sin(now * 2 + q) * .02, hy + .22, hz - .05]], .014, cmul(skin, .8)) }
      break
    case 'browser': {
      ell([0, .64, tz * .5 + .13 * gir], [.09, .06, .008], C('#9fd8ff'), 1.4)
      for (let q = 0; q < 3; q++) ell([(q - 1) * .055, .715, tz * .5 + .125 * gir], [.022, .012, .006], q === 1 ? C('#ffffff') : C('#6fa8d6'), .8)
      glows.push([...L(0, .64, tz * .5 + .16 * gir), .3 * k, .6, .85, 1, .25])
      break
    }
    case 'editor': {
      const q = rHand
      limb([q, [q[0] + .02, q[1] + .1, q[2] + .03], [q[0] + .05, q[1] + .2, q[2] + .02]], .01, C('#f4f1ea'))
      ell([q[0] + .045, q[1] + .17, q[2] + .02], [.012, .06, .03], C('#ffffff'))
      const s = lHand
      m.put(UNIT.cyl8, { x: toW(s)[0], y: toW(s)[1] - .06 * k, z: toW(s)[2], sx: .05 * k, sy: .12 * k, sz: .05 * k, ry: g.heading }, C('#efe2c0'))
      break
    }
    case 'runtime': {
      const s = [-.17 * gir - .03, .86, tz]
      m.put(UNIT.cube, { x: L(...s)[0], y: L(...s)[1], z: L(...s)[2], sx: .1 * k, sy: .1 * k, sz: .1 * k, ry: g.heading + .3 }, C(LANG_BLOCK[g.name.toLowerCase().replace(/\d+$/, '')] || '#c9b48a'))
      break
    }
    case 'build': {
      const q = rHand, head = [q[0], q[1] + .14, q[2] + .02]
      limb([q, head], .012, C('#6b4a2f'))
      ell(head, [.05, .03, .03], cmix(C('#55504a'), C('#ff8a3a'), clamp(cpu * 3, 0, 1)), cpu > .1 ? 1 : 0)
      if (cpu > .1) glows.push([...L(...head), .25 * k, 1, .55, .2, .3])
      break
    }
    case 'shell': {
      const q = lHand, lamp = [q[0], q[1] - .06, q[2]]
      limb([q, lamp], .006, C('#3a3330'))
      ell(lamp, [.03, .04, .03], C('#ffcf7a'), 2)
      glows.push([...L(...lamp), .35 * k, 1, .7, .35, .4])
      break
    }
    case 'system': {
      const q = lHand
      ell([q[0] - .02, q[1] + .04, q[2] + .03], [.012, .1, .09], cmul(GIANT_STONE, .8), 0, X, Y, Z)
      ell([q[0] - .03, q[1] + .04, q[2] + .03], [.008, .03, .03], C('#c9a45c'))
      break
    }
    case 'media': {
      ell([.02, .62, tz * .5 + .14 * gir], [.08, .06, .03], C('#9a6a3a'))
      limb([[.06, .64, tz * .5 + .15 * gir], [.2, .78, tz * .5 + .15 * gir]], .012, C('#5b3d27'))
      break
    }
  }

  // Its companions: one for each other process under its name (five at most), trailing it, or gathered round as it sits.
  const many = Math.min(5, Math.max(0, (p.count || 1) - 1))
  for (let q = 0; q < many; q++) {
    let cx, cz
    if (sit > .5) { const a = g.heading + Math.PI * .6 + q * 1.1; cx = g.x + Math.sin(a) * .55 * Math.sqrt(k); cz = g.z + Math.cos(a) * .55 * Math.sqrt(k) }
    else { const at = g.trail[Math.min(g.trail.length - 1, (q + 1) * 4)] || [g.x, g.z]; cx = at[0]; cz = at[1] }
    const cy = groundY(cx, cz) + (g.moving ? Math.abs(Math.sin(now * 7 + q)) * .06 : 0) - (1 - up) * .4
    const look = Math.atan2(g.x - cx, g.z - cz)
    const B = body(m, cx, cy, cz, look)
    m.ellipsoid(B.W(0, .08, 0), [.06, 0, 0], [0, .07, 0], [0, 0, .06], cmix(skin, [1, 1, 1], .2))
    m.ellipsoid(B.W(0, .17, 0), [.045, 0, 0], [0, .045, 0], [0, 0, .045], cmix(skin, [1, 1, 1], .3))
    for (const sgn of [-1, 1]) m.ellipsoid(B.W(sgn * .018, .18, .04), [.01, 0, 0], [0, .01, 0], [0, 0, .006], C('#141018'))
  }

  const ago = hours > 0 ? `, running ${fmtTime(hours * 3600)}` : ''
  const way = trend > .01 ? ' · its load is climbing' : trend < -.01 ? ' · its load is falling' : ''
  creaturePicks.push({ p: L(0, 1.1, 0), label: `${p.name}: ${KIND_WORDS[g.kind]} giant at ${Math.round(cpu * 100)}% of the CPU${p.mem ? `, holding ${fmtMem(p.mem)}` : ''}${(p.count || 1) > 1 ? ` across ${p.count} processes` : ''}${ago}${way}${place.why ? ` · ${place.why}` : ''}${gone ? ' · gone quiet, sinking back' : ''}` })
  if (!gone) tags.push({ p: L(0, 1.25, 0), group: 'machine', key: `giant:${p.name}`, text: `${p.name}${(p.count || 1) > 1 ? ` ×${p.count}` : ''} · ${Math.round(cpu * 100)}% CPU${p.mem ? ` · ${fmtMem(p.mem)}` : ''}`, rank: .35 + Math.min(.3, cpu), live: true })
}

// ------------------------------------------------------------------ the turtle
// The turtle carries the conversation through space. It swims as fast as
// Claude eats tokens: hard strokes while Claude thinks or writes (it holds
// its breath), slow beats while tools run; when the turn ends it breathes
// out a cloud of stardust and glides, flippers spread, and after a minute
// folds them back. While you are away its head is drawn into its shell;
// when Claude waits on you it tilts its head and watches you, blinking
// slowly. Each new prompt, it lifts its head, opens its beak and calls.
// Its front flippers sweep in a figure of eight, bending as they go, dust
// curling off their tips. Space dust streams past as fast as it swims.

const turtle = { ph: 0, freq: 0, amp: 0, fold: 1, out: 1, yaw: 0, pitch: 0, roll: 0, speed: .4, call: 0, turn: null, doneAt: null, blink: 0, nextBlink: 4, lid: 0, spray: 0, head: null, eye: null, state: '' }
const HIDE_DARK = C('#34341e'), HORN = C('#3a3020'), HORN_EDGE = C('#6b5a36')

// A skin over rings of points (each ring closed round), smooth, each corner's
// normal from its neighbours. `lps` says where on the body each corner is,
// in the part's own frame: the shader draws the scales from it (material
// hide), so they stay put as it moves.
const skinOver = (m, rings, lps) => {
  const R = rings.length, N = rings[0].length
  const ns = rings.map((ring, i) => ring.map((_, j) => {
    const n = cross(sub(ring[(j + 1) % N], ring[(j + N - 1) % N]), sub(rings[Math.min(i + 1, R - 1)][j], rings[Math.max(i - 1, 0)][j]))
    return Math.hypot(...n) < 1e-9 ? norm(sub(rings[Math.min(i + 1, R - 1)][j], rings[Math.max(i - 1, 0)][j])) : norm(n)
  }))
  const was = m.mat
  m.mat = MAT.hide
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < N; j++) {
    const j2 = (j + 1) % N
    m.triN(rings[i][j], rings[i + 1][j2], rings[i + 1][j], ns[i][j], ns[i + 1][j2], ns[i + 1][j], lps[i][j], 0, [lps[i][j], lps[i + 1][j2], lps[i + 1][j]])
    m.triN(rings[i][j], rings[i][j2], rings[i + 1][j2], ns[i][j], ns[i][j2], ns[i + 1][j2], lps[i][j], 0, [lps[i][j], lps[i][j2], lps[i + 1][j2]])
  }
  m.mat = was
}
// A ring round c, across U (half-width w) and V (half-height h); `lower` squashes or swells its lower half.
const ringOf = (c, U, V, w, h, n, lower = 1, shift = 0) => Array.from({ length: n }, (_, j) => {
  const a = j / n * TAU, s = Math.sin(a)
  return add(c, add(scl(U, Math.cos(a) * w + shift), scl(V, s * h * (s < 0 ? lower : 1))))
})
// Where each corner of that ring is on the part, for its scales: along it, across, up.
const ringLp = (n, along, w, h, k, off) => Array.from({ length: n }, (_, j) => { const a = j / n * TAU; return [along * k + off, Math.cos(a) * w * k + off * .37, Math.sin(a) * h * k] })
// The two axes across a direction T: U level (or as `ref` lies), V = T × U.
const across = (T, ref = [0, 1, 0]) => { const U = norm(cross(ref, T)); return [U, cross(T, U)] }

// One flipper, a bending paddle on a spine of joints out from the shoulder:
// `sweep` fore and aft and `lift` up and down at its root, each joint bent
// further back and lagging the stroke (`flex`), feathered by `twist`.
// Rounded and thick at the leading edge, thin at the trailing one; a claw on
// the leading edge. Returns its tip.
const flipper = (m, S, sh, side, len, chord, thick, sweep, lift, twist, flex, back, off) => {
  const N = 10, around = 12, k = 45 / S.Rs, up = [0, 1, 0]
  const rings = [], lps = []
  let p = sh, tip = sh, claw = null
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const sw = sweep - back * t * t, el = lift + flex * Math.sin(turtle.ph - t * 2.2) * t
    const hor = add(scl(S.r, side * Math.cos(sw)), scl(S.f, Math.sin(sw)))
    const T = norm(add(scl(hor, Math.cos(el)), scl(up, Math.sin(el))))
    let [U] = across(T)
    if (dot(U, S.f) < 0) U = scl(U, -1)  // across, toward its leading edge
    const tw = twist * (.4 + .6 * t)
    const V0 = cross(T, U), Uf = norm(add(scl(U, Math.cos(tw)), scl(V0, Math.sin(tw)))), Vf = cross(T, Uf)
    const w = chord(t), th = thick(t)
    // The leading half full and round, the trailing half drawn thin.
    rings.push(Array.from({ length: around }, (_, j) => {
      const a = j / around * TAU, c = Math.cos(a), s = Math.sin(a)
      return add(p, add(scl(Uf, c * w - w * .15), scl(Vf, s * th * (c > 0 ? 1 : .45 + .55 * (1 + c)))))
    }))
    lps.push(ringLp(around, t * len / S.Rs, w / S.Rs, th / S.Rs, k * S.Rs, off))
    if (i === 3) claw = { at: add(p, scl(Uf, w * .8)), dir: norm(add(Uf, scl(T, .6))) }
    tip = p
    if (i < N) p = add(p, scl(T, len / N))
  }
  skinOver(m, rings, lps)
  if (claw) m.tube([claw.at, add(claw.at, scl(claw.dir, S.Rs * .035))], [S.Rs * .009, S.Rs * .001], HORN, 0, 5)
  return tip
}

const drawTurtle = (m, dt, isAway) => {
  const S = shellOf(), w = D.world, b = w.beast, act = w.activity || {}, t = Date.now(), Rs = S.Rs
  const isDone = !b || b.doneAt !== undefined
  const waiting = !!w.waiting && !isDone
  const streaming = !isDone && (act.kind === 'writing' || act.kind === 'thinking')
  const since = b && b.doneAt !== undefined ? (t - b.doneAt) / 1000 : 1e9
  const gliding = isDone && since < 60
  // What it is doing, by the data: the stroke's rate and reach, how far its flippers fold.
  let freq = 0, amp = 0, fold = 0, speed = .3, state
  if (isAway) { fold = 1; speed = .15; state = 'asleep in its shell' }
  else if (waiting) { freq = .1; amp = .2; speed = .4; state = 'watching you' }
  else if (streaming) { freq = .2 + beast.vein * .5; amp = .55 + beast.vein * .45; speed = 1 + beast.vein * 8; state = 'swimming hard' }
  else if (!isDone) { freq = .13; amp = .35; speed = .8; state = 'paddling while tools run' }
  else if (gliding) { fold = .1; speed = .6; state = 'gliding' }
  else { fold = 1; speed = .3; state = 'drifting, flippers folded' }
  turtle.state = state
  const k = Math.min(1, dt * .8)
  turtle.freq = mix(turtle.freq, freq, k); turtle.amp = mix(turtle.amp, amp, k)
  turtle.fold = mix(turtle.fold, fold, Math.min(1, dt * .5))
  turtle.speed = mix(turtle.speed, speed * Rs / 14, Math.min(1, dt * .6))
  turtle.out = mix(turtle.out, isAway ? 0 : 1, Math.min(1, dt * .7))
  const before = turtle.ph
  turtle.ph += dt * turtle.freq * TAU
  const beat = Math.floor(turtle.ph / TAU) !== Math.floor(before / TAU) && turtle.amp > .25
  // A new prompt: it lifts its head and calls.
  if (b && turtle.turn !== b.turn) {
    if (turtle.turn !== null && t - b.bornAt < 6000) { turtle.call = 1; play('call', { gain: .55 }) }
    turtle.turn = b.turn
  }
  turtle.call = Math.max(0, turtle.call - dt * .35)
  const ph = turtle.ph, a = turtle.amp, f = turtle.fold

  // Flippers. The front pair beat in a figure of eight, bending and feathering;
  // the back pair steer; folded, both lie back along the shell.
  const tips = []
  for (const side of [1, -1]) {
    const shF = atShell(S, S.L * .52, side * S.W * .78, S.base + S.H * .1)
    tips.push(flipper(m, S, shF, side, Rs * .95,
      u => Rs * (.035 + .1 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), .8) * (1 - .62 * u)),
      u => Rs * (.034 * (1 - u) + .007),
      mix(.22 + .5 * a * Math.cos(ph) + .12 * a * Math.sin(2 * ph), -1.15, f), mix(.4 * a * Math.sin(ph) - .06, -.14, f),
      mix(.75 * a * Math.cos(ph), 0, f), mix(.35 * a, .05, f), mix(.55, .25, f), side * 11))
    const shB = atShell(S, -S.L * .62, side * S.W * .6, S.base + S.H * .05)
    flipper(m, S, shB, side, Rs * .5,
      u => Rs * (.04 + .1 * Math.pow(Math.sin(Math.PI * u), .7)),
      u => Rs * (.028 * (1 - u) + .008),
      mix(-.55 + .22 * a * Math.cos(ph + 1.4), -1.05, f), mix(.25 * a * Math.sin(ph + 1.4) - .08, -.1, f),
      mix(.4 * a * Math.cos(ph + 1.4), 0, f), mix(.15 * a, 0, f), .2, side * 23)
  }
  // Each down-beat sweeps a soft sound, and dust curls off the front tips.
  if (beat) play('stroke', { at: atShell(S, S.L * .5, S.W, S.base), gain: .1 + turtle.amp * .25, rate: 1.1 - turtle.amp * .3 })
  for (const tp of tips) {
    const n = beat ? 8 : Math.random() < dt * a * 5 ? 1 : 0
    for (let q = 0; q < n; q++) {
      const sw = scl(norm([rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)]), rnd(.2, .7))
      spawn({ p: [...tp], v: add(scl(S.f, -turtle.speed * rnd(.2, .45)), sw), life: rnd(1.2, 2.2), size: rnd(.12, .26), grow: .8, c: [.72, .82, 1], a: .32, add: true, drag: .8 })
    }
  }
  // The tail.
  {
    const tb = atShell(S, -S.L * .9, 0, S.base + S.H * .06)
    const T = norm(add(scl(S.f, -1), [0, -.12, 0])), rings = [], lps = []
    for (let i = 0; i <= 5; i++) {
      const u = i / 5, c = add(add(tb, scl(T, u * Rs * .17)), scl(S.r, Math.sin(ph - u * 2) * .02 * Rs * a * u))
      const [U, V] = across(T)
      const r = Rs * .05 * (1 - u * .9)
      rings.push(ringOf(c, U, V, r, r * .7, 10)); lps.push(ringLp(10, u * .17, r / Rs, r * .7 / Rs, 45, 31))
    }
    skinOver(m, rings, lps)
  }

  // The head: out on its folded neck, or drawn into the shell; looking where
  // it swims, raised as it calls, tilted to watch you when you are waited on.
  let wantYaw = .15 * Math.sin(now * .23), wantPitch = .05 * Math.sin(now * .31) + .04 * a * Math.sin(ph * 2) + turtle.call * .4, wantRoll = 0
  const neck0 = atShell(S, S.L * .84, 0, S.base + S.H * .2)
  if (waiting && camEye) {
    const d = sub(camEye, neck0), along = d[0] * S.f[0] + d[2] * S.f[2], sd = d[0] * S.r[0] + d[2] * S.r[2]
    wantYaw = clamp(Math.atan2(sd, along), -1.1, 1.1)
    wantPitch = Math.atan2(d[1], Math.hypot(along, sd))
    wantRoll = .24 + .06 * Math.sin(now * .5)
  }
  wantPitch = clamp(wantPitch, -.3, .45)
  turtle.yaw = mix(turtle.yaw, wantYaw, Math.min(1, dt * 1.5)); turtle.pitch = mix(turtle.pitch, wantPitch, Math.min(1, dt * 1.5)); turtle.roll = mix(turtle.roll, wantRoll, Math.min(1, dt * 1.2))
  const hor = add(scl(S.f, Math.cos(turtle.yaw)), scl(S.r, Math.sin(turtle.yaw)))
  const look = norm(add(scl(hor, Math.cos(turtle.pitch)), [0, Math.sin(turtle.pitch), 0]))
  const [U0, V0] = across(look)
  const side = norm(add(scl(U0, Math.cos(turtle.roll)), scl(V0, Math.sin(turtle.roll)))), hup = cross(look, side)
  // Breath: a slow swell of the throat while it rests; held while it swims hard; let out as stardust when the turn ends.
  const breath = streaming ? 0 : .5 + .5 * Math.sin(now * .9)
  // The neck: folds of skin, bunched when it draws its head in.
  const HL = Rs * .32, out = turtle.out
  // Drawn in, the head slides back under the shell's front edge.
  const neckEnd = add(neck0, add(scl(look, Rs * .32 * out), scl(S.f, -(1 - out) * HL * .9)))
  {
    const rings = [], lps = [], NR = 9
    const cs = Array.from({ length: NR + 1 }, (_, i) => {
      const u = i / NR
      return add(add(neck0, scl(S.f, -Rs * .08 * (1 - u))), add(scl(sub(neckEnd, neck0), u * u * (3 - 2 * u)), [0, Rs * .05 * Math.sin(u * Math.PI) * out, 0]))
    })
    for (let i = 0; i <= NR; i++) {
      const u = i / NR, c = cs[i]
      const T = i === NR ? look : norm(sub(cs[i + 1], cs[Math.max(0, i - 1)]))
      const [U, V] = across(T, hup)
      const fold = 1 + .07 * Math.sin(u * 28) * (1.3 - out)
      const r = Rs * (.12 - .025 * u) * fold
      rings.push(ringOf(c, U, V, r, r * .9, 14, 1 + .14 * breath * u)); lps.push(ringLp(14, u * .3, r / Rs, r * .9 / Rs, 40, 47))
    }
    skinOver(m, rings, lps)
  }
  // The skull and snout down to the hooked beak, the jaw beneath it (open as it calls).
  const open = turtle.call > 0 ? .38 * sstep(1, .88, turtle.call) * sstep(0, .3, turtle.call) : 0
  const PROFILE = [[0, .1, .086, 0], [.2, .118, .1, .01], [.45, .11, .09, .012], [.65, .085, .072, .004], [.8, .062, .056, -.006]]
  const BEAK = [[.8, .062, .056, -.006], [.9, .045, .045, -.014], [.96, .026, .032, -.026], [1, .004, .006, -.04]]
  const loft = (keys, n, around, lower, lpOff) => {
    const rings = [], lps = []
    for (let i = 0; i <= n; i++) {
      const u = keys[0][0] + (keys[keys.length - 1][0] - keys[0][0]) * i / n
      let q = 0
      while (q < keys.length - 2 && keys[q + 1][0] < u) q++
      const [u0, w0, h0, c0] = keys[q], [u1, w1, h1, c1] = keys[q + 1], s = sstep(u0, u1, u)
      const c = add(add(neckEnd, scl(look, u * HL)), scl(hup, mix(c0, c1, s) * Rs))
      rings.push(ringOf(c, side, hup, mix(w0, w1, s) * Rs, mix(h0, h1, s) * Rs, around, lower))
      lps.push(ringLp(around, u * HL / Rs, mix(w0, w1, s), mix(h0, h1, s), 30, lpOff))
    }
    return { rings, lps }
  }
  const skull = loft(PROFILE, 12, 18, .7, 59)
  skinOver(m, skull.rings, skull.lps)
  {
    // The beak: horn, darker at its cutting edge.
    const bk = loft(BEAK, 5, 18, .7, 0), R = bk.rings.length
    const ns = bk.rings.map((ring, i) => ring.map((p, j) => norm(cross(sub(ring[(j + 1) % 18], ring[(j + 17) % 18]), sub(bk.rings[Math.min(i + 1, R - 1)][j], bk.rings[Math.max(i - 1, 0)][j])))))
    m.mat = MAT.plain
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < 18; j++) {
      const j2 = (j + 1) % 18, col = Math.sin(j / 18 * TAU) < -.3 ? HORN_EDGE : HORN
      m.triN(bk.rings[i][j], bk.rings[i + 1][j2], bk.rings[i + 1][j], ns[i][j], ns[i + 1][j2], ns[i + 1][j], col)
      m.triN(bk.rings[i][j], bk.rings[i][j2], bk.rings[i + 1][j2], ns[i][j], ns[i][j2], ns[i + 1][j2], col)
    }
  }
  {
    // The jaw, hinged at the back of the mouth, and the dark of the mouth when it opens.
    const hinge = add(add(neckEnd, scl(look, HL * .42)), scl(hup, -Rs * .045))
    const jl = add(scl(look, Math.cos(open)), scl(hup, -Math.sin(open))), jup = cross(jl, side)
    const rings = [], lps = []
    for (let i = 0; i <= 6; i++) {
      const u = i / 6, c = add(hinge, scl(jl, u * HL * .55)), wj = Rs * (.085 - .07 * u), hj = Rs * (.03 - .02 * u)
      rings.push(ringOf(c, side, jup, wj, hj, 12, 1)); lps.push(ringLp(12, u * .18, wj / Rs, hj / Rs, 30, 71))
    }
    skinOver(m, rings, lps)
    if (open > .02) m.ellipsoid(add(hinge, add(scl(look, HL * .25), scl(hup, Rs * .012))), scl(look, HL * .26), scl(hup, Rs * .03 + Rs * .05 * open), scl(side, Rs * .07), C('#2a0d0a'))
  }
  // Brows over the eyes, nostrils on the snout.
  const eyeAt = s => add(add(neckEnd, scl(look, HL * .5)), add(scl(side, s * Rs * .088), scl(hup, Rs * .03)))
  for (const s of [1, -1]) {
    const ep = eyeAt(s)
    m.ellipsoid(add(ep, add(scl(hup, Rs * .03), scl(side, -s * Rs * .006))), scl(look, Rs * .045), scl(hup, Rs * .012), scl(side, Rs * .022), HIDE_DARK)
    m.ellipsoid(add(add(neckEnd, scl(look, HL * .86)), add(scl(side, s * Rs * .016), scl(hup, Rs * .028))), [Rs * .006, 0, 0], [0, Rs * .004, 0], [0, 0, Rs * .006], C('#14100a'))
  }
  // Eyes: dark and wet, under heavy lids. A blink now and then; slow while it
  // watches you; half shut as it drifts; shut asleep or drawn in.
  turtle.nextBlink -= dt
  if (turtle.nextBlink <= 0) { turtle.blink = waiting ? .9 : .18; turtle.nextBlink = waiting ? rnd(4, 7) : rnd(3, 8) }
  turtle.blink = Math.max(0, turtle.blink - dt)
  const blinkShut = turtle.blink > 0 ? Math.sin(Math.PI * (1 - turtle.blink / (waiting ? .9 : .18))) : 0
  const wantLid = isAway || turtle.out < .3 ? 1 : Math.max(blinkShut, state.startsWith('drifting') ? .4 : waiting ? .25 : .12)
  turtle.lid = mix(turtle.lid, wantLid, Math.min(1, dt * 12))
  const er = Rs * .03
  for (const s of [1, -1]) {
    const ep = eyeAt(s)
    m.mat = MAT.gloss
    m.ellipsoid(ep, scl(look, er), scl(hup, er), scl(side, er), C('#0c0806'))
    m.mat = MAT.plain
    // The upper lid slides down over it; the lower one stays.
    m.ellipsoid(add(ep, add(scl(hup, er * 1.02 * (1 - turtle.lid)), scl(side, s * er * .06))), scl(look, er * 1.06), scl(hup, er * (.7 + .38 * turtle.lid)), scl(side, er * 1.0), HIDE_DARK)
    m.ellipsoid(add(ep, add(scl(hup, -er * .98), scl(side, s * er * .06))), scl(look, er * 1.04), scl(hup, er * .4), scl(side, er * .98), HIDE_DARK)
  }
  turtle.eye = eyeAt(1)
  // The turn is over: it breathes out a cloud of stardust.
  if (b && b.doneAt !== undefined && turtle.doneAt !== b.doneAt) {
    if (turtle.doneAt !== null && t - b.doneAt < 6000) {
      const nose = add(neckEnd, scl(look, HL * .95))
      for (let q = 0; q < 34; q++) spawn({ p: [...nose], v: add(scl(look, rnd(.6, 1.6)), scl(norm([rnd(-1, 1), rnd(-.3, 1), rnd(-1, 1)]), rnd(.1, .5))), life: rnd(2, 3.4), size: rnd(.14, .3), grow: 1.1, c: [1, .92, .78], a: .38, add: true, drag: 1.1 })
    }
  }
  turtle.doneAt = b ? b.doneAt ?? null : null
  turtle.head = add(add(neckEnd, scl(look, HL * .5)), [0, Rs * .16, 0])
  const rate = beast.rate * 60
  const hours = w.startedAt ? (t - w.startedAt) / 3.6e6 : 0
  const label = `The turtle carries the conversation: ${state}${streaming && rate >= 1 ? ` at ${fmtTokens(rate)} tokens a minute` : ''}${w.startedAt ? ` · out ${fmtTime(hours * 3600)} (its shell weathers with the session)` : ''}${w.compactions ? ` · ${w.compactions} ${w.compactions === 1 ? 'compaction' : 'compactions'} (a growth ring each)` : ''}`
  creaturePicks.push({ p: turtle.head, label })
  creaturePicks.push({ p: atShell(S, 0, S.W * .9, S.base + S.H * .4), label })
  tags.push({ p: add(turtle.head, [0, Rs * .05, 0]), group: 'claude', key: 'turtle', text: `🐢 ${state}`, sub: [streaming && rate >= 1 ? `${fmtTokens(rate)} tok/min` : '', w.startedAt ? `out ${fmtTime(hours * 3600)}` : ''].filter(Boolean).join(' · '), rank: .45, live: true })
}

// Space dust streams past as fast as the turtle swims, kept clear of the air over the disc.
// A second layer far off drifts slower and fainter, so space has depth.
const dust = Array.from({ length: 260 }, () => ({ s: rnd(-1, 1), x: rnd(-1, 1), y: rnd(-1, 1), w: rnd(.3, 1) }))
const farDust = Array.from({ length: 220 }, () => ({ s: rnd(-1, 1), x: rnd(-1, 1), y: rnd(-1, 1), w: rnd(.3, 1) }))
const dustLines = (L, dt) => {
  const S = shellOf(), Rs = S.Rs, foot = discFoot()
  for (const [list, span, pace, dim] of [[dust, Rs * 3.2, 1, 1], [farDust, Rs * 7, .35, .45]]) {
    const v = turtle.speed * pace, len = .08 + v * .22
    for (const p of list) {
      p.s -= v * dt / span
      if (p.s < -1) { p.s += 2; p.x = rnd(-1, 1); p.y = rnd(-1, 1) }
      const q = add(atShell(S, p.s * span, p.x * span, 0), [0, p.y * span * .62 - Rs * .3, 0])
      if (Math.hypot(q[0], q[2]) < Rs * AIR_WIDE && q[1] > foot) continue
      const a = (.12 + .3 * p.w) * clamp(.4 + v / (Rs * .25), .4, 1) * dim
      const e = add(q, scl(S.f, len * (.5 + p.w)))
      L.push(q[0], q[1], q[2], .78, .84, 1, a, e[0], e[1], e[2], .78, .84, 1, 0)
    }
  }
}

// The sun and the moon: small bodies that circle the disc on their gauges' arcs.
const ORBIT = 3
const orbPos = dir => scl(dir, I.seaRadius * ORBIT)
const drawOrbs = (m, sunDir, moonDir, warm, night) => {
  const Rs = I.seaRadius, sp = orbPos(sunDir), mp = orbPos(moonDir), rs = Rs * .085, rm = Rs * .06
  m.ellipsoid(sp, [rs, 0, 0], [0, rs, 0], [0, 0, rs], cmix(warm, [1, .97, .9], .5), 1.3)
  glows.push([sp[0], sp[1], sp[2], rs * 4.5, warm[0], warm[1] * .95, warm[2] * .85, .25])
  m.ellipsoid(mp, [rm, 0, 0], [0, rm, 0], [0, 0, rm], C('#d8d4c8'), .12 + night * .25)
  for (let k = 0; k < 5; k++) {
    const a = k * 2.2, cp = add(mp, [Math.cos(a) * rm * .55, Math.sin(a * 1.7) * rm * .5, Math.sin(a) * rm * .55])
    const dir = norm(sub(cp, mp)), cr = rm * (.16 + .06 * (k % 3))
    m.ellipsoid(add(mp, scl(dir, rm * .93)), [cr, 0, 0], [0, cr, 0], [0, 0, cr], C('#b4b0a6'), .08 + night * .15)
  }
  glows.push([mp[0], mp[1], mp[2], rm * 5, .8, .85, 1, .12 + night * .18])
}

// ------------------------------------------------------------------ creatures

let creatures = []
const CLAUDE = C('#d97757')

class Walker {
  constructor(kind, home, radius, opts = {}) {
    this.kind = kind; this.home = home; this.radius = radius; this.avoid = opts.avoid
    const [x, z] = this.pick() || home
    this.x = x; this.z = z; this.y = groundY(x, z); this.heading = rnd(0, TAU)
    this.target = null; this.idle = rnd(0, 3); this.phase = rnd(0, TAU)
    this.speed = opts.speed || .5; this.label = opts.label || ''; this.hue = opts.hue || 0; this.size = opts.size || 1
  }
  pick() {
    for (let k = 0; k < 20; k++) {
      const a = rnd(0, TAU), r = rnd(.3, this.radius)
      const x = this.home[0] + Math.cos(a) * r, z = this.home[1] + Math.sin(a) * r
      const [i, j] = cellAt(x, z)
      if (walkable(i, j) && !(this.avoid && this.avoid(i, j)) && Math.abs(level(i, j) - level(...cellAt(this.x ?? x, this.z ?? z))) <= 2) return [x, z]
    }
    return null
  }
  update(dt) {
    this.moving = false
    if (this.idle > 0) { this.idle -= dt; if (this.idle <= 0) this.target = this.pick(); return this.settle(dt) }
    if (!this.target) { this.idle = rnd(1, 4); return this.settle(dt) }
    const dx = this.target[0] - this.x, dz = this.target[1] - this.z, d = Math.hypot(dx, dz)
    if (d < .06) { this.target = null; this.idle = this.kind === 'bug' ? rnd(.1, .6) : rnd(1.5, 6); return this.settle(dt) }
    this.heading = lerpAngle(this.heading, Math.atan2(dx, dz), Math.min(1, dt * 7))
    const step = Math.min(d, this.speed * dt)
    const nx = this.x + Math.sin(this.heading) * step, nz = this.z + Math.cos(this.heading) * step
    const [i, j] = cellAt(nx, nz)
    if (!walkable(i, j) || (this.avoid && this.avoid(i, j))) { this.target = null; this.idle = rnd(.3, 1.5); return this.settle(dt) }
    this.x = nx; this.z = nz; this.moving = true; this.phase += dt * this.speed * 22
    this.settle(dt)
  }
  settle(dt) { this.y = mix(this.y, groundY(this.x, this.z), Math.min(1, dt * 10)) }
}

const dyn = { m: null }
const body = (m, x, y, z, heading, pitch = 0) => {
  const c = Math.cos(heading), s = Math.sin(heading)
  const W = (ox, oy, oz) => [x + ox * c + oz * s, y + oy, z - ox * s + oz * c]
  const P = (unit, ox, oy, oz, sx, sy, sz, col, e = 0, rot = {}) => {
    const p = W(ox, oy, oz)
    m.put(unit, { x: p[0], y: p[1], z: p[2], sx, sy, sz, ry: heading + (rot.ry || 0), rx: (rot.rx || 0) + pitch, rz: rot.rz || 0 }, col, e)
  }
  return { W, P }
}

// Townsfolk (hooks/world.ts walksOf): for each two files worked one after the
// other lately, someone carries the work between them along the streets,
// from one door to the other and back.
const FOLK = [C('#c0504d'), C('#4f81bd'), C('#9bbb59'), C('#8064a2'), C('#f79646'), C('#4bacc6')]
const drawFolk = (m, t) => {
  const byId = new Map(D.world.features.map(f => [f.id, f]))
  ;(D.walks || []).forEach((w, q) => {
    const a = byId.get(w.from), b = byId.get(w.to)
    if (!a || !b) return
    const r = routeOf(a, b)
    const pts = [[mix(r[0][0], r[1][0], .5), mix(r[0][1], r[1][1], .5)], r[1], r[2], r[3], [mix(r[4][0], r[3][0], .5), mix(r[4][1], r[3][1], .5)]]
    const lens = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1])), L = lens.reduce((s, v) => s + v, 0)
    if (L < .05) return
    const s = (t * .3 + q * 1.7) % (2 * L), back = s > L
    let d = back ? 2 * L - s : s, k = 0
    while (k < lens.length - 1 && d > lens[k]) { d -= lens[k]; k++ }
    const u = lens[k] ? d / lens[k] : 0, p0 = pts[k], p1 = pts[k + 1]
    const x = mix(p0[0], p1[0], u), z = mix(p0[1], p1[1], u), y = streetY(x, z) - .02
    const heading = Math.atan2(p1[0] - p0[0], p1[1] - p0[1]) + (back ? Math.PI : 0)
    const { P } = body(m, x, y, z, heading)
    const swing = Math.sin(t * 9 + q) * .5
    P(UNIT.cube, -.012, .05, 0, .014, .05, .014, C('#3a3330'), 0, { rx: swing, rz: Math.PI })
    P(UNIT.cube, .012, .05, 0, .014, .05, .014, C('#3a3330'), 0, { rx: -swing, rz: Math.PI })
    P(UNIT.cube, 0, .045, 0, .045, .055, .03, FOLK[(a.id * 7 + b.id) % FOLK.length])
    P(UNIT.ico0, 0, .11, 0, .032, .032, .032, C('#f1c9a5'))
    P(UNIT.cube, 0, .065, .028, .032, .024, .006, C('#fffaf0'), .3)
    creaturePicks.push({ p: [x, y + .2, z], label: `A townsperson carrying work between ${nameOf(a.key)} and ${nameOf(b.key)}, worked one after the other` })
    tags.push({ p: [x, y + .3, z], group: 'activity', key: `walk:${w.from}:${w.to}`, text: `${nameOf(a.key)} ↔ ${nameOf(b.key)}`, rank: .15, at: w.at, dim: true })
  })
}

const drawWalker = (m, w, t) => {
  const hop = w.moving ? Math.abs(Math.sin(w.phase * .5)) : 0
  const leg = w.moving ? Math.sin(w.phase) * .6 : 0
  switch (w.kind) {
    case 'rabbit': {
      const y = w.y + hop * .12
      const { P } = body(m, w.x, y, w.z, w.heading)
      const fur = w.hue ? C('#f2efe8') : C('#a98a6a')
      P(UNIT.ico1, 0, 0, 0, .16, .14, .22, fur)
      P(UNIT.ico1, 0, .08, .11, .11, .11, .12, fur)
      P(UNIT.cube, -.03, .16, .11, .025, .13, .015, fur, 0, { rx: -.2 })
      P(UNIT.cube, .03, .16, .11, .025, .13, .015, fur, 0, { rx: -.2 })
      P(UNIT.ico0, 0, .05, -.11, .05, .05, .05, C('#ffffff'))
      P(UNIT.ico0, -.03, .13, .17, .015, .015, .015, C('#111'))
      P(UNIT.ico0, .03, .13, .17, .015, .015, .015, C('#111'))
      break
    }
    case 'deer': {
      const graze = !w.moving && Math.sin(w.phase + t * .7) > .2
      const { P } = body(m, w.x, w.y, w.z, w.heading)
      const fur = C('#9c6b43')
      // Each leg hangs from its hip inside the body, so it swings about the hip and stays on.
      for (const [ox, oz, ph] of [[-.07, .14, 0], [.07, .14, Math.PI], [-.07, -.14, Math.PI], [.07, -.14, 0]]) P(UNIT.cube, ox, .3, oz, .035, .3, .035, C('#5b3d27'), 0, { rx: Math.sin(w.phase + ph) * (w.moving ? .5 : 0), rz: Math.PI })
      P(UNIT.ico1, 0, .24, 0, .2, .18, .42, fur)
      P(UNIT.ico0, 0, .26, -.2, .06, .06, .05, C('#f2efe8'))
      P(UNIT.cube, 0, .3, .17, .07, .2, .07, fur, 0, { rx: graze ? 1.9 : .5 })
      const hy = graze ? .12 : .48, hz = graze ? .34 : .27
      P(UNIT.ico1, 0, hy, hz, .1, .1, .15, fur)
      if (w.hue) for (const sx of [-1, 1]) { P(UNIT.cube, sx * .03, hy + .08, hz - .02, .015, .16, .015, C('#d9c7a8'), 0, { rz: sx * .4 }); P(UNIT.cube, sx * .06, hy + .17, hz - .02, .012, .08, .012, C('#d9c7a8'), 0, { rz: -sx * .5 }) }
      P(UNIT.ico0, -.04, hy + .05, hz + .06, .015, .015, .015, C('#111'))
      P(UNIT.ico0, .04, hy + .05, hz + .06, .015, .015, .015, C('#111'))
      break
    }
    case 'bug': {
      const jitter = w.moving ? Math.sin(w.phase * 2) * .3 : 0
      const { P } = body(m, w.x, w.y + .02, w.z, w.heading)
      for (let q = 0; q < 3; q++) for (const sx of [-1, 1]) P(UNIT.cube, sx * .06, 0, -.04 + q * .04, .1, .012, .012, C('#111'), 0, { ry: sx * (jitter * (q % 2 ? 1 : -1)) })
      P(UNIT.ico1, 0, 0, 0, .14, .08, .17, C('#b3261e'))
      P(UNIT.cube, 0, .075, -.005, .004, .01, .15, C('#2a0c0a'))
      P(UNIT.ico0, -.035, .055, -.02, .03, .03, .03, C('#111'))
      P(UNIT.ico0, .035, .055, .03, .03, .03, .03, C('#111'))
      P(UNIT.ico1, 0, .01, .09, .07, .06, .06, C('#151515'))
      P(UNIT.cube, -.02, .03, .13, .006, .006, .06, C('#151515'), 0, { ry: -.4, rx: -.5 })
      P(UNIT.cube, .02, .03, .13, .006, .006, .06, C('#151515'), 0, { ry: .4, rx: -.5 })
      break
    }
  }
}

// Birds wheel above the island; at night they are bats.
const flock = []
const drawBirds = (m, t, night) => {
  for (const b of flock) {
    b.a += b.w * (1 + mood.haste)
    const x = Math.cos(b.a) * b.r, z = Math.sin(b.a) * b.r, y = b.h + Math.sin(t * .7 + b.ph) * .3
    const heading = b.a + (b.w > 0 ? 0 : Math.PI)
    const flap = Math.sin(t * (night ? 16 : 9) + b.ph) * (night ? .9 : .7)
    const { P, W } = body(m, x, y, z, heading, 0)
    const bodyC = night ? C('#2b2230') : C('#f4f4f2'), wingC = night ? C('#3a2c40') : C('#c9ccd1')
    P(UNIT.ico0, 0, 0, 0, .06, .06, .18, bodyC)
    for (const sx of [-1, 1]) {
      const root = W(sx * .02, .03, 0), tipUp = Math.sin(flap) * .14
      const tip = W(sx * .2, .03 + tipUp * sx * sx, -.02), back = W(sx * .1, .03 + tipUp * .5, -.07)
      m.sheet(root, W(sx * .02, .03, .05), tip, back, wingC)
    }
    creaturePicks.push({ p: [x, y + .1, z], label: night ? 'A bat, out for the night' : 'A seabird: the web and your ideas bring them' })
    tags.push({ p: [x, y + .3, z], group: 'wildlife', key: `bird:${b.ph}`, text: night ? '🦇 bat' : '🕊 seabird', rank: .05, dim: true })
  }
}

// Fish leap from the sea; the fuller the context, the more of them.
const fishes = []
const drawFish = (m, dt) => {
  const sea = seaY()
  for (const f of fishes) {
    f.t -= dt
    if (f.t > 0) continue
    if (!f.jump) {
      for (let k = 0; k < 20; k++) {
        const a = rnd(0, TAU), r = rnd(I.R * .7, I.seaRadius - .5)
        const x = Math.cos(a) * r, z = Math.sin(a) * r
        if (I.sea - level(...cellAt(x, z)) > .6) { f.jump = { x, z, dir: rnd(0, TAU), u: 0 }; splash([x, sea, z]); break }
      }
      if (!f.jump) { f.t = 1; continue }
    }
    const j = f.jump
    j.u += dt / .9
    const x = j.x + Math.sin(j.dir) * j.u * .9, z = j.z + Math.cos(j.dir) * j.u * .9
    const y = sea + Math.sin(Math.PI * j.u) * .6 - .05
    const pitch = -Math.cos(Math.PI * j.u) * 1.1
    const { P } = body(m, x, y, z, j.dir, pitch)
    P(UNIT.ico1, 0, -.04, 0, .08, .09, .24, f.c)
    P(UNIT.cube, 0, -.04, -.13, .005, .09, .08, cmul(f.c, .8), 0, { rx: .4 })
    creaturePicks.push({ p: [x, y + .1, z], label: 'A fish: the sea fills with them as the context fills' })
    tags.push({ p: [x, y + .35, z], group: 'wildlife', key: `fish:${fishes.indexOf(f)}`, text: '🐟 fish', rank: .05, dim: true })
    if (j.u >= 1) { splash([x, sea, z]); f.jump = null; f.t = rnd(1.5, 6) }
  }
}

// A sea serpent surfaces when the context grows crowded: one long striped
// body swimming round the island, rolling in and out of the sea in humps
// that travel down it, golden spines along its back, its head held up.
const serpent = { a: 0, on: false }
const drawSerpent = (m, t, dt) => {
  if (!serpent.on) return
  serpent.a += dt * .12
  const r = (I.R * .92 + I.seaRadius) / 2, sea = seaY(), N = 64, span = 1.2
  const dark = C('#1a6b5d'), light = C('#2fa58c'), gold = C('#e3c26b')
  const pts = [], radii = [], cols = []
  for (let k = 0; k < N; k++) {
    const u = k / (N - 1), an = serpent.a - u * span
    const head = sstep(.12, 0, u)
    const y = sea - .1 + Math.sin(u * 3.6 * TAU - t * 1.8) * .42 * (1 - head) * (1 - u * .4) + head * .4
    const rr = r + Math.sin(u * 9 + t * .7) * .25
    pts.push([Math.cos(an) * rr, y, Math.sin(an) * rr])
    radii.push((.03 + .16 * Math.pow(1 - u, .8)) * (1 - .25 * Math.exp(-(((u - .07) / .035) ** 2))))
    cols.push(cmix(dark, light, .5 + .5 * Math.sin(u * 46)))
  }
  m.tube(pts, radii, dark, 0, 10, cols)
  // Spines on the humps that break the surface; a little foam where it dives and rises.
  for (let k = 6; k < N - 8; k += 4) if (pts[k][1] > sea) m.put(UNIT.cone6, { x: pts[k][0], y: pts[k][1] + radii[k] * .7, z: pts[k][2], sx: .07, sy: .16, sz: .07 }, gold)
  for (let k = 1; k < N; k++) {
    if ((pts[k - 1][1] - sea) * (pts[k][1] - sea) >= 0 || Math.random() > dt * 2.5) continue
    spawn({ p: [pts[k][0], sea + .02, pts[k][2]], v: [rnd(-.2, .2), rnd(.3, .6), rnd(-.2, .2)], life: rnd(.4, .7), size: .08, c: [.9, .97, 1], a: .7, buoy: -3 })
  }
  // The head: long, a heavy jaw, two horns swept back, eyes that glow.
  const dir = norm(sub(pts[0], pts[1])), side = norm(cross([0, 1, 0], dir)), up = cross(dir, side)
  const hc = add(pts[0], scl(dir, .16))
  m.ellipsoid(hc, scl(dir, .3), scl(up, .15), scl(side, .17), light)
  m.ellipsoid(add(hc, add(scl(dir, .14), scl(up, -.07))), scl(dir, .2), scl(up, .06), scl(side, .12), dark)
  for (const sd of [1, -1]) {
    m.ellipsoid(add(hc, add(add(scl(dir, .1), scl(side, sd * .12)), scl(up, .07))), [.05, 0, 0], [0, .05, 0], [0, 0, .05], C('#ffe066'), 3)
    const hb = add(hc, add(add(scl(dir, -.08), scl(side, sd * .09)), scl(up, .1)))
    m.tube([hb, add(hb, add(scl(dir, -.22), add(scl(up, .1), scl(side, sd * .05))))], [.035, .005], gold, 0, 5)
  }
  creaturePicks.push({ p: add(hc, [0, .35, 0]), label: `The sea serpent: the context is crowded (tide ${Math.round(D.world.tide)}%)` })
  tags.push({ p: add(hc, [0, .65, 0]), group: 'wildlife', key: 'serpent', text: `🐍 serpent · context ${Math.round(D.world.tide)}%`, rank: .35, live: true })
}

// Butterflies dance when you are glad.
const butterflies = []
const drawButterflies = (m, t, dt) => {
  for (const b of butterflies) {
    b.ph += dt
    if (!b.to || Math.hypot(b.to[0] - b.x, b.to[1] - b.z) < .1) {
      const a = rnd(0, TAU), r = rnd(.5, 2.5)
      b.to = [b.home[0] + Math.cos(a) * r, b.home[1] + Math.sin(a) * r]
    }
    const dx = b.to[0] - b.x, dz = b.to[1] - b.z
    b.heading = lerpAngle(b.heading, Math.atan2(dx, dz), Math.min(1, dt * 3))
    b.x += Math.sin(b.heading) * dt * .6; b.z += Math.cos(b.heading) * dt * .6
    const y = Math.max(groundY(b.x, b.z), seaY()) + .45 + Math.sin(b.ph * 3) * .15
    const flap = Math.sin(t * 22 + b.ph) * 1.1
    const { W } = body(m, b.x, y, b.z, b.heading)
    for (const sx of [-1, 1]) m.sheet(W(0, 0, .04), W(sx * .13 * Math.cos(flap), .13 * Math.abs(Math.sin(flap)), .07), W(sx * .12 * Math.cos(flap), .1 * Math.abs(Math.sin(flap)), -.06), W(0, 0, -.03), b.c, .3)
  }
}

let wildKey = ''
const populate = () => {
  const w = D.world
  // The sea's life follows the context as it rises and falls, whatever else changed.
  const fishCount = Math.min(9, 2 + Math.floor(w.tide / 15))
  while (fishes.length < fishCount) fishes.push({ t: rnd(0, 4), jump: null, c: hsl([20, 200, 45, 330][fishes.length % 4], .7, .55) })
  fishes.length = fishCount
  serpent.on = w.tide >= 65
  const key = `${w.turn}|${w.errors}|${(w.tests && w.tests.failed) || 0}|${w.features.length}|${I.R}|${I.sea}`
  if (key === wildKey) return
  wildKey = key
  const keep = creatures
  creatures = []
  const land = []
  for (let i = -I.G; i < I.G; i++) for (let j = -I.G; j < I.G; j++) if (walkable(i, j)) land.push([i + .5, j + .5, biomeAt(i, j)])
  if (land.length === 0) return
  const reuse = (kind, n, make) => {
    const old = keep.filter(c => c.kind === kind)
    for (let q = 0; q < n; q++) creatures.push(old[q] || make(q))
  }
  const near = pred => { const cand = land.filter(pred); return cand.length ? cand[Math.floor(Math.random() * cand.length)] : land[Math.floor(Math.random() * land.length)] }
  reuse('rabbit', Math.min(12, 2 + w.turn), q => new Walker('rabbit', near(c => c[2] === BIOME.meadow || c[2] === BIOME.dry), 3, { speed: .9, hue: q % 3 === 0 ? 1 : 0, label: 'A rabbit: the wild multiplies as the conversation grows' }))
  reuse('deer', Math.min(7, 1 + Math.floor(w.turn / 2)), q => new Walker('deer', near(c => c[2] === BIOME.forest || c[2] === BIOME.meadow), 4, { speed: .45, hue: q % 2, label: 'A deer: the wild multiplies as the conversation grows' }))
  const scorched = w.features.filter(f => f.isScorched)
  const testBugs = (w.tests && w.tests.failed) || 0
  const watchtowers = w.features.filter(f => f.style === 'test')
  reuse('bug', Math.min(14, w.errors + testBugs), q => {
    const f = q < w.errors ? scorched[q % Math.max(1, scorched.length)] : watchtowers[q % Math.max(1, watchtowers.length)] || scorched[0]
    const home = f ? [f.x + .5, f.y + .5] : near(() => true)
    return new Walker('bug', home, .9, { speed: .7, label: `A bug: ${w.errors} tool ${w.errors === 1 ? 'call' : 'calls'} failed this session` })
  })
  const birds = Math.min(18, 3 + 2 * w.features.filter(f => f.kind === 'windmill').length + Math.floor(w.lanterns.length / 2))
  while (flock.length < birds) flock.push({ a: rnd(0, TAU), w: rnd(.003, .007) * (Math.random() < .5 ? -1 : 1), r: rnd(I.R * .4, I.seaRadius + 1), h: rnd(3.5, 6.5), ph: rnd(0, TAU) })
  flock.length = birds
}

// ------------------------------------------------------------------ particles

const parts = []
const glows = []        // per frame: x, y, z, size, r, g, b, a
const creaturePicks = []
const spawn = p => { if (parts.length < 2500) parts.push({ age: 0, grow: 0, drag: 0, buoy: 0, ...p }) }
const splash = p => { for (let k = 0; k < 14; k++) spawn({ p: [p[0], p[1] + .02, p[2]], v: [rnd(-.5, .5), rnd(.6, 1.3), rnd(-.5, .5)], life: rnd(.4, .8), size: .07, c: [.9, .97, 1], a: .9, buoy: -3 }) }
const sparkleBurst = (p, c = [1, .85, .5]) => { for (let k = 0; k < 40; k++) spawn({ p: [...p], v: [rnd(-.8, .8), rnd(.4, 1.6), rnd(-.8, .8)], life: rnd(.6, 1.4), size: .1, c, a: 1, add: true, buoy: -1, drag: 1.5 }) }

const emitAll = dt => {
  for (const e of emitters) {
    e.acc = (e.acc || 0) + dt * e.rate
    while (e.acc >= 1) {
      e.acc -= 1
      const wind = [.12 + mood.haste * .5, 0, .05]
      switch (e.kind) {
        // Smoke is kept thin and short-lived: a wisp, not a fog over the town.
        case 'smoke': case 'chimney': spawn({ p: [...e.p], v: [rnd(-.04, .04) + wind[0], rnd(.25, .4), rnd(-.04, .04)], life: rnd(1.6, 2.6), size: e.kind === 'chimney' ? .2 : .3, grow: .4, c: [.85, .85, .85], a: e.kind === 'chimney' ? .22 : .28 }); break
        case 'darksmoke': spawn({ p: [...e.p], v: [rnd(-.04, .04) + wind[0], rnd(.3, .45), rnd(-.04, .04)], life: rnd(1.8, 2.8), size: .34, grow: .5, c: [.18, .17, .17], a: .38 }); break
        case 'fire': spawn({ p: [e.p[0] + rnd(-.1, .1), e.p[1], e.p[2] + rnd(-.1, .1)], v: [rnd(-.05, .05), rnd(.4, .8), rnd(-.05, .05)], life: rnd(.4, .8), size: .22, grow: -.2, c: [1, .45, .12], a: 1, add: true }); if (Math.random() < .12) spawn({ p: [...e.p], v: [wind[0], .35, 0], life: 3, size: .4, grow: .5, c: [.2, .2, .2], a: .5 }); break
        case 'embers': spawn({ p: [e.p[0] + rnd(-.05, .05), e.p[1], e.p[2] + rnd(-.05, .05)], v: [rnd(-.1, .1), rnd(.5, 1), rnd(-.1, .1)], life: rnd(.6, 1.4), size: .05, c: [1, .6, .2], a: 1, add: true }); break
        case 'mist': spawn({ p: [e.p[0] + rnd(-.3, .3), e.p[1], e.p[2] + rnd(-.3, .3)], v: [rnd(-.1, .1), rnd(.05, .2), rnd(-.1, .1)], life: rnd(1, 2), size: .4, grow: .4, c: [.9, .95, 1], a: .35 }); break
        case 'volcano': {
          spawn({ p: [e.p[0] + rnd(-.2, .2), e.p[1], e.p[2] + rnd(-.2, .2)], v: [wind[0] * .5 + rnd(-.05, .05), rnd(.6, 1), rnd(-.05, .05)], life: rnd(4, 7), size: .9, grow: .9, c: [.22, .2, .2], a: .55 })
          if (Math.random() < .6) spawn({ p: [...e.p], v: [rnd(-.6, .6), rnd(1.5, 3), rnd(-.6, .6)], life: rnd(1, 2), size: .09, c: [1, .45, .1], a: 1, add: true, buoy: -2.5 })
          break
        }
      }
    }
  }
}

const stepParticles = dt => {
  for (let k = parts.length - 1; k >= 0; k--) {
    const p = parts[k]
    p.age += dt
    if (p.age >= p.life) { parts.splice(k, 1); continue }
    p.v[1] += p.buoy * dt
    const d = Math.max(0, 1 - p.drag * dt)
    p.v[0] *= d; p.v[1] *= d; p.v[2] *= d
    p.p[0] += p.v[0] * dt; p.p[1] += p.v[1] * dt; p.p[2] += p.v[2] * dt
  }
}

// Fireflies, clouds and lanterns live as long as their weather does.
const fireflies = Array.from({ length: 50 }, () => ({ a: rnd(0, TAU), r: rnd(0, 1), h: rnd(.3, 1.4), ph: rnd(0, TAU), s: rnd(.3, .9) }))
const clouds = Array.from({ length: 11 }, (_, k) => ({ a: k / 11 * TAU + rnd(-.2, .2), r: rnd(1.05, 1.45), h: rnd(3.2, 5.2), puffs: Array.from({ length: 9 }, (_, q) => [rnd(-1, 1), q < 4 ? rnd(-.12, .05) : rnd(0, .4), rnd(-.55, .55), q < 4 ? rnd(1.1, 1.8) : rnd(.7, 1.3)]) }))
const lanternPicks = () => { }

// ------------------------------------------------------------------ the sky over time

const SKYK = [
  [0, '#03050f', '#101632'], [4.5, '#060a1d', '#1c2346'], [6, '#4a5e9e', '#f2a07a'], [7.5, '#5f97de', '#cfe3f6'],
  [12, '#4f8fe0', '#d6eaff'], [16.5, '#5f8bd0', '#eed5a8'], [18.7, '#33366e', '#f2875a'], [20.2, '#141a3c', '#4f3a66'],
  [21.5, '#060a1d', '#151b3c'], [24, '#03050f', '#101632'],
]
const skyAt = hour => {
  for (let k = 0; k < SKYK.length - 1; k++) {
    const [h0, z0, o0] = SKYK[k], [h1, z1, o1] = SKYK[k + 1]
    if (hour >= h0 && hour <= h1) { const t = sstep(0, 1, (hour - h0) / (h1 - h0)); return [cmix(C(z0), C(z1), t), cmix(C(o0), C(o1), t)] }
  }
  return [C('#03050f'), C('#101632')]
}

const mood = { joy: .2, storm: 0, wonder: .2, haste: 0 }
const machine = { rain: 0, cpu: .25, ram: .4 }
let flash = 0

// ------------------------------------------------------------------ camera and input

// Left drag slides the view across the island; right drag (or shift + left)
// turns it, down below the rim too; the wheel comes closer or backs off to
// the whole turtle; 🐢 (U) flies out to see the turtle swim, and a double
// click puts it all back.
const cam = { yaw: .75, pitch: .58, dist: 20, tYaw: .75, tPitch: .58, tDist: 20, x: 0, z: 0, y: .9, tX: 0, tZ: 0, tY: .9, idle: 0, intro: 1, orbit: true }
const islandView = () => { cam.tYaw = .75; cam.tPitch = .58; cam.tDist = I ? I.seaRadius * 2.1 : 20; cam.tX = 0; cam.tZ = 0; cam.tY = .9 }
const turtleView = () => {
  cam.idle = 0
  if (!I || cam.tY < 0) { islandView(); return }
  // From in front of it and to its left, a little below the rim.
  const S = shellOf(), dir = add(scl(S.f, .8), scl(S.r, -.6))
  cam.tYaw = Math.atan2(dir[0], dir[2]); cam.tPitch = .16; cam.tDist = S.Rs * 3.8; cam.tY = S.base + S.H * .6; cam.tX = 0; cam.tZ = 0
}
let drag = null
canvas.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, turn: e.button !== 0 || e.shiftKey, x0: e.clientX, y0: e.clientY, at: performance.now() }
  canvas.setPointerCapture(e.pointerId); cam.idle = 0
  // A second press soon after is a double click (back to the island view), not a send.
  clearTimeout(clickTimer)
})
canvas.addEventListener('pointermove', e => {
  mouse.x = e.clientX; mouse.y = e.clientY
  if (!drag) return
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y
  if (drag.turn) {
    cam.tYaw -= dx * .006
    cam.tPitch = clamp(cam.tPitch + dy * .004, -.9, 1.35)
  } else {
    // The ground under the cursor follows it: a pixel is as far as the view is wide there.
    const k = 2 * Math.tan(.31) * cam.dist / Math.max(1, canvas.clientHeight)
    const right = [Math.cos(cam.yaw), -Math.sin(cam.yaw)], into = [-Math.sin(cam.yaw), -Math.cos(cam.yaw)]
    const along = k / Math.max(.35, Math.sin(cam.pitch))
    const lim = I ? I.seaRadius : 14
    cam.tX = clamp(cam.tX - right[0] * dx * k + into[0] * dy * along, -lim, lim)
    cam.tZ = clamp(cam.tZ - right[1] * dx * k + into[1] * dy * along, -lim, lim)
  }
  drag.x = e.clientX; drag.y = e.clientY; cam.idle = 0
})
// A left click on the ground (a short press that did not drag) sends the creature there.
let clickTimer = 0, camRay = null
canvas.addEventListener('pointerup', e => {
  const d = drag
  drag = null
  if (!d || d.turn || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 5 || performance.now() - d.at > 450) return
  const hit = groundAt(e.clientX, e.clientY)
  if (hit) clickTimer = setTimeout(() => sendTo(hit[0], hit[1]), 300)
})
// The ground under a point of the window: out along the eye's ray until it passes under
// the ground, a roof or the sea, then narrowed down. Only land it can crawl on.
const groundAt = (cx, cy) => {
  if (!camRay || !I) return null
  const r = canvas.getBoundingClientRect(), nx = (cx - r.left) / r.width * 2 - 1, ny = 1 - (cy - r.top) / r.height * 2
  const { eye, F, R, U, tan, aspect } = camRay
  const dir = norm(add(F, add(scl(R, nx * tan * aspect), scl(U, ny * tan))))
  const at = s => add(eye, scl(dir, s))
  const under = p => Math.hypot(p[0], p[2]) < I.seaRadius && p[1] <= Math.max(standAt(p[0], p[2]), seaY())
  let a = 0, b = -1
  for (let s = .3; s < 300; s += .15 + s * .01) { if (under(at(s))) { b = s; break } a = s }
  if (b < 0) return null
  for (let k = 0; k < 10; k++) { const mid = (a + b) / 2; if (under(at(mid))) b = mid; else a = mid }
  const p = at(b)
  const [i, j] = cellAt(p[0], p[2])
  if (walkable(i, j)) return [p[0], p[2]]
  // Just off the land (the water's edge, a river): the nearest cell it can crawl on, if one is close.
  let best = null, bd = 2.6
  for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
    const d = Math.hypot(di, dj)
    if (d < bd && walkable(i + di, j + dj)) { bd = d; best = [i + di + .5, j + dj + .5] }
  }
  return best
}
canvas.addEventListener('contextmenu', e => e.preventDefault())
canvas.addEventListener('pointerleave', () => { mouse.x = -1 })
canvas.addEventListener('wheel', e => { e.preventDefault(); cam.tDist = clamp(cam.tDist * Math.exp(e.deltaY * .001), 4, I ? Math.max(60, I.seaRadius * 6) : 60); cam.idle = 0 }, { passive: false })
canvas.addEventListener('dblclick', islandView)
const mouse = { x: -1, y: -1 }

const $ = id => document.getElementById(id)
// The sun and moon gauges: read-only, the limits as they stand.
let gaugeKey = ''
const gauges = (sunP, moonP) => {
  const key = `${sunP}|${moonP}`
  if (key === gaugeKey) return
  gaugeKey = key
  const place = (dot, p) => {
    const t = Math.PI - clamp(p ?? 0, 0, 1) * Math.PI
    dot.setAttribute('cx', (22 + 19 * Math.cos(t)).toFixed(1))
    dot.setAttribute('cy', (20 - 19 * Math.sin(t)).toFixed(1))
  }
  place($('sunDot'), sunP)
  place($('moonDot'), moonP)
  $('sunPct').textContent = sunP === null ? 'clock' : `${Math.round(sunP * 100)}%`
  $('moonPct').textContent = moonP === null ? '–' : `${Math.round(moonP * 100)}%`
  $('moonGauge').style.display = moonP === null ? 'none' : 'flex'
}
const toggle = (id, panel) => { const b = $(id), p = $(panel); p.classList.toggle('hidden'); b.classList.toggle('on', !p.classList.contains('hidden')) }
$('hudBtn').onclick = () => toggle('hudBtn', 'hud')
$('legendBtn').onclick = () => toggle('legendBtn', 'legend')
$('turtleBtn').onclick = turtleView
$('orbitBtn').onclick = () => { cam.orbit = !cam.orbit; $('orbitBtn').classList.toggle('on', cam.orbit) }
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
$('fsBtn').onclick = toggleFs
$('soundBtn').onclick = () => toggleSound()
$('focusBtn').onclick = () => toggleFocus()
$('airBtn').onclick = () => toggleAir()
$('qualityBtn').onclick = () => cycleQuality()
addEventListener('keydown', e => {
  // Typing in the chat box or the label search is not a shortcut.
  if (e.target instanceof Element && e.target.closest('textarea, input:not([type=checkbox]):not([type=range])')) return
  if (e.key === 'c') setChat(!chat.open)
  if (e.key === 'f') toggleFs()
  if (e.key === 't') toggleFocus()
  if (e.key === 'a') toggleAir()
  if (e.key === 'q') cycleQuality()
  if (e.key === 'm') toggleSound()
  if (e.key === 'h') toggle('hudBtn', 'hud')
  if (e.key === 'l') toggle('legendBtn', 'legend')
  if (e.key === 'o') $('orbitBtn').click()
  if (e.key === 'u') turtleView()
  if (e.key === 'n') toggleTags()
})

// ------------------------------------------------------------------ the chat panel
// The conversation beside the island (chat.json, written by the mod while this
// window is open), and a box to talk to Claude from here: what you send goes
// back to this page's own server as upload/prompt.json, and the mod hands it
// to Claude Code as your own message, waiting its turn if Claude is at work.
const chat = { open: false, seen: '', pending: [], stick: false }
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// A little markdown, after escaping: code blocks, inline code, bold, headings.
const md = text => escHtml(text)
  .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  .replace(/^#{1,4} (.*)$/gm, '<b>$1</b>')
const renderChat = data => {
  const log = $('chatLog'), items = data.items || []
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const out = []
  let tools = []
  const flush = () => { if (tools.length) { out.push(`<div class="tools">${tools.join('')}</div>`); tools = [] } }
  for (const it of items) {
    if (it.role === 'tool') { tools.push(`<div${it.isError ? ' class="err"' : ''}>⚙ ${escHtml(it.text)}${it.isError ? ' · failed' : ''}</div>`); continue }
    flush()
    out.push(`<div class="m ${it.role === 'user' ? 'user' : 'assistant'}${it.isLive ? ' live' : ''}">${it.role === 'user' ? escHtml(it.text) : md(it.text)}</div>`)
  }
  flush()
  // Sent from here and not yet in the conversation: shown dim, waiting its turn once the mod has taken it.
  const said = new Set(items.filter(i => i.role === 'user').map(i => i.text.trim()))
  chat.pending = chat.pending.filter(p => !said.has(p.text) && Date.now() - p.at < 600000)
  for (const p of chat.pending) {
    if (p.id === data.taken) p.taken = true
    out.push(`<div class="m user pending">${escHtml(p.text)}<br><small>${p.taken ? 'waiting its turn…' : 'sending…'}</small></div>`)
  }
  if (!out.length) out.push('<div class="tools">Nothing said yet.</div>')
  log.innerHTML = out.join('')
  if (atBottom || chat.stick) { log.scrollTop = log.scrollHeight; chat.stick = false }
  $('chatState').textContent = data.waiting ? `🔔 waiting on you · ${data.waiting}` : data.isWorking ? `✦ ${data.verb || 'working'}…` : 'idle'
  $('chatNote').textContent = data.isWorking && !data.waiting ? 'Claude is at work: a message sent now waits its turn.' : ''
}
const pollChat = async () => {
  if (!chat.open) return
  try {
    const r = await fetch(`chat.json?${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    const text = await r.text()
    if (text === chat.seen) return
    chat.seen = text
    renderChat(JSON.parse(text))
  } catch {
    $('chatState').textContent = 'waiting for the conversation…'
  }
}
setInterval(pollChat, 1200)
// Below the buttons, however many rows they wrap to.
const placeChat = () => { $('chat').style.top = `${Math.round($('controls').getBoundingClientRect().bottom + 10)}px` }
addEventListener('resize', placeChat)
const fitInput = () => { const b = $('chatInput'); b.style.height = 'auto'; b.style.height = `${Math.min(160, b.scrollHeight)}px` }
const setChat = (open, focus = true) => {
  chat.open = open
  $('chat').classList.toggle('hidden', !open)
  $('chatBtn').classList.toggle('on', open)
  if (open) {
    if (!$('legend').classList.contains('hidden')) toggle('legendBtn', 'legend')
    placeChat()
    chat.stick = true; chat.seen = ''
    pollChat()
    if (focus) setTimeout(() => $('chatInput').focus(), 0)
  }
  try { localStorage.setItem('terrarium.chat', open ? '1' : '0') } catch {}
}
const sendChat = async () => {
  const box = $('chatInput'), text = box.value.trim()
  if (!text) return
  if (text.length > 8000) { $('chatNote').textContent = 'That is longer than a message from here may be (8000 characters).'; return }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const r = await fetch('upload/prompt.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) })
    if (!r.ok) throw new Error(`the server said ${r.status}`)
    chat.pending.push({ id, text, at: Date.now() })
    box.value = ''; fitInput()
    chat.stick = true; chat.seen = ''
    pollChat()
  } catch (e) {
    $('chatNote').textContent = `Could not reach Claude Code (${e.message}). Is the session still open?`
  }
}
$('chatBtn').onclick = () => setChat(!chat.open)
$('chatClose').onclick = () => setChat(false)
$('legendBtn').addEventListener('click', () => { if (!$('legend').classList.contains('hidden')) setChat(false) })
$('chatForm').onsubmit = e => { e.preventDefault(); sendChat() }
$('chatInput').addEventListener('input', fitInput)
$('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat() }
  if (e.key === 'Escape') e.target.blur()
})
try { if (localStorage.getItem('terrarium.chat') === '1') setChat(true, false) } catch {}

// ------------------------------------------------------------------ the labels panel
// Which labels show, and how many: a box per group (with how many of its
// labels are shown of those in view), the density, only the recent, a search
// and presets. N switches them all off, and back to how they were. The
// choice is this browser's own.
const tagRows = {}
const setDensity = v => {
  tagSet.density = v
  if (v > 0) tagSet.back = v
  $('tagDensity').value = String(v)
  $('tagDensityName').textContent = DENSITY[v].name
  $('tagBtn').textContent = v ? '🏷 Labels' : '🏷 Labels off'
  saveTags()
}
for (const g of TAG_GROUPS) {
  const row = document.createElement('label'), box = document.createElement('input'), dot = document.createElement('i')
  const name = document.createElement('span'), count = document.createElement('small')
  row.className = 'tg'; row.title = g.about
  box.type = 'checkbox'; box.checked = tagSet.groups[g.id]
  dot.style.background = g.c; name.textContent = g.name
  box.onchange = () => { tagSet.groups[g.id] = box.checked; if (box.checked && !tagSet.density) setDensity(tagSet.back); saveTags() }
  row.append(box, dot, name, count)
  $('tagGroups').appendChild(row)
  tagRows[g.id] = { box, count }
}
$('tagDensity').oninput = e => setDensity(Number(e.target.value))
$('tagRecent').checked = tagSet.recent
$('tagRecent').onchange = e => { tagSet.recent = e.target.checked; saveTags() }
$('tagQuery').oninput = e => { tagSet.query = e.target.value; if (tagSet.query && !tagSet.density) setDensity(tagSet.back) }
$('tagQuery').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; tagSet.query = ''; e.target.blur() } })
for (const b of document.querySelectorAll('#tagPresets button')) b.onclick = () => {
  const p = TAG_PRESETS[b.dataset.preset]
  for (const g of TAG_GROUPS) { tagSet.groups[g.id] = p.groups.includes(g.id); tagRows[g.id].box.checked = tagSet.groups[g.id] }
  setDensity(p.density)
}
const toggleTags = () => setDensity(tagSet.density ? 0 : tagSet.back)
// Under the title; below the buttons when they wrap across a narrow window.
const placeTags = () => { const c = $('controls').getBoundingClientRect(); $('tags').style.top = `${c.left < 16 + $('tags').offsetWidth + 8 ? Math.round(c.bottom + 10) : 44}px` }
addEventListener('resize', placeTags)
const showTagPanel = () => { toggle('tagBtn', 'tags'); placeTags() }
$('tagBtn').onclick = showTagPanel
$('tagClose').onclick = showTagPanel
// The counts, twice a second while the panel is open.
setInterval(() => {
  if ($('tags').classList.contains('hidden')) return
  for (const g of TAG_GROUPS) { const [s, n] = tagCounts[g.id] || [0, 0]; tagRows[g.id].count.textContent = n ? `${s} of ${n}` : '' }
  $('tagNote').textContent = !tagSet.density ? 'Labels are off: N brings them back.'
    : tagCrowded ? `${tagCrowded} more wait their turn so none overlap: come closer, raise the slider, or hover to read them.` : ''
}, 500)
setDensity(tagSet.density)

// ------------------------------------------------------------------ grass

// Blades on the green ground, more on High; a few meadow blades are flowers.
let statData = new Float32Array(0)   // the island's mesh, kept for a photo
let streamWater = []                 // rivers and falls (x, y, z, depth), kept for a photo
let dynData = new Float32Array(0)    // this frame's moving things, kept for a photo
let grassData = new Float32Array(0)  // the blades: x, y, z, height, r, g, b, turn (+1 for a flower)
let grassKey = ''
const GRASS_TINT = { [BIOME.meadow]: C('#7fbf55'), [BIOME.forest]: C('#4f8f3c'), [BIOME.marsh]: C('#6f9a4e'), [BIOME.dry]: C('#b5b060') }
const FLOWER = [C('#f4d35e'), C('#ee6c8b'), C('#ffffff'), C('#b28cff'), C('#ff9f43')]
const buildGrass = (force = false) => {
  const density = QL().grass
  const key = `${version}|${density}`
  if (key === grassKey && !force) return
  grassKey = key
  const out = []
  if (density > 0) {
    const G = I.G, seed = I.seed
    const taken = new Set(D.world.features.map(f => `${f.x},${f.y}`))
    for (let i = -G; i < G; i++) for (let j = -G; j < G; j++) {
      if (!inside(i, j) || taken.has(`${i},${j}`)) continue
      const b = biomeAt(i, j), tint = GRASS_TINT[b]
      if (!tint || !isGrassy(b) || level(i, j) <= I.sea) continue
      const y = level(i, j) * LH
      const n = Math.round((b === BIOME.dry ? 10 : 24) * density)
      for (let k = 0; k < n; k++) {
        const r1 = rand2(i * 31 + k, j, seed + 7), r2 = rand2(j * 17 + k, i, seed + 9), r3 = rand2(k, i + j * 7, seed + 11)
        const flower = b === BIOME.meadow && r3 < .06
        const c = flower ? FLOWER[Math.floor(r3 * 1000) % FLOWER.length] : cmul(tint, .8 + r3 * .4)
        const h = flower ? .26 + r2 * .08 : (.12 + r1 * .16) * (b === BIOME.forest ? 1.3 : 1)
        out.push(i + .1 + r1 * .8, y, j + .1 + r2 * .8, h, c[0], c[1], c[2], (flower ? 1 : 0) + r2 * .999)
      }
    }
  }
  grassData = new Float32Array(out)
  gl.bindBuffer(gl.ARRAY_BUFFER, G_.grass.ib)
  gl.bufferData(gl.ARRAY_BUFFER, grassData, gl.STATIC_DRAW)
  G_.grass.count = out.length / 8
}

// ------------------------------------------------------------------ quality

const showQuality = () => {
  const b = $('qualityBtn')
  if (b) b.textContent = Q.mode === 'auto' ? `Auto · ${QL().name}` : QL().name
  const f = $('focusBtn')
  if (f) f.classList.toggle('on', focusOn)
  const a = $('airBtn')
  if (a) a.classList.toggle('on', airOn)
}
const setLevel = l => { Q.level = clamp(l, 0, 2); T.w = 0; if (I) buildGrass(true); showQuality() }
// Once a second: on Auto, a slow stretch steps the level down; a long smooth
// one tries the next up, and steps straight back if that proves too much.
const tuneQuality = raw => {
  if (raw > .25) return
  Q.timer += raw; Q.frames++
  if (Q.timer < 1) return
  const fps = Q.frames / Q.timer
  Q.timer = 0; Q.frames = 0; Q.fps = fps
  if (Q.mode !== 'auto') return
  const t = performance.now() / 1000
  if (fps < 42) { Q.slow++; Q.fast = 0 } else if (fps > 56) { Q.fast++; Q.slow = 0 } else { Q.slow = 0; Q.fast = 0 }
  if (Q.slow >= 2 && Q.level > 0) { const tried = t < Q.probation; setLevel(Q.level - 1); Q.lockUntil = t + (tried ? 180 : 30); Q.slow = 0 }
  else if (Q.fast >= 10 && Q.level < 2 && t > Q.lockUntil) { setLevel(Q.level + 1); Q.probation = t + 8; Q.fast = 0 }
}
const cycleQuality = () => {
  const order = ['auto', '2', '1', '0']
  Q.mode = order[(order.indexOf(Q.mode) + 1) % order.length]
  store('terrarium.quality', Q.mode)
  setLevel(Q.mode === 'auto' ? 2 : Number(Q.mode))
}
const toggleFocus = () => { focusOn = !focusOn; store('terrarium.focus', focusOn ? 'on' : 'off'); showQuality() }
const toggleAir = () => { airOn = !airOn; store('terrarium.air', airOn ? 'on' : 'off'); showQuality() }

// ------------------------------------------------------------------ a mirror for the side pane, and a photo for Blender

// While this window is open and in view, a small picture of it goes to the
// side pane every few seconds, with where each thing is so hovering still tells.
const mirrorCanvas = document.createElement('canvas')
mirrorCanvas.width = 760; mirrorCanvas.height = 540
let mirrorAt = -99
const maybeMirror = VP => {
  if (!D.mirror || document.visibilityState !== 'visible' || now - mirrorAt < 4) return
  mirrorAt = now
  const want = 760 / 540, W = canvas.width, H = canvas.height
  let sw = W, sh = H, sx = 0, sy = 0
  if (W / H > want) { sw = H * want; sx = (W - sw) / 2 } else { sh = W / want; sy = (H - sh) / 2 }
  mirrorCanvas.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, 760, 540)
  let quality = .72, url = ''
  do { url = mirrorCanvas.toDataURL('image/jpeg', quality); quality -= .1 } while (url.length > 96000 && quality > .2)
  const labels = []
  for (const p of [...creaturePicks, ...picks]) {
    const s = M4.apply(VP, p.p)
    if (s[2] <= 0) continue
    const x = ((s[0] * .5 + .5) * W - sx) / sw * 760, y = ((1 - (s[1] * .5 + .5)) * H - sy) / sh * 540
    if (x < 0 || x > 760 || y < 0 || y > 540) continue
    labels.push([Math.round(x), Math.round(y), String(p.label).slice(0, 100)])
    if (labels.length >= 90) break
  }
  fetch('upload/mirror.json', { method: 'POST', body: JSON.stringify({ at: Date.now(), jpeg: url.slice(url.indexOf(',') + 1), labels }) }).catch(() => { })
}

// Each grass blade as three triangles, standing still, for the photo.
const grassTris = () => {
  const out = []
  const n = Math.min(grassData.length / 8, 20000)
  for (let k = 0; k < n; k++) {
    const o = k * 8, x = grassData[o], y = grassData[o + 1], z = grassData[o + 2], h = grassData[o + 3], turn = grassData[o + 7]
    const flower = turn >= 1, a = (turn % 1) * TAU, w = .04
    const sx = Math.cos(a), sz = Math.sin(a)
    const col = [grassData[o + 4], grassData[o + 5], grassData[o + 6]]
    const at = (bx, t) => { const ww = w * (flower && t > .4 ? 2.4 : 1) * (1 - t * .8); return [x + sx * bx * ww, y + t * h, z + sz * bx * ww] }
    const tint = t => (flower ? (t > .4 ? cmul(col, 1.25) : cmul([.16, .36, .1], mix(.5, 1, t))) : cmul(col, mix(.45, 1.15, t)))
    for (let v = 0; v < 18; v += 2) {
      const p = at(BLADE[v], BLADE[v + 1]), c = tint(BLADE[v + 1])
      out.push(p[0], p[1], p[2], -sz, .3, sx, c[0], c[1], c[2], 0, 0, MAT.plain)
    }
  }
  return new Float32Array(out)
}
// Asked for a photo: send the whole scene, as it stands, to be rendered in Blender.
let photoDone = 0
const maybePhoto = info => {
  const id = D.photo
  if (!id || id === photoDone) return
  photoDone = id
  // Rivers and falls go as water of their own (material 5); the sea Blender makes itself.
  const streams = []
  for (let k = 0; k < streamWater.length; k += 4) streams.push(streamWater[k], streamWater[k + 1], streamWater[k + 2], 0, 1, 0, .32, .6, .72, 0, 0, 5)
  const parts = [statData, fineData, dynData, grassTris(), new Float32Array(streams)]
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { all.set(p, at); at += p.length }
  // The turtle's hide and shell are drawn by the shader here; Blender gets plain colors for them.
  for (let k = 0; k < all.length; k += STRIDE) {
    const mat = all[k + 11]
    if (mat === MAT.hide) all.set(C('#4f4c2c'), k + 6)
    else if (mat === MAT.shell) all.set(cmul(C('#5a4626'), all[k + 6]), k + 6)
    if (mat === MAT.hide || mat === MAT.shell) all[k + 11] = MAT.plain
  }
  const scene = {
    id, stride: STRIDE,
    layout: ['px', 'py', 'pz', 'nx', 'ny', 'nz', 'r', 'g', 'b', 'emissive', 'sway', 'material'],
    camera: { eye: info.eye, target: info.target, focus: beastCrown || info.target, fovY: info.fov },
    sun: { dir: info.sunDir, color: info.warm, up: info.sunUp }, moon: { dir: info.moonDir }, night: info.night,
    sky: { zenith: info.zen, horizon: info.hor }, fog: info.fog, storm: info.storm,
    sea: { level: seaY(), radius: I.seaRadius, bottom: BOTTOM * LH, clarity: D.world.cache ?? .6 },
    // The island floats in space: no tank, the sun and moon as bodies near it, its air a dome over it.
    space: { sun: info.sunPos, moon: info.moonPos, air: [seaY(), I.seaRadius * AIR_WIDE, I.seaRadius * AIR_HIGH] },
  }
  notice('📷 Sending the scene to Blender…')
  fetch('upload/photo-scene.bin', { method: 'POST', body: all.buffer })
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return fetch('upload/photo-scene.json', { method: 'POST', body: JSON.stringify(scene) }) })
    .then(r => notice(r.ok ? '📷 Blender is rendering the photo; it opens when done.' : '📷 The photo could not be sent.'))
    .catch(() => notice('📷 The photo could not be sent.'))
}
let noticeTimer = 0
const notice = text => {
  let el = $('notice')
  if (!el) { el = document.createElement('div'); el.id = 'notice'; el.style.cssText = 'position:fixed;top:60px;right:14px;padding:8px 12px;border-radius:9px;background:#0b0f1cd9;border:1px solid #ffffff30;color:#ffe3c2;font:600 13px ui-sans-serif,system-ui;z-index:9'; document.body.appendChild(el) }
  el.textContent = text; el.style.display = 'block'
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el.style.display = 'none' }, 6000)
}

// ------------------------------------------------------------------ sound

// Sounds play here in step with what moves: the creature's feet, its
// tentacles, the weather. The clips are the mod's own (sounds.js, made by
// scripts/make_sounds.py); the beds beneath them (rain, sea, wind, crickets)
// are made live. A browser plays nothing before the first click or key; the
// 🔊 button (or M) mutes, and so does the side pane's.
const Snd = { ctx: null, master: null, buffers: {}, on: stored('terrarium.sound', 'on') !== 'off', beds: null, last: {} }
let lastVP = null      // this frame's view, to place each sound left or right
let shake = 0          // how hard the ground shakes the camera
let flashCol = [1, 1, 1]
const VOLUME = .7

const makeBeds = ctx => {
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
  const nd = noiseBuf.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
  const hiss = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s }
  const filter = (type, f, q = .7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b }
  const lfo = (hz, depth, into, type = 'sine') => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz; const g = ctx.createGain(); g.gain.value = depth; o.connect(g).connect(into); o.start() }
  const bed = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(Snd.master); return g }
  const rain = bed(), waves = bed(), wind = bed(), crickets = bed()
  hiss().connect(filter('highpass', 900)).connect(filter('lowpass', 7000)).connect(rain)
  const swell = ctx.createGain(); swell.gain.value = .6
  lfo(.13, .4, swell.gain)
  hiss().connect(filter('lowpass', 420)).connect(swell).connect(waves)
  const gust = filter('bandpass', 420, .8)
  lfo(.07, 180, gust.frequency)
  hiss().connect(gust).connect(wind)
  // Crickets: a high note gated fast (the trill) and slow (the pauses).
  const song = ctx.createOscillator(); song.frequency.value = 4700; song.start()
  const trill = ctx.createGain(); trill.gain.value = .5; lfo(28, .5, trill.gain, 'square')
  const phrase = ctx.createGain(); phrase.gain.value = .5; lfo(.65, .5, phrase.gain, 'square')
  song.connect(trill).connect(phrase).connect(crickets)
  // The rim's fall: a low, steady roar with a slow surge in it.
  const falls = bed(), surge = ctx.createGain(); surge.gain.value = .75
  lfo(.05, .25, surge.gain)
  hiss().connect(filter('bandpass', 260, .5)).connect(filter('lowpass', 900)).connect(surge).connect(falls)
  return { rain, waves, wind, crickets, falls }
}

const unlockSound = () => {
  if (!Snd.ctx) {
    try {
      const ctx = new AudioContext()
      Snd.ctx = ctx
      const limit = ctx.createDynamicsCompressor()
      limit.threshold.value = -14; limit.ratio.value = 4
      Snd.master = ctx.createGain()
      Snd.master.gain.value = Snd.on ? VOLUME : 0
      Snd.master.connect(limit).connect(ctx.destination)
      for (const [name, b64] of Object.entries(window.__sounds || {})) {
        const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))
        ctx.decodeAudioData(bytes.buffer).then(buf => { Snd.buffers[name] = buf }).catch(() => { })
      }
      Snd.beds = makeBeds(ctx)
      ctx.onstatechange = () => showSound()
    } catch { return }
  }
  if (Snd.ctx.state === 'suspended') Snd.ctx.resume().catch(() => { })
  showSound()
}
// Any click or key wakes the sound, except the sound switch itself, which decides for itself.
addEventListener('pointerdown', e => { if (!(e.target instanceof Element && e.target.closest('#soundBtn'))) unlockSound() })
addEventListener('keydown', e => { if (e.key !== 'm') unlockSound() })

// Nearer is louder; left of the screen sounds to the left.
const hear = p => {
  if (!p || !camEye) return { gain: 1, pan: 0 }
  const d = Math.hypot(p[0] - camEye[0], p[1] - camEye[1], p[2] - camEye[2])
  const s = lastVP ? M4.apply(lastVP, p) : [0, 0, 1]
  return { gain: clamp(16 / (6 + d), .12, 1.1), pan: s[2] > 0 ? clamp(s[0] * .85, -.9, .9) : 0 }
}
const play = (name, { at, gain = 1, rate = 1, delay = 0, gap = 0 } = {}) => {
  const ctx = Snd.ctx
  if (!Snd.on || !ctx || ctx.state !== 'running' || !Snd.buffers[name]) return
  if (gap && ctx.currentTime - (Snd.last[name] ?? -9) < gap) return
  Snd.last[name] = ctx.currentTime
  const h = hear(at)
  const src = ctx.createBufferSource()
  src.buffer = Snd.buffers[name]
  src.playbackRate.value = rate * rnd(.93, 1.07)
  const g = ctx.createGain(); g.gain.value = gain * h.gain
  const pan = ctx.createStereoPanner(); pan.pan.value = h.pan
  src.connect(g).connect(pan).connect(Snd.master)
  src.start(ctx.currentTime + delay)
}
// The beds follow the weather: rain with the context, the sea with memory,
// wind with haste and storm, crickets on a clear, curious night, the rim's
// fall with its spray (the context again).
const tuneBeds = ({ rain, sea, wind, crickets, falls }) => {
  if (!Snd.beds || !Snd.ctx) return
  const t = Snd.ctx.currentTime, b = Snd.beds
  b.rain.gain.setTargetAtTime(rain * .3, t, .6)
  b.waves.gain.setTargetAtTime(sea, t, .8)
  b.wind.gain.setTargetAtTime(wind, t, .8)
  b.crickets.gain.setTargetAtTime(crickets, t, 1.5)
  b.falls.gain.setTargetAtTime(falls, t, 1.2)
}

let mutedSeen = null  // the side pane's choice, as last read from a frame
const showSound = () => {
  const b = $('soundBtn')
  if (!b) return
  b.textContent = !Snd.on ? '🔇 Muted' : Snd.ctx && Snd.ctx.state === 'running' ? '🔊 Sound' : '🔊 Click for sound'
  b.classList.toggle('on', Snd.on)
}
const setSound = (on, tell) => {
  Snd.on = on
  store('terrarium.sound', on ? 'on' : 'off')
  if (Snd.master) Snd.master.gain.setTargetAtTime(on ? VOLUME : 0, Snd.ctx.currentTime, .05)
  showSound()
  // Tell the mod, so the side pane's toggle says the same.
  if (tell) fetch('upload/sound.json', { method: 'POST', body: JSON.stringify({ muted: !on, at: Date.now() }) }).catch(() => { })
}
const toggleSound = () => {
  const locked = !Snd.ctx || Snd.ctx.state !== 'running'
  unlockSound()
  if (!(locked && Snd.on)) setSound(!Snd.on, true)
}

// ------------------------------------------------------------------ frame

let now = 0, last = performance.now()
const pointData = { add: [], alpha: [], cloud: [] }
// Occlusion samples: a hemisphere about the surface, crowded near it.
const SSAO_KERNEL = new Float32Array(Array.from({ length: 16 }, (_, k) => {
  const v = norm([rand2(k, 1, 77) * 2 - 1, rand2(k, 2, 77) * 2 - 1, .15 + rand2(k, 3, 77) * .85])
  return scl(v, mix(.15, 1, (k / 16) ** 2) * (.4 + rand2(k, 4, 77) * .6))
}).flat())
const cloudOff = [0, 0]  // how far the cloud shadows have drifted
const trail = new Float32Array(48)  // footprints for the grass: x, z, strength, radius
let meteor = null  // a shooting star: from, to, when
const shootingStar = () => {
  const a = rnd(0, TAU), e = rnd(.45, .85)
  const from = norm([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)])
  const to = norm([Math.cos(a + .55) * Math.cos(e - .32), Math.sin(e - .32), Math.sin(a + .55) * Math.cos(e - .32)])
  meteor = { a: from, b: to, t0: now }
  play('whoosh', { gain: .3 })
}

const render = () => {
  requestAnimationFrame(render)
  if (!D || !ok) return
  resize()
  const t1 = performance.now(), dt = Math.min(.05, (t1 - last) / 1000)
  tuneQuality((t1 - last) / 1000)
  last = t1; now += dt

  // weather eases toward what the words said, and toward what the machine reads
  const goal = D.world.mood
  for (const k of ['joy', 'storm', 'wonder', 'haste']) mood[k] = mix(mood[k], goal[k] || 0, Math.min(1, dt * .6))
  const sys = D.world.system || {}
  // Rain from 70% of the context, a downpour by 95%.
  machine.rain = mix(machine.rain, clamp((D.world.tide - 70) / 25, 0, 1), Math.min(1, dt * .5))
  machine.cpu = mix(machine.cpu, sys.cpu ?? .25, Math.min(1, dt * .5))
  machine.ram = mix(machine.ram, sys.ram ?? .4, Math.min(1, dt * .5))
  const rain = machine.rain
  const storm = Math.max(mood.storm, rain * .85)
  const isAway = D.world.awaySince !== undefined
  tags.length = 0

  // The sun rides the session limit, the moon the weekly one: risen at none used, set when it runs out.
  // Each rides an arc from the eastern horizon (0% used) over the island to
  // the western one (100%); past it, below. The sky's colors follow the sun.
  const arcDir = (p, tilt = 0) => {
    const az = p * Math.PI + tilt
    const el = Math.sin(clamp(p, 0, 1) * Math.PI) * 1.0 - Math.max(0, p - 1) * 1.5
    return norm([Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)])
  }
  const d = new Date()
  const clock = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
  const sunP = sys.limit !== undefined ? sys.limit / 100 : null
  const moonP = sys.weekLimit !== undefined ? sys.weekLimit / 100 : null
  const hour = sunP !== null ? 6 + clamp(sunP, 0, 1.2) * 13 : clock
  const sunDir = sunP !== null ? arcDir(sunP) : arcDir(clamp((clock - 6) / 13, -.3, 1.4))
  const moonDir = moonP !== null
    ? (() => { const m = arcDir(moonP, .35); return norm([m[0], Math.max(.03, m[1]), m[2]]) })()
    : norm([-sunDir[0], Math.max(.35, -sunDir[1]), -sunDir[2]])
  gauges(sunP, moonP)
  const sunUp = sstep(-.06, .18, sunDir[1])
  const night = 1 - sstep(-.16, .1, sunDir[1])
  const lightDir = sunUp > .02 ? norm([sunDir[0], Math.max(sunDir[1], .08), sunDir[2]]) : norm([moonDir[0], Math.max(moonDir[1], .2), moonDir[2]])
  const warm = cmix(C('#ff9c5a'), C('#fff1dc'), sstep(.0, .45, sunDir[1]))
  const lightCol = sunUp > .02 ? cmul(warm, (1.3 * sunUp) * (1 - storm * .72)) : cmul(C('#8fa6e6'), .32 * (1 - storm * .6))
  let [zen, hor] = skyAt(hour)
  const grey = C('#3d434f')
  zen = cmix(zen, cmul(grey, .5 + sunUp * .6), storm * .75); hor = cmix(hor, cmul(grey, .6 + sunUp * .7), storm * .7)
  if ((rain > .7 || mood.storm > .62) && Math.random() < dt * .35 * Math.max(rain, mood.storm)) { flash = 1; flashCol = [1, 1, 1]; play('thunder', { gain: .6 + rnd(0, .3), delay: rnd(.2, 1.4) }) }
  flash = Math.max(0, flash - dt * 3.2)
  const fogCol = cmul(cmix(hor, zen, .35), .85)
  const fog = .0035 + storm * .02 + (isAway ? .018 : 0)
  const wind = .7 + mood.haste * 2 + storm * 1.4
  // The rim's spray: as thick as the context is full (where the glass once fogged).
  const spray = clamp(D.world.tide / 100, 0, 1)
  tuneBeds({ rain, sea: (.035 + machine.ram * .09) * (isAway ? .5 : 1), wind: clamp(mood.haste * .12 + storm * .2, 0, .3), crickets: night * clamp(.3 + mood.wonder, 0, 1) * .022 * (1 - rain), falls: .012 + spray * .05 })
  // Birds call now and then by day.
  if (sunUp > .4 && storm < .3 && flock.length && Math.random() < dt / 9) {
    const bird = flock[Math.floor(Math.random() * flock.length)]
    play('chirp', { at: [Math.cos(bird.a) * bird.r, bird.h, Math.sin(bird.a) * bird.r], gain: .22, rate: rnd(.9, 1.25) })
  }

  // camera
  cam.idle += dt
  if (cam.orbit && cam.idle > 4 && !drag) {
    cam.tYaw += dt * .045
    // Out by the turtle, the view rises and dips a little as it circles.
    if (cam.tY < 0) cam.tPitch = .16 + .12 * Math.sin(now * .07)
  }
  cam.intro = Math.max(0, cam.intro - dt * .4)
  const ease = 1 - Math.pow(cam.intro, 3)
  cam.yaw = mix(cam.yaw, cam.tYaw, Math.min(1, dt * 5))
  cam.pitch = mix(cam.pitch, cam.tPitch, Math.min(1, dt * 5))
  cam.dist = mix(cam.dist, cam.tDist, Math.min(1, dt * 4))
  cam.x = mix(cam.x, cam.tX, Math.min(1, dt * 8)); cam.z = mix(cam.z, cam.tZ, Math.min(1, dt * 8))
  cam.y = mix(cam.y, cam.tY, Math.min(1, dt * 3))
  const dist = cam.dist * mix(2.4, 1, ease), pitch = mix(1.2, cam.pitch, ease), yaw = cam.yaw - (1 - ease) * 1.2
  const target = [cam.x, cam.y, cam.z]
  const eye = [target[0] + Math.cos(pitch) * Math.sin(yaw) * dist, target[1] + Math.sin(pitch) * dist, target[2] + Math.cos(pitch) * Math.cos(yaw) * dist]
  lodEye = eye
  // Heavy steps and strikes shake the camera a moment.
  if (shake > .002) { for (let k = 0; k < 3; k++) eye[k] += rnd(-1, 1) * shake; shake *= Math.pow(.004, dt) } else shake = 0
  const aspect = T.w / T.h, fov = .62, tanFov = Math.tan(fov / 2)
  const proj = M4.perspective(fov, aspect, .1, 500)
  const view = M4.lookAt(eye, target, [0, 1, 0])
  const VP = M4.mul(proj, view)
  lastVP = VP
  const camF = norm(sub(target, eye)), camR = norm(cross(camF, [0, 1, 0])), camU = cross(camR, camF)
  camEye = eye; nightLevel = night
  camRay = { eye, F: camF, R: camR, U: camU, tan: tanFov, aspect }
  const sunPos = orbPos(sunDir), moonPos = orbPos(moonDir)
  skyTags(eye, sunPos, moonPos, sunP, moonP)

  // light's view for shadows
  const Rs = I.seaRadius + 2.5
  const lEye = scl(lightDir, 40)
  const lView = M4.lookAt(lEye, [0, 0, 0], Math.abs(lightDir[1]) > .98 ? [0, 0, 1] : [0, 1, 0])
  const LVP = M4.mul(M4.ortho(-Rs, Rs, -Rs, Rs, 5, 90), lView)

  // grow the newly born
  let anyDone = false
  for (const [id, t0] of born) if (now - t0 >= GROW) { born.delete(id); anyDone = true }
  if (anyDone) rebuild()

  // simulate
  creaturePicks.length = 0; glows.length = 0
  const m = new Mesh()
  dyn.m = m
  for (const f of D.world.features) {
    const t0 = born.get(f.id)
    if (t0 === undefined) continue
    const u = clamp((now - t0) / GROW, 0, 1)
    const back = 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2)
    structure(m, f, Math.max(.01, back), false)
  }
  for (const b of blades) {
    const a = now * b.speed * (1 + mood.haste)
    m.put(UNIT.ico0, { x: b.hub[0], y: b.hub[1] - .05, z: b.hub[2], sx: .1, sy: .1, sz: .1, ry: b.ry }, C('#4a3328'))
    for (let q = 0; q < 4; q++) m.put(UNIT.cube, { x: b.hub[0], y: b.hub[1], z: b.hub[2], sx: .09 * b.k, sy: .62 * b.k, sz: .015, ry: b.ry, rz: a + q * Math.PI / 2 }, C('#f6f1e8'))
  }
  for (const f of flags) {
    const n = 5, len = .5 * f.k, c = Math.cos(f.ry), s = Math.sin(f.ry)
    for (let q = 0; q < n; q++) {
      const u0 = q / n, u1 = (q + 1) / n
      const w0 = Math.sin(now * (4 + mood.haste * 5) - u0 * 5) * .06 * u0, w1 = Math.sin(now * (4 + mood.haste * 5) - u1 * 5) * .06 * u1
      const pt = (u, w, dy) => [f.top[0] + (u * len) * c + w * s, f.top[1] + dy, f.top[2] - (u * len) * s + w * c]
      m.sheet(pt(u0, w0, 0), pt(u1, w1, 0), pt(u1, w1, -.28 * f.k), pt(u0, w0, -.28 * f.k), C('#d97757'))
    }
  }
  for (const [k, c] of creatures.entries()) {
    if (!isAway) c.update(dt)
    else if (Math.random() < dt * .25) spawn({ p: [c.x, c.y + .4, c.z], v: [.05, .25, 0], life: 2.4, size: .14, c: [.92, .95, 1], a: .7, add: true })
    drawWalker(m, c, now)
    creaturePicks.push({ p: [c.x, c.y + .35, c.z], label: c.label })
    const errs = D.world.errors
    tags.push({ p: [c.x, c.y + .5, c.z], group: 'wildlife', key: `walker:${k}`, text: c.kind === 'bug' ? `🐞 ${errs} failed ${errs === 1 ? 'call' : 'calls'}` : c.kind === 'deer' ? '🦌 deer' : '🐇 rabbit', rank: c.kind === 'bug' ? .25 : .1, dim: true })
  }
  drawFolk(m, now)
  drawBeast(m, dt)
  drawEffects(m)
  drawMachine(m)
  drawGiants(m, dt, isAway)
  drawBirds(m, now, night > .5)
  drawFish(m, dt)
  drawSerpent(m, now, dt)
  drawTurtle(m, dt, isAway)
  drawOrbs(m, sunDir, moonDir, warm, night)
  // Spray off the rim, drifting out into space.
  turtle.spray += dt * (4 + spray * 46)
  while (turtle.spray >= 1) {
    turtle.spray -= 1
    const a = rnd(0, TAU), r = I.seaRadius + rnd(.35, .9), y = seaY() - RIM_FALL * rnd(.45, 1)
    spawn({ p: [Math.cos(a) * r, y, Math.sin(a) * r], v: [Math.cos(a) * rnd(.05, .22), rnd(-.3, -.05), Math.sin(a) * rnd(.05, .22)], life: rnd(2, 3.5), size: rnd(.45, 1) * (.7 + spray * .6), grow: .6, c: [.86, .92, 1], a: .08 + spray * .2, drag: .3 })
  }
  butterflies.length =mood.joy > .3 && sunUp > .3 && storm < .5 ? Math.min(butterflies.length, 12) : 0
  if (mood.joy > .3 && sunUp > .3 && storm < .5) {
    const want = Math.round(mood.joy * 12)
    while (butterflies.length < want) {
      const a = rnd(0, TAU), r = rnd(1, I.R * .8)
      butterflies.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, home: [Math.cos(a) * r, Math.sin(a) * r], heading: 0, ph: rnd(0, 9), c: hsl([45, 330, 200, 280, 20][butterflies.length % 5], .8, .6) })
    }
  }
  drawButterflies(m, now, dt)
  for (const l of D.world.lanterns) {
    // One seen for the first time (after the page opened) rises from the creature.
    if (!lanternBorn.has(l.id)) lanternBorn.set(l.id, { at: lanternsSeen ? now : -99, from: lanternsSeen && beastCrown ? [...beastCrown] : null })
    const [lx, y, lz] = lanternAt(l)
    m.put(UNIT.cube, { x: lx, y, z: lz, sx: .14, sy: .2, sz: .14, ry: l.id }, C('#ffcf7a'), 2.2)
    glows.push([lx, y + .1, lz, 1, 1, .62, .28, .42])
    creaturePicks.push({ p: [lx, y + .2, lz], label: `Idea · turn ${l.turn}: ${l.text}` })
    tags.push({ p: [lx, y + .45, lz], group: 'ideas', key: `lantern:${l.id}`, text: `💡 ${clipText(l.text, 40)}`, sub: `turn ${l.turn}`, rank: .3 + (l.turn === D.world.turn ? .2 : 0), live: l.turn === D.world.turn })
  }
  lanternsSeen = true
  // Rain lands: little splashes on the ground and the water.
  if (rain > .05) {
    let n = rain * dt * 90
    while (n > 0) {
      if (n < 1 && Math.random() > n) break
      n -= 1
      const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * I.seaRadius * .95
      const x = Math.cos(a) * r, z = Math.sin(a) * r, y = Math.max(groundY(x, z), seaY()) + .02
      for (let k = 0; k < 3; k++) spawn({ p: [x, y, z], v: [rnd(-.25, .25), rnd(.5, .9), rnd(-.25, .25)], life: rnd(.2, .35), size: .045, c: [.85, .92, 1], a: .7, buoy: -6 })
    }
  }
  // Now and then on a clear, curious night, a shooting star.
  if (night > .6 && mood.wonder > .2 && storm < .4 && (!meteor || now - meteor.t0 > 8) && Math.random() < dt / 45) shootingStar()
  emitAll(dt)
  stepParticles(dt)
  dynData = new Float32Array(m.d)
  upload(G_.dyn, dynData)

  // ---- shadow pass
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.f)
  gl.viewport(0, 0, SHADOW, SHADOW)
  gl.clear(gl.DEPTH_BUFFER_BIT)
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND)
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4)
  gl.disable(gl.CULL_FACE)
  gl.useProgram(P.depth.p)
  gl.uniformMatrix4fv(P.depth.u.uLVP, false, LVP)
  gl.uniform1f(P.depth.u.uTime, now); gl.uniform1f(P.depth.u.uWind, wind)
  drawWorld()
  gl.disable(gl.POLYGON_OFFSET_FILL)

  const q = QL()
  const tanY = Math.tan(fov / 2)
  const useG = floatOk && (q.ssao > 0 || q.rays > 0 || (q.dof && focusOn))
  const post = (prog, fbo, w, h, binds, set) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h)
    gl.useProgram(prog.p)
    binds.forEach(([name, t], k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[name], k) })
    if (set) set(prog.u)
    gl.bindVertexArray(G_.empty); gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // ---- pre-pass: each pixel's facing and distance, at half size
  if (useG) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.gF); gl.viewport(0, 0, T.hw, T.hh)
    gl.clearColor(.5, .5, 1, 1000); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.clearColor(0, 0, 0, 1)
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK)
    gl.useProgram(P.gbuf.p)
    gl.uniformMatrix4fv(P.gbuf.u.uVP, false, VP); gl.uniformMatrix4fv(P.gbuf.u.uV, false, view)
    gl.uniform1f(P.gbuf.u.uTime, now); gl.uniform1f(P.gbuf.u.uWind, wind)
    drawWorld()
  }
  // ---- ambient occlusion: soft shadow in every crease and under every eave
  const aoOn = useG && q.ssao > 0
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE)
  if (aoOn) {
    post(P.ssao, T.aoF, T.hw, T.hh, [['uG', T.g]], u => { gl.uniform2f(u.uTanXY, tanY * aspect, tanY); gl.uniform3fv(u.uK, SSAO_KERNEL); gl.uniform1i(u.uN, q.ssao); gl.uniform1f(u.uRadius, .55) })
    post(P.aoblur, T.ao2F, T.hw, T.hh, [['uTex', T.ao], ['uG', T.g]], u => gl.uniform2f(u.uDir, 1 / T.hw, 0))
    post(P.aoblur, T.aoF, T.hw, T.hh, [['uTex', T.ao2], ['uG', T.g]], u => gl.uniform2f(u.uDir, 0, 1 / T.hh))
  }

  const sea = seaY()
  const wet = rain
  const skyAmb = cmul(cmix(zen, hor, .45), .4 + sunUp * .14), groundAmb = cmul(C('#3b3026'), .5 + sunUp * .4)
  // The sun gone round beneath the disc lights the turtle's belly and the rock from below.
  const underCol = cmul(warm, 1.1 * clamp(-sunDir[1] / .3, 0, 1) * (1 - storm * .5))
  // The turtle's shell for the shader: its frame and size, its age, its rings; and the falls' light on it, brighter with thicker spray.
  const shellNow = shellOf(), shellAge = D.world.startedAt ? clamp((Date.now() - D.world.startedAt) / 3.6e6 / 8, 0, 1) : 0
  const fallCol = cmul([.6, .75, .9], (.06 + .22 * spray) * (.3 + .7 * sunUp))
  cloudOff[0] += dt * .012 * (1 + mood.haste * 3); cloudOff[1] += dt * .004
  const mk = meteor && (now - meteor.t0) / 1.6 < 1 ? (now - meteor.t0) / 1.6 : 0
  airK = mix(airK, airOn ? 1 : 0, Math.min(1, dt * 4))
  const drawSky = flip => {
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false)
    gl.useProgram(P.sky.p)
    const su = P.sky.u
    gl.uniform3fv(su.uR, camR); gl.uniform3fv(su.uU, camU); gl.uniform3fv(su.uF, camF)
    gl.uniform1f(su.uTan, tanY); gl.uniform1f(su.uAspect, aspect)
    gl.uniform3fv(su.uZen, zen); gl.uniform3fv(su.uHor, hor); gl.uniform3fv(su.uSunPos, sunPos); gl.uniform3fv(su.uMoonPos, moonPos)
    gl.uniform3fv(su.uSunCol, warm); gl.uniform1f(su.uNight, night); gl.uniform1f(su.uTime, now); gl.uniform1f(su.uStorm, storm); gl.uniform1f(su.uCover, machine.cpu)
    gl.uniform1f(su.uJoy, Math.max(mood.joy, testsGreen() ? .9 : 0)); gl.uniform1f(su.uWonder, mood.wonder); gl.uniform1f(su.uWind, wind); gl.uniform1f(su.uSunUp, sunUp)
    gl.uniform1f(su.uFlip, flip); gl.uniform3fv(su.uEye, eye); gl.uniform1f(su.uSea, sea); gl.uniform1f(su.uAirOn, airK)
    gl.uniform4f(su.uAir, sea, I.seaRadius * AIR_WIDE, I.seaRadius * AIR_HIGH, sea)
    if (mk > 0) { gl.uniform4f(su.uMeteorA, ...meteor.a, mk); gl.uniform4f(su.uMeteorB, ...meteor.b, 0) } else gl.uniform4f(su.uMeteorA, 0, 1, 0, 0)
    gl.bindVertexArray(G_.empty); gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  const drawLit = (VPm, camPos, clipY, withAO) => {
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true)
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK)
    gl.useProgram(P.lit.p)
    const lu = P.lit.u
    gl.uniformMatrix4fv(lu.uVP, false, VPm); gl.uniformMatrix4fv(lu.uLVP, false, LVP)
    gl.uniform3fv(lu.uLightDir, lightDir); gl.uniform3fv(lu.uLightCol, lightCol)
    gl.uniform3fv(lu.uSkyAmb, skyAmb); gl.uniform3fv(lu.uGroundAmb, groundAmb)
    gl.uniform3fv(lu.uFogCol, fogCol); gl.uniform3fv(lu.uCam, camPos)
    gl.uniform1f(lu.uFog, fog); gl.uniform1f(lu.uNight, night); gl.uniform1f(lu.uTime, now); gl.uniform1f(lu.uWind, wind)
    gl.uniform1f(lu.uShadowOn, 1); gl.uniform1f(lu.uSea, sea); gl.uniform1f(lu.uClipY, clipY)
    gl.uniform1f(lu.uWet, wet); gl.uniform1f(lu.uCover, clamp(machine.cpu * 1.2, 0, 1)); gl.uniform2f(lu.uCloudOff, cloudOff[0], cloudOff[1])
    gl.uniform1f(lu.uCaustic, .35 + (D.world.cache ?? .6) * .9); gl.uniform1f(lu.uVein, Math.max(beast.vein, beast.flash))
    gl.uniform1f(lu.uAOOn, withAO ? 1 : 0); gl.uniform2f(lu.uRes, T.w, T.h)
    gl.uniform3fv(lu.uUnderDir, sunDir); gl.uniform3fv(lu.uUnderCol, underCol); gl.uniform1f(lu.uUnderY, discFoot() + .05)
    gl.uniform1f(lu.uRimR, I.seaRadius - .05); gl.uniform3fv(lu.uFallCol, fallCol); gl.uniform2f(lu.uFallR, I.seaRadius * .5, I.seaRadius * 1.05)
    gl.uniform2f(lu.uShellF, shellNow.f[0], shellNow.f[2]); gl.uniform4f(lu.uShellSz, shellNow.L, shellNow.W, shellNow.base, shellNow.H)
    gl.uniform1f(lu.uShellAge, shellAge); gl.uniform1f(lu.uShellRings, Math.min(6, D.world.compactions || 0)); gl.uniform2fv(lu.uScutes, SCUTES_FLAT)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadow.t); gl.uniform1i(lu.uShadow, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.ao); gl.uniform1i(lu.uAO, 1)
    drawWorld()
  }

  // ---- the water's mirror: the world above it, turned over
  const reflOn = q.refl > 0
  if (reflOn) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.reflF); gl.viewport(0, 0, T.rw, T.rh)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    drawSky(1)
    const mirror = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 2 * sea, 0, 1])
    gl.frontFace(gl.CW)
    drawLit(M4.mul(VP, mirror), [eye[0], 2 * sea - eye[1], eye[2]], sea - .02, false)
    gl.frontFace(gl.CCW)
  }

  // ---- scene
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.msaa)
  gl.viewport(0, 0, T.w, T.h)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  drawSky(0)
  drawLit(VP, eye, -1e9, aoOn)

  // Grass, pressed flat where the creature's feet came down.
  if (G_.grass.count > 0) {
    gl.disable(gl.CULL_FACE)
    gl.useProgram(P.grass.p)
    const gu = P.grass.u
    for (let k = 0; k < 12; k++) {
      const fp = footprints[footprints.length - 1 - k]
      const s = fp ? Math.max(0, 1 - (now - fp.at) / 25) : 0
      trail.set(fp ? [fp.x, fp.z, s, fp.r] : [0, 0, 0, 0], k * 4)
    }
    gl.uniformMatrix4fv(gu.uVP, false, VP); gl.uniformMatrix4fv(gu.uLVP, false, LVP)
    gl.uniform1f(gu.uTime, now); gl.uniform1f(gu.uWind, wind); gl.uniform4fv(gu.uTrail, trail)
    gl.uniform3fv(gu.uLightDir, lightDir); gl.uniform3fv(gu.uLightCol, lightCol); gl.uniform3fv(gu.uSkyAmb, skyAmb); gl.uniform3fv(gu.uGroundAmb, groundAmb)
    gl.uniform3fv(gu.uFogCol, fogCol); gl.uniform3fv(gu.uCam, eye); gl.uniform1f(gu.uFog, fog); gl.uniform1f(gu.uWet, wet)
    gl.uniform1f(gu.uAOOn, aoOn ? 1 : 0); gl.uniform2f(gu.uRes, T.w, T.h)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadow.t); gl.uniform1i(gu.uShadow, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.ao); gl.uniform1i(gu.uAO, 1)
    gl.bindVertexArray(G_.grass.a); gl.drawArraysInstanced(gl.TRIANGLES, 0, 9, G_.grass.count)
  }

  // What lies under the water, kept before the water is laid over it.
  const refrOn = q.refl > 0
  if (refrOn) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.msaa)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.sceneF)
    gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.msaa)
  }

  // ---- transparent: water and its falls, smoke, glows, rain, dust
  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.depthMask(false)
  gl.disable(gl.CULL_FACE)
  gl.useProgram(P.water.p)
  const wu = P.water.u
  gl.uniformMatrix4fv(wu.uVP, false, VP); gl.uniform3fv(wu.uCam, eye); gl.uniform3fv(wu.uLightDir, lightDir)
  gl.uniform3fv(wu.uLightCol, lightCol); gl.uniform3fv(wu.uZen, zen); gl.uniform3fv(wu.uHor, hor); gl.uniform3fv(wu.uFogCol, fogCol)
  gl.uniform1f(wu.uTime, now); gl.uniform1f(wu.uFog, fog); gl.uniform1f(wu.uNight, night); gl.uniform1f(wu.uWind, wind); gl.uniform1f(wu.uWave, .35 + machine.ram * 2.6); gl.uniform1f(wu.uClarity, D.world.cache ?? .6); gl.uniform1f(wu.uFlow, throughputOf().disk)
  gl.uniform1f(wu.uRain, rain); gl.uniform1f(wu.uReflOn, reflOn ? 1 : 0); gl.uniform1f(wu.uRefrOn, refrOn ? 1 : 0); gl.uniform2f(wu.uRes, T.w, T.h)
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.refl); gl.uniform1i(wu.uRefl, 0)
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.scene); gl.uniform1i(wu.uScene, 1)
  gl.bindVertexArray(G_.water.a); gl.drawArrays(gl.TRIANGLES, 0, G_.water.count)


  // points
  const A = pointData.alpha, Ad = pointData.add, Cl = pointData.cloud
  A.length = 0; Ad.length = 0; Cl.length = 0
  // Clouds: as many as the CPU is busy, darker as the rain sets in; each puff
  // shaded as a ball of vapour, bright on the sun's side.
  const cloudCol = cmix([1, 1, 1], [.55, .57, .62], storm)
  const shown = Math.round(clamp(machine.cpu, 0, 1) * clouds.length + rain * 3)
  let cpuAt = null
  for (let k = 0; k < Math.min(clouds.length, shown); k++) {
    const c = clouds[k]
    c.a += dt * .012 * (1 + mood.haste * 3)
    // The CPU's reading rides the cloud nearest you.
    const cc = [Math.cos(c.a) * c.r * I.seaRadius, c.h + .9 - storm * 1.2, Math.sin(c.a) * c.r * I.seaRadius]
    if (!cpuAt || Math.hypot(cc[0] - eye[0], cc[2] - eye[2]) < Math.hypot(cpuAt[0] - eye[0], cpuAt[2] - eye[2])) cpuAt = cc
    for (const [ox, oy, oz, s] of c.puffs) {
      const r = c.r * I.seaRadius
      const x = Math.cos(c.a) * r + ox * 1.6, z = Math.sin(c.a) * r + oz * 1.6
      Cl.push(x, c.h + oy - storm * 1.2, z, s * (1.6 + storm * .9), cloudCol[0], cloudCol[1], cloudCol[2], .55 + storm * .3)
    }
  }
  if (cpuAt && sys.cpu !== undefined) tags.push({ p: cpuAt, group: 'machine', key: 'cpu', text: `☁ CPU ${Math.round(sys.cpu * 100)}%`, rank: .3, live: true })
  // Away from the keyboard: mist settles low over the island.
  if (isAway) for (let k = 0; k < 16; k++) {
    const a = k * 2.4 + now * .02, r = (.2 + (k % 5) * .17) * I.R
    A.push(Math.cos(a) * r, sea + 1 + (k % 3) * .35, Math.sin(a) * r, 4.5, .9, .93, .97, .2)
  }
  for (const p of parts) {
    const u = p.age / p.life, a = p.a * (1 - u) * Math.min(1, p.age * 6)
    const s = p.size * (1 + p.grow * p.age)
    ;(p.add ? Ad : A).push(p.p[0], p.p[1], p.p[2], s, p.c[0], p.c[1], p.c[2], a)
  }
  for (const h of halos) {
    if (h.night && night < .05) continue
    const flick = .85 + .15 * Math.sin(now * 7 + h.p[0] * 3)
    Ad.push(h.p[0], h.p[1], h.p[2], h.s * .75, h.c[0], h.c[1], h.c[2], (h.night ? night : .45 + night * .45) * flick * .3)
  }
  // Glows are kept faint and tight: a hint of light, not a haze.
  for (const g of glows) Ad.push(g[0], g[1], g[2], g[3] * .8, g[4], g[5], g[6], g[7] * .55)
  if (mood.wonder > .25 && (night > .3 || sunUp < .5)) {
    const n = Math.round(mood.wonder * fireflies.length)
    for (let k = 0; k < n; k++) {
      const f = fireflies[k]
      f.a += dt * .1 * f.s
      const r = f.r * I.R, x = Math.cos(f.a) * r + Math.sin(now * f.s + f.ph) * .4, z = Math.sin(f.a) * r + Math.cos(now * f.s * 1.3 + f.ph) * .4
      const y = Math.max(groundY(x, z), sea) + f.h + Math.sin(now * 1.7 + f.ph) * .2
      Ad.push(x, y, z, .28, .85, 1, .45, (.5 + .5 * Math.sin(now * 3 + f.ph * 5)) * mood.wonder)
    }
  }
  gl.useProgram(P.point.p)
  const pu = P.point.u
  gl.uniformMatrix4fv(pu.uVP, false, VP)
  gl.uniform1f(pu.uScale, T.h / (2 * tanY))
  gl.uniform1f(pu.uLit, 0)
  if (Cl.length) {
    const sv = [view[0] * lightDir[0] + view[4] * lightDir[1] + view[8] * lightDir[2], view[1] * lightDir[0] + view[5] * lightDir[1] + view[9] * lightDir[2], view[2] * lightDir[0] + view[6] * lightDir[1] + view[10] * lightDir[2]]
    const lit = sunUp > .02 ? cmul(cmix(warm, [1, 1, 1], .35), (.55 + .95 * sunUp) * (1 - storm * .45)) : cmul(C('#9fb2e8'), .3)
    const shade = cmix(cmul(cmix(zen, hor, .55), .85 + sunUp * .2), [.3, .32, .38], storm * .7)
    upload(G_.cloud, Cl)
    gl.uniform1f(pu.uLit, 1); gl.uniform3fv(pu.uSunV, norm(sv)); gl.uniform3fv(pu.uSunC, lit); gl.uniform3fv(pu.uShadeC, shade)
    gl.uniform1f(pu.uAdd, 0); gl.uniform1f(pu.uSoft, 1.4)
    gl.bindVertexArray(G_.cloud.a); gl.drawArrays(gl.POINTS, 0, G_.cloud.count)
    gl.uniform1f(pu.uLit, 0)
  }
  if (A.length) {
    upload(G_.alpha, A)
    gl.uniform1f(pu.uAdd, 0); gl.uniform1f(pu.uSoft, 1.6)
    gl.bindVertexArray(G_.alpha.a); gl.drawArrays(gl.POINTS, 0, G_.alpha.count)
  }
  if (Ad.length) {
    upload(G_.add, Ad)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.uniform1f(pu.uAdd, 1); gl.uniform1f(pu.uSoft, 2.2)
    gl.bindVertexArray(G_.add.a); gl.drawArrays(gl.POINTS, 0, G_.add.count)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }
  // Rain: the context window. Dry below 70% full, a drizzle past it, a downpour
  // near the top; it falls on the disc, down to the sea. And the dust of space.
  const L = []
  if (rain > .01) {
    const drops = Math.round(60 + rain * 900), R2 = I.seaRadius * .98, fall = 8 - sea
    for (let k = 0; k < drops; k++) {
      const a = rand2(k, 1, 7) * TAU, r = Math.sqrt(rand2(k, 2, 7)) * R2, sp = 7 + rand2(k, 3, 7) * 3
      const x = Math.cos(a) * r, z = Math.sin(a) * r
      const y = 8 - ((now * sp + rand2(k, 4, 7) * 10) % fall)
      L.push(x, y, z, .75, .82, .95, .35, x - .05 * wind, y - .35, z, .75, .82, .95, 0)
    }
  }
  dustLines(L, dt)
  if (L.length) {
    upload(G_.lines, L)
    gl.useProgram(P.line.p); gl.uniformMatrix4fv(P.line.u.uVP, false, VP)
    gl.bindVertexArray(G_.lines.a); gl.drawArrays(gl.LINES, 0, G_.lines.count)
  }
  gl.depthMask(true); gl.disable(gl.BLEND)

  // ---- resolve, bloom, sun rays, focus, tone map and grade
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.msaa)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.sceneF)
  gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
  gl.disable(gl.DEPTH_TEST)
  post(P.bright, T.halfF, T.hw, T.hh, [['uTex', T.scene]])
  post(P.blur, T.qaF, T.qw, T.qh, [['uTex', T.half]], u => gl.uniform2f(u.uDir, 1 / T.hw, 0))
  post(P.blur, T.qbF, T.qw, T.qh, [['uTex', T.qa]], u => gl.uniform2f(u.uDir, 0, 1 / T.qh))
  post(P.blur, T.qaF, T.qw, T.qh, [['uTex', T.qb]], u => gl.uniform2f(u.uDir, 2 / T.qw, 0))
  post(P.blur, T.qbF, T.qw, T.qh, [['uTex', T.qa]], u => gl.uniform2f(u.uDir, 0, 2 / T.qh))
  // Sun rays: strongest when the sun is low, as the session's limit nears its end or its start.
  let rayK = 0, rayCol = warm
  if (useG && q.rays > 0) {
    const src = norm(sub(sunUp > .05 ? sunPos : moonPos, eye))
    const s = M4.apply(VP, sunUp > .05 ? sunPos : moonPos)
    if (s[2] > 0) {
      const facing = sstep(-.1, .6, dot(camF, src))
      rayK = sunUp > .05 ? sunUp * (.35 + .9 * (1 - sstep(.1, .55, sunDir[1]))) * (1 - storm * .75) * facing : night * .25 * facing * (1 - storm)
      rayCol = sunUp > .05 ? warm : C('#9fb2e8')
      if (rayK > .01) post(P.rays, T.raysF, T.hw, T.hh, [['uTex', T.scene], ['uG', T.g]], u => { gl.uniform2f(u.uSun, s[0] * .5 + .5, s[1] * .5 + .5); gl.uniform1i(u.uSteps, q.rays) })
    }
  }
  // Miniature focus: sharp where the creature is, soft before and behind.
  const dofOn = useG && q.dof && focusOn
  // Out by the turtle, its eye is what stays sharp.
  const focusP = (cam.tY < 0 && turtle.eye) || beastCrown || [0, .9, 0]
  const focus = Math.max(1, dot(sub(focusP, eye), camF))
  const fs = M4.apply(VP, focusP)
  if (dofOn) {
    post(P.blur, T.dhF, T.hw, T.hh, [['uTex', T.scene]], u => gl.uniform2f(u.uDir, 1 / T.w, 0))
    post(P.blur, T.daF, T.qw, T.qh, [['uTex', T.dh]], u => gl.uniform2f(u.uDir, 0, 1 / T.hh))
    post(P.blur, T.dbF, T.qw, T.qh, [['uTex', T.da]], u => gl.uniform2f(u.uDir, 1.2 / T.qw, 0))
    post(P.blur, T.daF, T.qw, T.qh, [['uTex', T.db]], u => gl.uniform2f(u.uDir, 0, 1.2 / T.qh))
  }
  // The grade follows the hour: golden as the sun nears the horizon, blue at night, grey in storms.
  const golden = sunUp * (1 - sstep(.08, .5, sunDir[1]))
  let gain = cmix([1, 1, 1], [1.07, .99, .86], golden)
  gain = cmix(gain, [.86, .93, 1.1], night * .8)
  gain = cmix(gain, [.95, .97, 1], storm * .6)
  const lift = [.018 * golden - .006 * night, .004 * golden, -.01 * golden + .02 * night]
  post(P.final, null, T.w, T.h, [['uTex', T.scene], ['uBloom', T.qb], ['uRays', T.rays], ['uBlur', T.da], ['uG', T.g]], u => {
    gl.uniform1f(u.uBloomK, .26 + night * .2); gl.uniform1f(u.uFlash, flash * .9); gl.uniform3fv(u.uFlashCol, flashCol); gl.uniform1f(u.uExposure, .92 + night * .35)
    gl.uniform1f(u.uRayK, rayK); gl.uniform3fv(u.uRayCol, rayCol)
    gl.uniform1f(u.uDof, dofOn ? 1 : 0); gl.uniform1f(u.uFocus, focus); gl.uniform1f(u.uFocusY, fs[2] > 0 ? fs[1] * .5 + .5 : .5)
    gl.uniform3fv(u.uGain, gain); gl.uniform3fv(u.uLift, lift)
    gl.uniform1f(u.uSat, clamp(1.08 + mood.joy * .12 - storm * .35 - night * .18, .5, 1.3)); gl.uniform1f(u.uVig, .28 + storm * .12 + night * .08)
  })
  gl.activeTexture(gl.TEXTURE0)

  maybeMirror(VP)
  maybePhoto({ eye, target, fov, sunDir, warm, sunUp, moonDir, night, zen, hor, fog, storm, sunPos, moonPos })

  drawTags(VP, eye)
  // ---- hover labels
  const tip = $('tip')
  if (mouse.x < 0 || drag) { tip.style.display = 'none'; return }
  let best = null, bestD = 30
  for (const list of [picks, creaturePicks]) for (const p of list) {
    const s = M4.apply(VP, p.p)
    if (s[2] <= 0) continue
    const sx = (s[0] * .5 + .5) * innerWidth, sy = (1 - (s[1] * .5 + .5)) * innerHeight
    const dd = Math.hypot(sx - mouse.x, sy - mouse.y)
    if (dd < bestD) { bestD = dd; best = p }
  }
  if (best) {
    tip.textContent = best.label
    tip.style.display = 'block'
    tip.style.left = `${Math.min(innerWidth - 360, mouse.x + 14)}px`
    tip.style.top = `${mouse.y + 14}px`
  } else tip.style.display = 'none'
}

// ------------------------------------------------------------------ data in

const apply = data => {
  // A newer engine was installed beside this page: take it up.
  if (window.__engine === undefined) window.__engine = data.engine
  else if (data.engine !== window.__engine) { location.reload(); return }
  if (data.version === version) return
  version = data.version
  const prev = new Set(D ? D.world.features.map(f => f.id) : [])
  D = data
  // The side pane's sound toggle, when it changes, wins.
  if (data.muted !== undefined && data.muted !== mutedSeen) { mutedSeen = data.muted; if (Snd.on === data.muted) setSound(!data.muted, false) }
  const isl = data.island
  I = { ...isl, levels: Int8Array.from(isl.levels), biome: Uint8Array.from(isl.biome), decor: Uint8Array.from(isl.decor) }
  document.getElementById('stats').textContent = data.stats
  document.getElementById('chronicle').replaceChildren(...data.chronicle.map(line => Object.assign(document.createElement('div'), { textContent: line })))
  wait.style.display = 'none'
  if (!ok) {
    fallback.style.display = 'flex'
    fallback.innerHTML = data.svg || ''
    return
  }
  if (!G_) { initBuffers(); initShadow() }
  if (!firstLoad) {
    for (const f of data.world.features) if (!prev.has(f.id)) {
      born.set(f.id, now)
      sparkleBurst([f.x + .5, level(f.x, f.y) * LH + .4, f.y + .5])
    }
  }
  if (firstLoad) { cam.tDist = cam.dist = I.seaRadius * 2.15; for (const k of Object.keys(mood)) mood[k] = data.world.mood[k] || 0 }
  firstLoad = false
  rebuild()
  populate()
}
window.__terrarium = apply

const poll = () => {
  const tag = document.createElement('script')
  tag.src = 'frame.js?' + Date.now()
  tag.onload = tag.onerror = () => tag.remove()
  document.head.appendChild(tag)
}
showQuality()
showSound()
if (!window.__terrariumNoPoll) { poll(); setInterval(poll, 1500) }
requestAnimationFrame(render)
})()
