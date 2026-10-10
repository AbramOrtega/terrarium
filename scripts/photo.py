"""Terrarium photo mode: render the viewer's island as a Cycles "postcard".

    blender -b --factory-startup -P scripts/photo.py -- path/to/scene.json

scene.json (written by the WebGL viewer) points at a flat little-endian float32
triangle soup plus camera, sun/moon, sky and sea parameters. The last line printed
is `PHOTO_DONE <png>` on success, or `PHOTO_FAILED <reason>` with exit status 1.

Conventions: the viewer is Y-up with +Z toward the viewer; Blender is Z-up, so
every point and direction maps (x, y, z) -> (x, -z, y). Colours are linear.
"""

import json
import math
import os
import sys
import time
import traceback

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

DEFAULT_LAYOUT = ["px", "py", "pz", "nx", "ny", "nz", "r", "g", "b", "emissive", "sway", "material"]

# Viewer material ids -> Principled settings. The island is split into one
# material slot per id so each shader stays branch-free.
SURFACES = [
    dict(name="Matte", roughness=0.72, specular=0.35),
    dict(name="Terrain", roughness=0.88, specular=0.25),
    # Creature skin: dark, wet and oily -> clear coat on top and a thin-film
    # layer for the rainbow sheen. Sheen stays low: on a near-black body it
    # turns into a bright rim that reads as a soap bubble.
    dict(name="Skin", roughness=0.38, specular=0.6, coat=0.55, coat_roughness=0.12,
         sheen=0.08, sheen_tint=(0.45, 0.6, 1.0), thin_film=True),
    dict(name="Glassy", roughness=0.08, specular=0.8, coat=0.5, coat_roughness=0.02),
]
# The viewer's material ids (MAT in engine.js) -> the slots above; 5, its
# rivers and falls, gets a slot of its own after them.
VIEWER_SLOT = np.array([0, 1, 1, 2, 3, len(SURFACES)], np.int32)  # plain, ground, cliff, skin, gloss, stream

# Engine constants mirrored so the photo matches the live view.
EMISSION_GAIN = 2.4       # the engine adds color * e * 2.4
LAVA_THRESHOLD = 4.5
LAVA_GLOW = (1.0, 0.32, 0.04)
SUN_STRENGTH = 4.1        # ~pi * 1.3: the engine's lightCol * diffuse, in Cycles units
MOON_STRENGTH = 1.0       # ~pi * 0.32
MOON_COLOR = (0.275, 0.381, 0.791)  # engine '#8fa6e6', linear
# Aperture radius as a fraction of the focus distance. Real optics at this
# scene scale would give no visible blur; this fakes a ~30 cm diorama shot
# with a macro lens (tilt-shift look) while keeping the island readable.
DOF_APERTURE = 0.01
# Share of the sky's brightness that lights the scene. The engine's ambient is
# about half its sky colour; at full strength Cycles' sky fill washes out the
# sun's shadows. Camera, mirror and refraction rays still see the full sky.
SKY_FILL = 0.55


def log(msg):
    print(f"[photo] {msg}", flush=True)


def gl_to_blender(v):
    return Vector((float(v[0]), -float(v[2]), float(v[1])))


def clamp01(x):
    return max(0.0, min(1.0, float(x)))


# ----------------------------------------------------------------- input

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        raise ValueError("usage: blender -b --factory-startup -P photo.py -- scene.json")
    return os.path.abspath(argv[0])


def load_config(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("mesh", "out", "camera"):
        if key not in cfg:
            raise ValueError(f"scene.json is missing '{key}'")
    # Relative paths are relative to the json; os.path.join leaves absolute
    # ones untouched, so PHOTO_DONE echoes the caller's own "out" string.
    base = os.path.dirname(path)
    cfg["mesh"] = os.path.join(base, cfg["mesh"])
    cfg["out"] = os.path.join(base, cfg["out"])
    return cfg


def load_vertices(cfg):
    """Return the vertex table (n x stride) and a column getter keyed by layout name."""
    layout = cfg.get("layout") or DEFAULT_LAYOUT
    stride = int(cfg.get("stride") or len(layout))
    raw = np.fromfile(cfg["mesh"], dtype="<f4")
    if raw.size == 0:
        raise ValueError(f"{cfg['mesh']} is empty")
    if raw.size % stride:
        raise ValueError(f"{cfg['mesh']}: {raw.size} floats is not a multiple of stride {stride}")
    verts = raw.reshape(-1, stride)
    if len(verts) % 3:
        raise ValueError(f"{len(verts)} vertices is not a whole number of triangles")
    # A single NaN would poison the BVH; zero it rather than fail the photo.
    verts = np.nan_to_num(verts, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    index = {name: i for i, name in enumerate(layout)}

    def column(name, default=0.0):
        if name in index and index[name] < stride:
            return verts[:, index[name]]
        return np.full(len(verts), default, np.float32)

    return len(verts), column


# ----------------------------------------------------------------- node helper

class Graph:
    """Thin wrapper so node trees read like expressions."""

    def __init__(self, tree):
        self.tree = tree
        tree.nodes.clear()

    def node(self, kind, inputs=None, **props):
        n = self.tree.nodes.new(kind)
        for key, value in props.items():
            setattr(n, key, value)
        for key, value in (inputs or {}).items():
            sock = self._input(n, key)
            if isinstance(value, bpy.types.NodeSocket):
                self.tree.links.new(value, sock)
            else:
                sock.default_value = rgba(value) if sock.type == "RGBA" else value
        return n

    def link(self, out, inp):
        self.tree.links.new(out, inp)

    @staticmethod
    def _input(n, key):
        if isinstance(key, int):
            return n.inputs[key]
        # Mix/Math nodes carry several same-named sockets; only one is enabled.
        for s in n.inputs:
            if s.name == key and s.enabled:
                return s
        raise KeyError(f"{n.bl_idname} has no input {key!r}")

    @staticmethod
    def out(n, name=None):
        if name is None:
            return next(s for s in n.outputs if s.enabled)
        return next(s for s in n.outputs if s.name == name and s.enabled)

    def math(self, op, a, b=0.0, c=0.0, clamp=False):
        return self.out(self.node("ShaderNodeMath", {0: a, 1: b, 2: c}, operation=op, use_clamp=clamp))


def rgba(c):
    c = tuple(c)
    return c if len(c) == 4 else (*c[:3], 1.0)


def add_fog(g, shader, fog):
    """Exponential distance fog on camera rays only (secondary rays stay clean)."""
    if fog["density"] <= 0:
        return shader
    dist = g.out(g.node("ShaderNodeCameraData"), "View Distance")
    transmit = g.math("EXPONENT", g.math("MULTIPLY", dist, -fog["density"]))
    amount = g.math("MULTIPLY", g.math("SUBTRACT", 1.0, transmit),
                    g.out(g.node("ShaderNodeLightPath"), "Is Camera Ray"))
    haze = g.node("ShaderNodeEmission", {"Color": fog["color"], "Strength": 1.0})
    mix = g.node("ShaderNodeMixShader", {0: amount, 1: shader, 2: g.out(haze)})
    return g.out(mix)


def shadow_pass_through(g, shader, tint=(1, 1, 1)):
    """Let shadow and diffuse rays pass a refractive surface untouched.

    Cycles can't find sun light through a sharp refractive surface (that is a
    caustic path), so without this the seabed and the tank interior would sit in
    black shadow. Treating those rays as transparent is the usual fake-caustic
    trick; volume absorption still tints the light that gets through.
    """
    lp = g.node("ShaderNodeLightPath")
    skip = g.math("MAXIMUM", g.out(lp, "Is Shadow Ray"), g.out(lp, "Is Diffuse Ray"))
    clear = g.node("ShaderNodeBsdfTransparent", {"Color": tint})
    return g.out(g.node("ShaderNodeMixShader", {0: skip, 1: shader, 2: g.out(clear)}))


# ----------------------------------------------------------------- materials

def island_material(spec, fog):
    mat = bpy.data.materials.new(spec["name"])
    g = Graph(mat.node_tree)
    col = g.out(g.node("ShaderNodeAttribute", attribute_type="GEOMETRY", attribute_name="Col"), "Color")
    glow_col = g.out(g.node("ShaderNodeAttribute", attribute_type="GEOMETRY", attribute_name="GlowCol"), "Color")
    glow = g.out(g.node("ShaderNodeAttribute", attribute_type="GEOMETRY", attribute_name="glow"), "Factor")
    bsdf = g.node("ShaderNodeBsdfPrincipled", {
        "Base Color": col,
        "Roughness": spec["roughness"],
        "Specular IOR Level": spec["specular"],
        "Coat Weight": spec.get("coat", 0.0),
        "Coat Roughness": spec.get("coat_roughness", 0.03),
        "Sheen Weight": spec.get("sheen", 0.0),
        "Sheen Tint": spec.get("sheen_tint", (1, 1, 1)),
        "Emission Color": glow_col,
        "Emission Strength": glow,
    })
    if spec.get("thin_film"):
        # Oil-slick iridescence: film thickness wanders across the body.
        coords = g.out(g.node("ShaderNodeTexCoord"), "Object")
        noise = g.node("ShaderNodeTexNoise", {"Vector": coords, "Scale": 2.5, "Detail": 2.0})
        film = g.node("ShaderNodeMapRange", {"Value": g.out(noise, "Factor"), "To Min": 250.0, "To Max": 750.0})
        g.link(g.out(film, "Result"), g._input(bsdf, "Thin Film Thickness"))
        g._input(bsdf, "Thin Film IOR").default_value = 1.45
    surface = add_fog(g, g.out(bsdf), fog)
    g.link(surface, g._input(g.node("ShaderNodeOutputMaterial"), "Surface"))
    return mat


def water_material(sea, storm, fog):
    mat = bpy.data.materials.new("Water")
    g = Graph(mat.node_tree)
    coords = g.out(g.node("ShaderNodeTexCoord"), "Object")
    waves = g.node("ShaderNodeTexNoise", {"Vector": coords, "Scale": 0.9, "Detail": 4.0, "Roughness": 0.55})
    bump = g.node("ShaderNodeBump", {"Height": g.out(waves, "Factor"),
                                     "Strength": 0.12 + 0.35 * storm, "Distance": 0.04})
    glass = g.node("ShaderNodeBsdfGlass", {"Color": (1, 1, 1), "IOR": 1.333,
                                           "Roughness": 0.015 + 0.05 * storm,
                                           "Normal": g.out(bump, "Normal")})
    surface = add_fog(g, shadow_pass_through(g, g.out(glass)), fog)

    # Absorption eats red first (clear water) and, when murky, blue too (olive).
    # A thin teal in-scatter gives the body of water its own lagoon colour, as
    # in the engine, instead of looking like clear glass over sand.
    clarity = clamp01(sea.get("clarity", 0.6))
    murk = 1.0 - clarity
    clear_tint, murky_tint = np.array([0.22, 0.70, 0.84]), np.array([0.45, 0.62, 0.40])
    tint = clear_tint + (murky_tint - clear_tint) * murk * 0.7
    absorb = g.node("ShaderNodeVolumeAbsorption", {"Color": tuple(tint), "Density": 1.0 + 0.8 * murk + 0.5 * storm})
    scatter = g.node("ShaderNodeVolumeScatter", {"Color": (0.30, 0.78, 0.82), "Density": 0.08 + 0.35 * murk,
                                                 "Anisotropy": 0.3})
    volume = g.node("ShaderNodeAddShader", {0: g.out(absorb), 1: g.out(scatter)})

    out = g.node("ShaderNodeOutputMaterial")
    g.link(surface, g._input(out, "Surface"))
    g.link(g.out(volume), g._input(out, "Volume"))
    return mat


def stream_material(storm, fog):
    """Rivers and waterfalls: open sheets of water, so a clear glossy skin with no volume behind it."""
    mat = bpy.data.materials.new("Stream")
    g = Graph(mat.node_tree)
    coords = g.out(g.node("ShaderNodeTexCoord"), "Object")
    ripples = g.node("ShaderNodeTexNoise", {"Vector": coords, "Scale": 2.5, "Detail": 3.0})
    bump = g.node("ShaderNodeBump", {"Height": g.out(ripples, "Factor"), "Strength": 0.2 + 0.3 * storm, "Distance": 0.03})
    bsdf = g.node("ShaderNodeBsdfPrincipled", {"Base Color": (0.32, 0.6, 0.72), "Roughness": 0.04,
                                                "Transmission Weight": 0.6, "IOR": 1.333,
                                                "Normal": g.out(bump, "Normal")})
    surface = add_fog(g, shadow_pass_through(g, g.out(bsdf)), fog)
    g.link(surface, g._input(g.node("ShaderNodeOutputMaterial"), "Surface"))
    return mat


def tank_glass_material():
    mat = bpy.data.materials.new("TankGlass")
    g = Graph(mat.node_tree)
    # Principled's "Thin Wall" models a single-sheet pane: reflections without
    # the refraction offset (and second surface) a solid shell would need.
    bsdf = g.node("ShaderNodeBsdfPrincipled", {
        "Base Color": (0.95, 0.99, 0.97), "Roughness": 0.03, "IOR": 1.5,
        "Transmission Weight": 1.0, "Thin Wall": True,
    })
    surface = shadow_pass_through(g, g.out(bsdf), tint=(0.97, 0.99, 0.98))
    g.link(surface, g._input(g.node("ShaderNodeOutputMaterial"), "Surface"))
    return mat


# ----------------------------------------------------------------- geometry

def build_island(count, column, night, materials):
    t0 = time.perf_counter()
    pos = np.empty((count, 3), np.float32)
    pos[:, 0], pos[:, 1], pos[:, 2] = column("px"), -column("pz"), column("py")

    # Non-indexed soup: corner i uses vertex i, triangle k starts at corner 3k.
    me = bpy.data.meshes.new("Island")
    me.vertices.add(count)
    me.vertices.foreach_set("co", pos.ravel())
    me.loops.add(count)
    me.loops.foreach_set("vertex_index", np.arange(count, dtype=np.int32))
    me.polygons.add(count // 3)
    me.polygons.foreach_set("loop_start", np.arange(0, count, 3, dtype=np.int32))
    ids = np.clip(np.rint(column("material")[0::3]), 0, len(VIEWER_SLOT) - 1).astype(np.int32)
    mat_id = VIEWER_SLOT[ids]
    me.polygons.foreach_set("material_index", mat_id)

    # FLOAT_COLOR attributes are stored linear, matching the viewer's colours.
    colors = np.ones((count, 4), np.float32)
    colors[:, 0], colors[:, 1], colors[:, 2] = column("r", 1.0), column("g", 1.0), column("b", 1.0)
    np.clip(colors, 0.0, None, out=colors)
    me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER").data.foreach_set("color", colors.ravel())

    # Emission strength per corner, following the engine's rules:
    # 0 < e < 4.5 glows always, e < 0 glows only at night, e >= 4.5 is lava.
    e = column("emissive")
    lava = e >= LAVA_THRESHOLD
    lava_pulse = 1.0 + 0.45 * np.sin(2.1 * column("px") + 1.7 * column("pz"))  # engine's pulse, frozen
    glow = np.where(lava, e * 1.4 * lava_pulse,
                    np.where(e > 0, e * EMISSION_GAIN, -e * night * EMISSION_GAIN))
    glow = np.maximum(glow, 0.0).astype(np.float32)
    me.attributes.new("glow", "FLOAT", "CORNER").data.foreach_set("value", glow)
    # Bright saturated red drifts to pink under a filmic curve; pull lava's glow
    # toward orange so it reads as molten rather than neon.
    glow_colors = colors.copy()
    glow_colors[lava, :3] = 0.4 * glow_colors[lava, :3] + 0.6 * np.array(LAVA_GLOW, np.float32)
    me.color_attributes.new("GlowCol", "FLOAT_COLOR", "CORNER").data.foreach_set("color", glow_colors.ravel())

    me.update(calc_edges=True)
    for mat in materials:
        me.materials.append(mat)
    obj = bpy.data.objects.new("Island", me)
    bpy.context.scene.collection.objects.link(obj)
    log(f"island: {count // 3} triangles, {int((glow > 0).sum() // 3)} glowing, "
        f"built in {time.perf_counter() - t0:.2f}s")
    return obj


def cylinder(name, radius, z0, z1, caps, segments=128):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, segments=segments, radius1=radius, radius2=radius,
                          depth=z1 - z0, matrix=Matrix.Translation((0, 0, (z0 + z1) / 2)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = abs(f.normal.z) < 0.5  # round walls, flat caps
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_tank(sea, storm, fog, glass=True):
    """Water body, and the old tank's glass wall. The island mesh already has
    the seabed and its rim (in space: the rock disc, its falls and the turtle)."""
    level, radius = float(sea["level"]), float(sea["radius"])
    bottom = float(sea.get("bottom", level - 3.0))
    if radius <= 0 or bottom >= level:
        log("sea: skipped (no depth)")
        return
    # A closed volume so absorption applies to everything below the surface.
    # Inset slightly from the glass and lifted off the plinth top to avoid
    # coincident faces.
    water = cylinder("Water", radius - 0.005, bottom + 0.01, level, caps=True)
    water.data.materials.append(water_material(sea, storm, fog))
    if not glass:
        return
    # The engine drew the glass wall up to the brass rim at level + 0.28.
    wall = cylinder("TankGlass", radius + 0.01, bottom, level + 0.28, caps=False, segments=192)
    wall.data.materials.append(tank_glass_material())


# ----------------------------------------------------------------- lighting

def add_sun(name, direction, color, strength, angle_deg):
    light = bpy.data.lights.new(name, "SUN")
    light.energy = strength
    light.color = color
    light.angle = math.radians(angle_deg)
    obj = bpy.data.objects.new(name, light)
    # A sun shines along its local -Z, so point +Z at the light source.
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(obj)


def lift(dir_gl, min_y):
    """The engine keeps lights a little above the horizon so shadows stay finite."""
    d = Vector((dir_gl[0], max(dir_gl[1], min_y), dir_gl[2])).normalized()
    return gl_to_blender(d).normalized()


def normalized_color(c):
    c = [max(0.0, float(x)) for x in c[:3]]
    peak = max(c) or 1.0
    return tuple(x / peak for x in c)


def build_lights(cfg, night, storm):
    sun = cfg.get("sun") or {}
    up = clamp01(sun.get("up", 1.0 - night))
    sun_power = SUN_STRENGTH * up * (1.0 - 0.72 * storm)
    if sun_power > 0.01 and "dir" in sun:
        add_sun("Sun", lift(sun["dir"], 0.08), normalized_color(sun.get("color", (1, 0.95, 0.85))), sun_power, 2.5)
    moon = cfg.get("moon") or {}
    moon_power = MOON_STRENGTH * night * (1.0 - 0.6 * storm)
    if moon_power > 0.01 and "dir" in moon:
        add_sun("Moon", lift(moon["dir"], 0.2), normalized_color(MOON_COLOR), moon_power, 1.5)
    log(f"lights: sun {sun_power:.2f}, moon {moon_power:.2f}")


def build_world(cfg, night, storm):
    """Sky gradient matching the engine's sky shader, plus sun/moon glow and stars.

    In space (the island on its turtle) the camera sees the dark and its stars
    all round, and the sun and moon are bodies in the mesh; the sky's colors
    still light the scene, as the air over the disc does in the engine."""
    space = bool(cfg.get("space"))
    sky = cfg.get("sky") or {}
    zen = np.array(sky.get("zenith", (0.16, 0.36, 0.78)), float)[:3]
    hor = np.array(sky.get("horizon", (0.62, 0.74, 0.88)), float)[:3]
    world = bpy.data.worlds.new("Sky")
    bpy.context.scene.world = world
    g = Graph(world.node_tree)

    # In a world shader, Generated coordinates are the ray direction.
    d = g.out(g.node("ShaderNodeVectorMath", {0: g.out(g.node("ShaderNodeTexCoord"), "Generated")},
                     operation="NORMALIZE"))
    z = g.out(g.node("ShaderNodeSeparateXYZ", {0: d}), "Z")

    # Engine: above the horizon mix(hor, zen, y^0.55); below it fades to hor*0.32.
    # A ramp over f = z*0.5+0.5 reproduces both curves without branching nodes.
    ramp = g.node("ShaderNodeValToRGB", {0: g.math("MULTIPLY_ADD", z, 0.5, 0.5)})
    stops = [(0.5 - s / 2, hor + (hor * 0.32 - hor) * min(s * 2.2, 1.0)) for s in (1.0, 1 / 2.2, 0.2)]
    stops += [(0.5 + t / 2, hor + (zen - hor) * t ** 0.55) for t in (0.0, 0.02, 0.06, 0.12, 0.22, 0.36, 0.55, 0.77, 1.0)]
    elems = ramp.color_ramp.elements
    while len(elems) > 1:
        elems.remove(elems[-1])
    elems[0].position, elems[0].color = stops[0][0], rgba(stops[0][1])
    for pos, colr in stops[1:]:
        elems.new(pos).color = rgba(colr)
    sky_col = g.out(ramp, "Color")

    # Extras seen only by camera rays: they would otherwise double the sun lamp
    # or add tiny bright spots that make world importance sampling noisy.
    extras = []
    sun = cfg.get("sun") or {}
    sun_up = clamp01(sun.get("up", 0.0)) * (1.0 - 0.85 * storm)
    if sun_up > 0.01 and "dir" in sun and not space:
        s = g.math("MAXIMUM", g.out(g.node("ShaderNodeVectorMath", {0: d, 1: gl_to_blender(sun["dir"]).normalized()},
                                           operation="DOT_PRODUCT"), "Value"), 0.0)
        glow = g.math("ADD", g.math("ADD", g.math("MULTIPLY", g.math("POWER", s, 1400.0), 30.0),
                                    g.math("MULTIPLY", g.math("POWER", s, 10.0), 0.22)),
                      g.math("MULTIPLY", g.math("POWER", s, 3.0), 0.06))
        tint = np.array(normalized_color(sun.get("color", (1, 0.95, 0.85)))) * sun_up
        extras.append(g.out(g.node("ShaderNodeVectorMath", {0: tuple(tint), 3: glow}, operation="SCALE")))
    moon = cfg.get("moon") or {}
    if "dir" in moon and not space:
        m = g.math("MAXIMUM", g.out(g.node("ShaderNodeVectorMath", {0: d, 1: gl_to_blender(moon["dir"]).normalized()},
                                           operation="DOT_PRODUCT"), "Value"), 0.0)
        disc = g.out(g.node("ShaderNodeMapRange", {"Value": m, "From Min": 0.9994, "From Max": 0.9997},
                            interpolation_type="SMOOTHSTEP"), "Result")
        glow = g.math("ADD", g.math("MULTIPLY", disc, 2.2), g.math("MULTIPLY", g.math("POWER", m, 60.0), 0.12))
        k = (0.25 + 0.75 * night) * (1.0 - 0.8 * storm)
        extras.append(g.out(g.node("ShaderNodeVectorMath", {0: (0.85 * k, 0.9 * k, k), 3: glow}, operation="SCALE")))
    star_amount = (0.55 + 0.45 * night if space else night) * (1.0 - storm)
    if star_amount > 0.05:
        # One Voronoi point per cell, ~1.4% of cells lit: the engine's star
        # density. Star radius is set in pixels so they stay crisp at any size.
        cells = 120.0
        pixel = float(cfg["camera"].get("fovY", 0.62)) / max(1, int(cfg.get("height", 1080)))
        radius = 1.3 * pixel * cells
        vor = g.node("ShaderNodeTexVoronoi", {"Vector": d, "Scale": cells})
        rand = g.node("ShaderNodeSeparateColor", {0: g.out(vor, "Color")})
        lucky = g.math("GREATER_THAN", g.out(rand, "Red"), 0.986)
        dot = g.out(g.node("ShaderNodeMapRange", {"Value": g.out(vor, "Distance"),
                                                   "From Min": radius, "From Max": radius * 0.35}), "Result")
        twinkle = g.math("MULTIPLY_ADD", g.out(rand, "Green"), 0.6, 0.4)
        above = 1.0 if space else g.math("MULTIPLY", z, 5.0, clamp=True)
        star = g.math("MULTIPLY", g.math("MULTIPLY", lucky, dot),
                      g.math("MULTIPLY", g.math("MULTIPLY", above, twinkle), 2.5 * star_amount))
        extras.append(g.out(g.node("ShaderNodeCombineXYZ", {0: star, 1: star, 2: star})))

    lp = g.node("ShaderNodeLightPath")
    cam = g.out(lp, "Is Camera Ray")
    color = sky_col
    if space:
        # Camera rays see space; everything else still sees the sky's colors.
        color = g.out(g.node("ShaderNodeMix", {"Factor": cam, "A": sky_col, "B": (0.006, 0.008, 0.02)}, data_type="RGBA"))
    if extras:
        total = extras[0]
        for e in extras[1:]:
            total = g.out(g.node("ShaderNodeVectorMath", {0: total, 1: e}, operation="ADD"))
        total = g.out(g.node("ShaderNodeVectorMath", {0: total, 3: cam}, operation="SCALE"))
        color = g.out(g.node("ShaderNodeVectorMath", {0: sky_col, 1: total}, operation="ADD"))
    # Light sampling evaluates the world with no ray-type flags, so diffuse
    # lighting gets SKY_FILL consistently from both NEE and bounced rays.
    seen = g.math("MAXIMUM", g.math("MAXIMUM", cam, g.out(lp, "Is Glossy Ray")), g.out(lp, "Is Transmission Ray"))
    strength = g.math("MULTIPLY_ADD", seen, 1.0 - SKY_FILL, SKY_FILL)
    bg = g.node("ShaderNodeBackground", {"Color": color, "Strength": strength})
    g.link(g.out(bg), g._input(g.node("ShaderNodeOutputWorld"), "Surface"))
    # Fog colour, derived from the sky the same way the engine does.
    return tuple((hor + (zen - hor) * 0.35) * 0.85)


# ----------------------------------------------------------------- camera + render

def build_camera(cfg):
    cam_cfg = cfg["camera"]
    eye, target = gl_to_blender(cam_cfg["eye"]), gl_to_blender(cam_cfg["target"])
    data = bpy.data.cameras.new("Camera")
    data.sensor_fit = "VERTICAL"  # fovY is vertical; width follows the aspect
    data.angle_y = float(cam_cfg.get("fovY", 0.62))
    orbit = max((target - eye).length, 1e-3)
    forward = (target - eye) / orbit
    # Optional camera.focus (e.g. the creature) overrides the orbit target as
    # the sharp plane, like the viewer's own miniature focus.
    focus = gl_to_blender(cam_cfg["focus"]) if cam_cfg.get("focus") else target
    data.clip_start = 0.02
    data.clip_end = max(1000.0, orbit * 20)
    data.dof.use_dof = True
    data.dof.focus_distance = max((focus - eye).dot(forward), 0.05)
    # Cycles aperture radius = lens[m] / (2 * f-stop); solve for the radius we want.
    data.dof.aperture_fstop = (data.lens * 1e-3) / (2.0 * DOF_APERTURE * orbit)
    obj = bpy.data.objects.new("Camera", data)
    obj.location = eye
    obj.rotation_euler = (target - eye).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.scene.camera = obj


def build_finish(night, storm):
    """Compositor pass mirroring the viewer's finish: bloom, saturation, vignette.

    Runs on linear light before the view transform. Blender 5 compositing is a
    node group on the scene with a Group Output (the Composite node is gone).
    """
    scene = bpy.context.scene
    tree = bpy.data.node_groups.new("Postcard", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    scene.compositing_node_group = tree
    scene.render.use_compositing = True
    g = Graph(tree)

    image = g.out(g.node("CompositorNodeRLayers"), "Image")
    bloom = g.node("CompositorNodeGlare", {"Image": image, "Type": "Bloom", "Quality": "High",
                                           "Threshold": 1.0, "Strength": 0.35 + 0.4 * night, "Size": 0.6})
    # AgX desaturates on purpose; the viewer grades the other way (sat ~1.08).
    sat = g.node("CompositorNodeHueSat", {"Image": g.out(bloom, "Image"),
                                          "Saturation": max(0.6, 1.15 - 0.35 * storm - 0.15 * night)})

    # Engine vignette: x *= mix(1 - k, 1, smoothstep(.85, .2, |(uv - .5) * (1.15, 1)|)).
    uv = g.out(g.node("CompositorNodeImageCoordinates", {"Image": image}), "Normalized")
    q = g.out(g.node("ShaderNodeVectorMath", {0: uv, 1: (0.5, 0.5, 0.0)}, operation="SUBTRACT"))
    q = g.out(g.node("ShaderNodeVectorMath", {0: q, 1: (1.15, 1.0, 0.0)}, operation="MULTIPLY"))
    r = g.out(g.node("ShaderNodeVectorMath", {0: q}, operation="LENGTH"), "Value")
    k = 0.28 + 0.12 * storm + 0.08 * night
    shade = g.out(g.node("ShaderNodeMapRange", {"Value": r, "From Min": 0.85, "From Max": 0.2,
                                                "To Min": 1.0 - k, "To Max": 1.0},
                         interpolation_type="SMOOTHSTEP"), "Result")
    final = g.out(g.node("ShaderNodeVectorMath", {0: g.out(sat, "Image"), 3: shade}, operation="SCALE"))
    g.link(final, g.node("NodeGroupOutput").inputs[0])


def pick_device():
    """CUDA if present: its kernels ship precompiled (OptiX would JIT on first use)."""
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.refresh_devices()
        gpus = [d for d in prefs.devices if d.type == "CUDA"]
        for d in prefs.devices:
            d.use = d.type == "CUDA"  # leave the CPU out: hybrid is slower with one mid-range GPU
        if gpus:
            return "GPU", ", ".join(d.name for d in gpus)
    except Exception as exc:  # no Cycles GPU support at all
        log(f"GPU probe failed: {exc}")
    return "CPU", "CPU"


def setup_render(cfg, night):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    cy.device, device_name = pick_device()
    log(f"device: {cy.device} ({device_name})")

    scene.render.resolution_x = int(cfg.get("width", 1920))
    scene.render.resolution_y = int(cfg.get("height", 1080))
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False

    cy.samples = max(1, int(cfg.get("samples", 96)))
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.02
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cy.denoising_prefilter = "ACCURATE"
    cy.denoising_quality = "HIGH"
    cy.denoising_use_gpu = cy.device == "GPU"

    # Enough transmission depth for camera -> glass -> water -> seabed and back
    # out; few diffuse bounces since a sunlit diorama needs little GI.
    cy.max_bounces = 10
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 4
    cy.transmission_bounces = 8
    cy.transparent_max_bounces = 16
    cy.volume_bounces = 1
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.blur_glossy = 1.0
    cy.sample_clamp_indirect = 6.0

    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    # The viewer brightens its exposure at night (x0.92 -> x1.27).
    scene.view_settings.exposure = math.log2((0.92 + 0.35 * night) / 0.92)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15


def flush_c_stdio():
    """Blender's C stdout is block-buffered when piped and flushed at exit, which
    would print its banner after our status line. Flush it first."""
    try:
        import ctypes
        libc = ctypes.cdll.ucrtbase if sys.platform == "win32" else ctypes.CDLL(None)
        libc.fflush(None)
    except Exception:
        pass


def finish(line, code):
    sys.stdout.flush()
    flush_c_stdio()
    print(line, flush=True)
    # A Python exception would otherwise leave Blender's exit status at 0.
    sys.exit(code)


def main():
    t_start = time.perf_counter()
    cfg = load_config(parse_args())
    night, storm = clamp01(cfg.get("night", 0.0)), clamp01(cfg.get("storm", 0.0))

    # Start from an empty scene (factory startup has a cube, light and camera).
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    count, column = load_vertices(cfg)
    fog = {"color": build_world(cfg, night, storm), "density": max(0.0, float(cfg.get("fog", 0.0)))}
    build_island(count, column, night, [island_material(s, fog) for s in SURFACES] + [stream_material(storm, fog)])
    if cfg.get("sea"):
        build_tank(cfg["sea"], storm, fog, glass=not cfg.get("space"))
    build_lights(cfg, night, storm)
    build_camera(cfg)
    setup_render(cfg, night)
    build_finish(night, storm)
    log(f"scene ready in {time.perf_counter() - t_start:.1f}s; rendering "
        f"{bpy.context.scene.render.resolution_x}x{bpy.context.scene.render.resolution_y} "
        f"@ {bpy.context.scene.cycles.samples} spp")

    t_render = time.perf_counter()
    bpy.ops.render.render(write_still=False)
    out = cfg["out"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    # save_render applies the view transform, and unlike render.filepath it
    # doesn't treat '#' in the path as a frame-number placeholder.
    bpy.data.images["Render Result"].save_render(filepath=out)
    if not os.path.isfile(out):
        raise RuntimeError(f"render finished but {out} was not written")
    log(f"rendered in {time.perf_counter() - t_render:.1f}s (total {time.perf_counter() - t_start:.1f}s)")
    return out


if __name__ == "__main__":
    try:
        result = main()
    except SystemExit:
        raise
    except BaseException as exc:
        traceback.print_exc()
        reason = f"{type(exc).__name__}: {exc}".replace("\n", " ")
        finish(f"PHOTO_FAILED {reason}", 1)
    else:
        finish(f"PHOTO_DONE {result}", 0)
