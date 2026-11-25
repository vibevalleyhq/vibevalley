// Cross-platform 5-Pass Handcrafted Papercraft Diorama Shaders (WGSL / wgpu)
// Pass 1: 2048^2 directional shadow map with hierarchical GPU rigid-joint skinning
// Pass 2a: Procedural dark walnut studio desk & sunlit/starry moonlit horizon backdrop
// Pass 2b: Forward cardstock diorama scene (world Gobo, dual-scale fibre+crumple, 1.5px lit cut-edge,
//          radial honey-amber windows & vermilion lanterns, 24 lamp pools, golden-vermilion canal reflections)
// Pass 3: 1/4-resolution emissive-masked separable Gaussian Bloom (Extract + 2x 13-tap H/V blur)
// Pass 4: Half-resolution dual-radius discontinuity-aware Contact Depth AO + Hybrid Tilt-Shift CoC
// Pass 5: 36-tap Golden-Angle Spiral Bokeh + Sharp-Band Unsharp + World-Tinted AO + Bloom + ACES Filmic

struct VertexInput {
    @location(0) pos: vec3<f32>,
    @location(1) uv: vec2<f32>,         // hardware Float16x2 -> vec2<f32>
    @location(2) ao_tint: vec4<f32>,    // hardware Unorm8x4 -> vec4<f32>
    @location(3) oct_norm_meta: u32,    // bits 0..7=oct_x(i8), 8..15=oct_y(i8), 16..23=mat_flag, 24..31=bone_id
};

fn decode_oct_normal(packed: u32) -> vec3<f32> {
    let ix = extractBits(bitcast<i32>(packed), 0u, 8u);
    let iy = extractBits(bitcast<i32>(packed), 8u, 8u);
    let ox = clamp(f32(ix) / 127.0, -1.0, 1.0);
    let oy = clamp(f32(iy) / 127.0, -1.0, 1.0);
    var n = vec3<f32>(ox, oy, 1.0 - abs(ox) - abs(oy));
    if (n.z < 0.0) {
        let sx = select(-1.0, 1.0, n.x >= 0.0);
        let sy = select(-1.0, 1.0, n.y >= 0.0);
        let nx = (1.0 - abs(n.y)) * sx;
        let ny = (1.0 - abs(n.x)) * sy;
        n.x = nx;
        n.y = ny;
    }
    return normalize(n);
}

struct FrameUniforms {
    viewProj: mat4x4<f32>,
    lightViewProj: mat4x4<f32>,
    camPos_aspect: vec4<f32>,      // xyz = eye, w = aspect
    camTarget_slabHalf: vec4<f32>, // xyz = target, w = groundSlabHalfSize
    camRight_gobo: vec4<f32>,      // xyz = camera right, w = goboStrength
    camUp_dayFactor: vec4<f32>,    // xyz = camera up, w = daylight factor (0=night .. 1=day)
    camFwd_bloomStr: vec4<f32>,    // xyz = camera forward, w = bloom composite strength
    projParams: vec4<f32>,         // near, far, tanHalfFov, focusDepth
    keyDir_intensity: vec4<f32>,   // xyz = dir toward light, w = keyIntensity
    keyColor_wrap: vec4<f32>,      // rgb, w = wrap
    skyColor_hemi: vec4<f32>,      // rgb, w = hemiIntensity
    groundColor_exp: vec4<f32>,    // rgb, w = exposure
    shadowLeak_str: vec4<f32>,     // rgb, w = shadowStrength
    tableBg_lampCount: vec4<f32>,  // rgb = studio desk walnut base, w = active lamp pool count
    fogColor_lampInt: vec4<f32>,   // rgb, w = lampIntensity
    lampColor_time: vec4<f32>,     // rgb, w = elapsed
    tiltA: vec4<f32>,              // focusY, halfBand, ramp, depthWeight
    tiltB: vec4<f32>,              // maxBlurPx, aoRadius, aoIntensity, vignette
    lampPools: array<vec4<f32>, 32>, // xyz = world pos, w = +/-radius (w>0 direct lantern/bridge, w<0 building)
    lightGridBounds: vec4<f32>,    // minX, minZ, invSpanX, invSpanZ
    lightGrid: array<vec4<u32>, 16>, // 8x8 tiled world-space 32-bit lamp bitmask grid (64 u32 cells)
    quality_pad: vec4<f32>,        // x = 1.0 Interactive / 0.0 Ultra, yzw = reserved
};

fn light_grid_mask(xz: vec2<f32>) -> u32 {
    let uv = (xz - frame.lightGridBounds.xy) * frame.lightGridBounds.zw;
    let cx = u32(clamp(floor(uv.x * 8.0), 0.0, 7.0));
    let cz = u32(clamp(floor(uv.y * 8.0), 0.0, 7.0));
    let cell = cz * 8u + cx;
    let word = frame.lightGrid[cell >> 2u];
    let lane = cell & 3u;
    if (lane == 0u) { return word.x; }
    if (lane == 1u) { return word.y; }
    if (lane == 2u) { return word.z; }
    return word.w;
}

struct InstanceData {
    model: mat4x4<f32>,
    params: vec4<f32>, // x = atlasIndex (0=yard, 1=helpers, 2=ground), y = highlight, z = boneBase, w = 0
};

struct ShadowOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) flags: u32,
    @location(2) @interpolate(flat) atlasIdx: u32,
};

struct SceneOut {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    @location(1) localPos: vec3<f32>,
    @location(2) worldNormal: vec3<f32>,
    @location(3) localNormal: vec3<f32>,
    @location(4) uv: vec2<f32>,
    @location(5) shadowPos: vec4<f32>,
    @location(6) aoTint: vec4<f32>,
    @location(7) @interpolate(flat) flags: u32,
    @location(8) @interpolate(flat) atlasIdx: u32,
    @location(9) @interpolate(flat) highlight: f32,
};

struct QuadOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct BackdropOut {
    @invariant @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

const FLAG_GROUND: u32 = 0u;
const FLAG_CARD: u32 = 1u;
const FLAG_CUT_EDGE: u32 = 2u;
const FLAG_BOOK_EDGE: u32 = 3u;
const FLAG_RAIL: u32 = 4u;
const FLAG_LAMP_GLOW: u32 = 5u;
const FLAG_WINDOW_GLOW: u32 = 6u;
const FLAG_FOLDED_CARD: u32 = 7u;

// Group 0: Per-frame uniforms, GPU rigid-joint bone palette, and instanced draw storage buffer
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> bones: array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read> instances: array<InstanceData>;

// Group 1: Pass-specific textures & samplers
// Shadow Pass bindings:
@group(1) @binding(0) var shadowYardAtlas: texture_2d<f32>;
@group(1) @binding(1) var shadowHelperAtlas: texture_2d<f32>;
@group(1) @binding(2) var shadowArtSmp: sampler;

// -----------------------------------------------------------------------------
// Pass 1: Directional Shadow Map (Double-Rate Z-Only + Alpha-Cutout Fallback)
// -----------------------------------------------------------------------------

@vertex
fn shadow_zonly_vs(v: VertexInput, @builtin(instance_index) instIdx: u32) -> @builtin(position) vec4<f32> {
    let inst = instances[instIdx];
    let boneId = min((v.oct_norm_meta >> 24u) & 0xFFu, 15u);
    let boneBase = u32(inst.params.z + 0.5);
    let skin = bones[boneBase + boneId];
    let skinnedLocal = skin * vec4<f32>(v.pos, 1.0);
    let world = inst.model * skinnedLocal;
    return frame.lightViewProj * world;
}

@vertex
fn shadow_vs(v: VertexInput, @builtin(instance_index) instIdx: u32) -> ShadowOut {
    let inst = instances[instIdx];
    let flag = (v.oct_norm_meta >> 16u) & 0xFFu;
    let boneId = min((v.oct_norm_meta >> 24u) & 0xFFu, 15u);
    let boneBase = u32(inst.params.z + 0.5);
    let skin = bones[boneBase + boneId];
    let skinnedLocal = skin * vec4<f32>(v.pos, 1.0);
    let world = inst.model * skinnedLocal;

    var out: ShadowOut;
    out.position = frame.lightViewProj * world;
    out.uv = v.uv;
    out.flags = flag;
    out.atlasIdx = u32(inst.params.x + 0.5);
    return out;
}

@fragment
fn shadow_fs(in: ShadowOut) {
    if (in.flags == FLAG_CARD || in.flags == FLAG_LAMP_GLOW) {
        let aYard = textureSampleLevel(shadowYardAtlas, shadowArtSmp, in.uv, 0.0).a;
        let aHelp = textureSampleLevel(shadowHelperAtlas, shadowArtSmp, in.uv, 0.0).a;
        let a = select(aYard, aHelp, in.atlasIdx == 1u);
        if (a < 0.42) {
            discard;
        }
    }
}

// -----------------------------------------------------------------------------
// Shared Fullscreen Triangle & Noise Helpers
// -----------------------------------------------------------------------------

@vertex
fn quad_vs(@builtin(vertex_index) vid: u32) -> QuadOut {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );
    var out: QuadOut;
    out.position = vec4<f32>(pos[vid], 0.0, 1.0);
    out.uv = uv[vid];
    return out;
}

// Far-plane fullscreen triangle (z = 1.0) for reverse-order Early-Z backdrop culling
@vertex
fn backdrop_vs(@builtin(vertex_index) vid: u32) -> BackdropOut {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );
    var out: BackdropOut;
    out.position = vec4<f32>(pos[vid], 1.0, 1.0);
    out.uv = uv[vid];
    return out;
}

fn hash21(p_in: vec2<f32>) -> f32 {
    var p = fract(p_in * vec2<f32>(123.34, 456.21));
    p += dot(p, p + vec2<f32>(45.32));
    return fract(p.x * p.y);
}

fn value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

struct SceneFragOut {
    @location(0) color: vec4<f32>,
    @location(1) normal: vec2<f32>,
    @location(2) linz: f32,
};

fn encode_oct_unorm(n_in: vec3<f32>) -> vec2<f32> {
    let invL1 = 1.0 / max(abs(n_in.x) + abs(n_in.y) + abs(n_in.z), 1e-6);
    var oct = n_in.xy * invL1;
    if (n_in.z < 0.0) {
        let sx = select(-1.0, 1.0, oct.x >= 0.0);
        let sy = select(-1.0, 1.0, oct.y >= 0.0);
        oct = vec2<f32>((1.0 - abs(oct.y)) * sx, (1.0 - abs(oct.x)) * sy);
    }
    return clamp(oct * 0.5 + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
}

fn decode_oct_unorm(u: vec2<f32>) -> vec3<f32> {
    let oct = u * 2.0 - vec2<f32>(1.0);
    var n = vec3<f32>(oct.x, oct.y, 1.0 - abs(oct.x) - abs(oct.y));
    if (n.z < 0.0) {
        let sx = select(-1.0, 1.0, n.x >= 0.0);
        let sy = select(-1.0, 1.0, n.y >= 0.0);
        n.x = (1.0 - abs(oct.y)) * sx;
        n.y = (1.0 - abs(oct.x)) * sy;
    }
    return normalize(n);
}

// -----------------------------------------------------------------------------
// Pass 2b: Procedural Dark Walnut Studio Desk & Horizon Backdrop (Early-Z, alpha=0)
// -----------------------------------------------------------------------------

@fragment
fn backdrop_fs(in: QuadOut) -> SceneFragOut {
    let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
    let tanHalf = frame.projParams.z;
    let aspect = frame.camPos_aspect.w;
    let eye = frame.camPos_aspect.xyz;
    let rayDir = normalize(
        frame.camFwd_bloomStr.xyz
        + frame.camRight_gobo.xyz * (ndc.x * aspect * tanHalf)
        + frame.camUp_dayFactor.xyz * (ndc.y * tanHalf)
    );

    let dayF = frame.camUp_dayFactor.w;
    let slabHalf = frame.camTarget_slabHalf.w;
    let deskY = -0.38;

    let skyT = clamp((1.0 - in.uv.y) * 1.4, 0.0, 1.0);
    let dayHorizon = mix(vec3<f32>(0.58, 0.48, 0.34), vec3<f32>(0.76, 0.65, 0.47), skyT);
    let duskHorizon = mix(vec3<f32>(0.18, 0.12, 0.24), vec3<f32>(0.09, 0.08, 0.18), skyT);
    let nightSky = mix(vec3<f32>(0.040, 0.068, 0.155), vec3<f32>(0.014, 0.026, 0.072), skyT);
    var skyCol: vec3<f32>;
    if (dayF < 0.45) {
        skyCol = mix(nightSky, duskHorizon, smoothstep(0.05, 0.45, dayF));
    } else {
        skyCol = mix(duskHorizon, dayHorizon, smoothstep(0.45, 0.90, dayF));
    }

    if (dayF < 0.22) {
        let nightW = 1.0 - dayF * 4.5;
        let starUv = in.uv * vec2<f32>(130.0, 76.0);
        let cell = floor(starUv);
        let fracUv = fract(starUv) - vec2<f32>(0.5);
        let rnd = hash21(cell);
        if (rnd > 0.974 && in.uv.y < 0.26) {
            let d = length(fracUv);
            let star = smoothstep(0.24, 0.04, d) * nightW * smoothstep(0.26, 0.04, in.uv.y);
            skyCol += vec3<f32>(0.76, 0.85, 1.0) * (star * 0.52);
        }
        let moonPos = vec2<f32>(0.24, 0.082);
        let mp = (in.uv - moonPos) * vec2<f32>(aspect, 1.0);
        let md = length(mp);
        let moonDisc = smoothstep(0.029, 0.021, md) * nightW;
        let moonHalo = exp(-md * 7.2) * 0.26 * nightW + exp(-md * 2.8) * 0.06 * nightW;
        skyCol += vec3<f32>(0.88, 0.92, 1.0) * (moonDisc * 0.98 + moonHalo);
    }

    if (rayDir.y < -0.015) {
        let tHit = (deskY - eye.y) / rayDir.y;
        let hitPos = eye + rayDir * tHit;

        let wp = vec2<f32>(hitPos.x * 0.90 + hitPos.z * 0.44, -hitPos.x * 0.44 + hitPos.z * 0.90);
        let n1 = value_noise(vec2<f32>(wp.x * 0.38, wp.y * 2.6));
        let n2 = value_noise(vec2<f32>(wp.x * 1.15, wp.y * 9.5 + n1 * 2.4));
        let ring = sin((wp.y * 4.2 + n1 * 4.4 + n2 * 1.1) * 3.14159);
        let grain = pow(clamp(0.5 + 0.5 * ring, 0.0, 1.0), 1.35);
        let fineStreak = value_noise(vec2<f32>(wp.x * 0.65, wp.y * 28.0));
        let plankSeam = smoothstep(0.030, 0.0, abs(fract(wp.y * 0.24 + 0.5) - 0.5));

        let walnutBase = frame.tableBg_lampCount.rgb;
        let walnutDark = walnutBase * vec3<f32>(0.42, 0.36, 0.30);
        let walnutWarm = walnutBase * vec3<f32>(1.52, 1.30, 1.05);
        var woodAlbedo = mix(walnutDark, walnutWarm, grain * 0.68 + fineStreak * 0.32);
        woodAlbedo *= (1.0 - plankSeam * 0.42);

        let L = normalize(frame.keyDir_intensity.xyz);
        let deskNdotL = clamp((L.y + 0.28) / 1.28, 0.0, 1.0);
        let goboT = clamp(dot(hitPos - frame.camTarget_slabHalf.xyz, frame.camRight_gobo.xyz) / 11.0, -1.0, 1.0);
        let goboFalloff = 1.0 - frame.camRight_gobo.w * 0.85 * goboT;
        var goboTint = mix(vec3<f32>(1.06, 0.96, 0.84), vec3<f32>(0.90, 0.95, 1.05), goboT * 0.5 + 0.5);
        goboTint = mix(vec3<f32>(1.0), goboTint, smoothstep(0.08, 0.75, dayF));

        let dSlab = max(abs(hitPos.xz) - vec2<f32>(slabHalf), vec2<f32>(0.0));
        let distSlab = length(dSlab);
        let slabAo = mix(0.24, 1.0, smoothstep(0.0, 2.0, distSlab));
        let shadowShift = hitPos.xz - L.xz / max(L.y, 0.25) * 0.50;
        let dShad = max(abs(shadowShift) - vec2<f32>(slabHalf + 0.12), vec2<f32>(0.0));
        let slabCast = mix(0.48, 1.0, smoothstep(0.0, 1.5, length(dShad)));

        let deskAmbient = frame.skyColor_hemi.rgb * frame.skyColor_hemi.w * 0.80
            + vec3<f32>(0.09, 0.075, 0.065) * (1.0 - dayF);
        let deskIrr = deskAmbient
            + frame.keyColor_wrap.rgb * frame.keyDir_intensity.w * deskNdotL * 0.65 * slabCast;
        var deskCol = woodAlbedo * deskIrr * goboFalloff * goboTint * slabAo;

        let lampInt = frame.fogColor_lampInt.w;
        if (lampInt > 0.05) {
            var spill = 0.0;
            var mask = light_grid_mask(hitPos.xz);
            while (mask != 0u) {
                let i = countTrailingZeros(mask);
                mask &= mask - 1u;
                let lp = frame.lampPools[i];
                let r = abs(lp.w) * 2.35;
                let toLamp = hitPos - lp.xyz;
                let d2 = dot(toLamp, toLamp);
                if (d2 >= r * r) { continue; }
                let f = 1.0 - sqrt(d2) / r;
                spill += f * f;
            }
            let edgeGlow = smoothstep(5.5, 0.25, distSlab) * smoothstep(-6.0, 4.5, hitPos.z) * 0.26;
            deskCol += woodAlbedo * frame.lampColor_time.rgb * ((spill * 1.05 + edgeGlow) * lampInt);
        }

        let radial = length(hitPos.xz) / 21.0;
        deskCol *= mix(1.0, 0.36, smoothstep(0.45, 1.40, radial));

        let tableBackZ = -slabHalf - 2.6;
        let tableEdgeMask = smoothstep(tableBackZ - 1.2, tableBackZ + 0.7, hitPos.z);
        let horizonBlend = smoothstep(-0.015, -0.12, rayDir.y) * tableEdgeMask;
        return SceneFragOut(
            vec4<f32>(mix(skyCol, deskCol, horizonBlend), 0.0),
            vec2<f32>(0.5, 0.5),
            999.0
        );
    }

    return SceneFragOut(
        vec4<f32>(skyCol, 0.0),
        vec2<f32>(0.5, 0.5),
        999.0
    );
}

// -----------------------------------------------------------------------------
// Pass 2b: Main Forward Diorama Cardstock Scene (HDR RGBA16Float, alpha=bloomMask)
// -----------------------------------------------------------------------------

@group(1) @binding(0) var yardAtlas: texture_2d<f32>;
@group(1) @binding(1) var helperAtlas: texture_2d<f32>;
@group(1) @binding(2) var groundTex: texture_2d<f32>;
@group(1) @binding(3) var cardFibreTex: texture_2d<f32>;
@group(1) @binding(4) var pageFibreTex: texture_2d<f32>;
@group(1) @binding(5) var cutEdgeTex: texture_2d<f32>;
@group(1) @binding(6) var shadowMap: texture_depth_2d;
@group(1) @binding(7) var blueNoise: texture_2d<f32>;
@group(1) @binding(8) var artSmp: sampler;
@group(1) @binding(9) var tileSmp: sampler;
@group(1) @binding(10) var shadowCmpSmp: sampler_comparison;
@group(1) @binding(11) var materialsTex: texture_2d<f32>;

@vertex
fn scene_vs(v: VertexInput, @builtin(instance_index) instIdx: u32) -> SceneOut {
    let inst = instances[instIdx];
    let flag = (v.oct_norm_meta >> 16u) & 0xFFu;
    let boneId = min((v.oct_norm_meta >> 24u) & 0xFFu, 15u);
    let boneBase = u32(inst.params.z + 0.5);
    let skin = bones[boneBase + boneId];
    let lp = v.pos;
    let ln = decode_oct_normal(v.oct_norm_meta);
    let skinnedLocal = skin * vec4<f32>(lp, 1.0);
    let skinN = mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz);
    let rawSn = skinN * ln;
    let snLen = length(rawSn);
    let skinnedNormal = select(vec3<f32>(0.0, 1.0, 0.0), rawSn / snLen, snLen > 1e-5);

    let world = inst.model * skinnedLocal;
    let nm = mat3x3<f32>(inst.model[0].xyz, inst.model[1].xyz, inst.model[2].xyz);
    let wn = nm * skinnedNormal;
    let wnLen = length(wn);

    var out: SceneOut;
    out.position = frame.viewProj * world;
    out.worldPos = world.xyz;
    // Keep rest-pose localPos/localNormal so triplanar cardstock fibre sticks rigidly to moving limbs/roofs!
    out.localPos = lp;
    out.localNormal = ln;
    out.worldNormal = select(vec3<f32>(0.0, 1.0, 0.0), wn / wnLen, wnLen > 1e-5);
    out.uv = v.uv;
    out.shadowPos = frame.lightViewProj * world;
    out.aoTint = v.ao_tint;
    out.flags = flag;
    out.atlasIdx = u32(inst.params.x + 0.5);
    out.highlight = inst.params.y;
    return out;
}

fn load_shadow_depth(uv: vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(shadowMap));
    let coord = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - vec2<f32>(1.0)));
    return textureLoad(shadowMap, coord, 0);
}

fn load_blue_noise(screenPx: vec2<f32>) -> vec4<f32> {
    let coord = vec2<i32>(i32(screenPx.x) & 63, i32(screenPx.y) & 63);
    return textureLoad(blueNoise, coord, 0);
}

fn compute_pcss_shadow(
    shadowPos: vec4<f32>,
    N: vec3<f32>,
    L: vec3<f32>,
    screenPx: vec2<f32>
) -> f32 {
    let proj = shadowPos.xyz / max(shadowPos.w, 1e-5);
    let uv = vec2<f32>(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);
    let depth = proj.z;
    if (uv.x <= 0.008 || uv.x >= 0.992 || uv.y <= 0.008 || uv.y >= 0.992 || depth <= 0.0 || depth >= 1.0) {
        return 1.0;
    }

    let angle = load_blue_noise(screenPx).r * 6.2831853;
    let ca = cos(angle);
    let sa = sin(angle);
    let rot = mat2x2<f32>(vec2<f32>(ca, sa), vec2<f32>(-sa, ca));

    let ndotl = max(dot(N, L), 0.05);
    let bias = clamp(0.00028 + 0.00095 * (1.0 - ndotl), 0.00025, 0.0016);
    let texel = vec2<f32>(1.0) / max(vec2<f32>(textureDimensions(shadowMap)), vec2<f32>(1.0));

    var vogel = array<vec2<f32>, 16>(
        vec2<f32>( 0.125,  0.000), vec2<f32>(-0.160,  0.207), vec2<f32>(-0.062, -0.326), vec2<f32>( 0.344,  0.220),
        vec2<f32>(-0.409, -0.242), vec2<f32>( 0.255, -0.468), vec2<f32>( 0.105,  0.594), vec2<f32>(-0.610,  0.130),
        vec2<f32>( 0.545,  0.381), vec2<f32>(-0.246, -0.671), vec2<f32>( 0.663, -0.333), vec2<f32>(-0.556,  0.604),
        vec2<f32>(-0.044,  0.848), vec2<f32>( 0.775,  0.425), vec2<f32>(-0.840, -0.391), vec2<f32>( 0.421, -0.875)
    );

    let isInteractive = frame.quality_pad.x > 0.5;
    let blockerTaps = select(10, 6, isInteractive);
    let pcfTaps = select(12, 8, isInteractive);

    var blockerSum = 0.0;
    var blockers = 0;
    let searchRadius = texel * 11.5;
    for (var i = 0; i < blockerTaps; i = i + 1) {
        let off = (rot * vogel[i]) * searchRadius;
        let sd = load_shadow_depth(uv + off);
        if (sd + bias < depth) {
            blockerSum += sd;
            blockers += 1;
        }
    }
    if (blockers == 0) {
        return 1.0;
    }
    let avgBlocker = blockerSum / f32(blockers);
    let gap = max(depth - avgBlocker, 0.0);
    let penumbra = clamp(pow(gap * 46.0, 0.88) * 1.12, 0.95, 11.5) * texel;

    var lit = 0.0;
    let cmpRef = clamp(depth - bias, 0.0, 1.0);
    for (var i = 0; i < pcfTaps; i = i + 1) {
        let off = (rot * vogel[i]) * penumbra;
        lit += textureSampleCompareLevel(shadowMap, shadowCmpSmp, uv + off, cmpRef);
    }
    return lit / f32(pcfTaps);
}

fn triplanar_dominant_uv(lp: vec3<f32>, ln: vec3<f32>) -> vec2<f32> {
    let an = abs(ln);
    if (an.y >= an.x && an.y >= an.z) {
        return lp.xz;
    } else if (an.x >= an.z) {
        return lp.zy;
    }
    return lp.xy;
}

// Seam-free, bleed-free 4x2 atlas (2048x1024, 512x512 cells) triplanar sampler:
// gradients are computed from continuous pre-fract localPos derivatives and clamped inside cell bounds
// so wrapped seams never trigger coarse mips and neighboring atlas cells never bleed!
fn sample_material_tile(
    col: f32,
    row: f32,
    triUv: vec2<f32>,
    dTriX: vec2<f32>,
    dTriY: vec2<f32>,
    freq: f32
) -> vec3<f32> {
    let fuv = fract(triUv * freq);
    let padX = 1.5 / 2048.0;
    let padY = 1.5 / 1024.0;
    let inner = vec2<f32>(0.25 - 2.0 * padX, 0.50 - 2.0 * padY);
    let cellUv = vec2<f32>(
        col * 0.25 + padX + fuv.x * inner.x,
        row * 0.50 + padY + fuv.y * inner.y
    );
    let maxGrad = vec2<f32>(0.028, 0.035);
    let dCellX = clamp(dTriX * (freq * inner), -maxGrad, maxGrad);
    let dCellY = clamp(dTriY * (freq * inner), -maxGrad, maxGrad);
    return textureSampleGrad(materialsTex, artSmp, cellUv, dCellX, dCellY).rgb;
}

@fragment
fn scene_fs(in: SceneOut, @builtin(front_facing) isFront: bool) -> SceneFragOut {
    // Compute screen-space gradients in uniform control flow before flag branching for hardware
    // trilinear + 4x anisotropic mipmap filtering via textureSampleGrad with -0.47 negative LOD bias!
    let dx = dpdx(in.uv);
    let dy = dpdy(in.uv);
    let footprint = max(length(dx), length(dy));
    let mipBias = 0.72; // ~-0.47 mip bias keeps oblique barrel tiles, paper tooth & brushwork crisp
    let dxB = dx * mipBias;
    let dyB = dy * mipBias;
    let dWpXz_dx = dpdx(in.worldPos.xz) * mipBias;
    let dWpXz_dy = dpdy(in.worldPos.xz) * mipBias;
    let dLp_dx = dpdx(in.localPos) * mipBias;
    let dLp_dy = dpdy(in.localPos) * mipBias;

    var albedo = vec3<f32>(0.86, 0.80, 0.70);
    var fibreNormal = vec2<f32>(0.0);
    var crumpleNormal = vec2<f32>(0.0);
    var normalStrength = 0.45;
    var translucencyFactor = 0.0;
    var waterMask = 0.0;
    var waterRipple = 0.0;
    var emissiveCol = vec3<f32>(0.0);
    var matRelief = 0.5;
    var matReliefStr = 0.0;
    let dayF = frame.camUp_dayFactor.w;
    let lampInt = frame.fogColor_lampInt.w;
    let L = normalize(frame.keyDir_intensity.xyz);
    let V = normalize(frame.camPos_aspect.xyz - in.worldPos);

    if (in.flags == FLAG_GROUND) {
        albedo = textureSampleGrad(groundTex, artSmp, in.uv, dxB, dyB).rgb;
        waterMask = smoothstep(0.022, 0.080, min(albedo.g, albedo.b) - albedo.r)
                  * smoothstep(1.22, 1.80, albedo.b / max(albedo.r, 0.008));

        let gdx1 = dWpXz_dx * 0.36;
        let gdy1 = dWpXz_dy * 0.36;
        let gdx2 = vec2<f32>(-dWpXz_dx.y, dWpXz_dx.x) * 1.34;
        let gdy2 = vec2<f32>(-dWpXz_dy.y, dWpXz_dy.x) * 1.34;
        let f1 = textureSampleGrad(pageFibreTex, tileSmp, in.worldPos.xz * 0.36, gdx1, gdy1);
        let f2 = textureSampleGrad(pageFibreTex, tileSmp, vec2<f32>(-in.worldPos.z, in.worldPos.x) * 1.34 + vec2<f32>(0.37), gdx2, gdy2);
        let fCrumple = textureSampleGrad(pageFibreTex, tileSmp, in.worldPos.xz * 0.11 + vec2<f32>(0.19), dWpXz_dx * 0.11, dWpXz_dy * 0.11);
        fibreNormal = mix(f1.xy, f2.xy, 0.44) - vec2<f32>(0.5);
        crumpleNormal = (fCrumple.xy - vec2<f32>(0.5)) * 0.42;
        normalStrength = mix(0.46, 0.22, waterMask);
        waterRipple = f1.b - 0.5;

        let tooth = (f1.b - 0.5) + (f2.b - 0.5) * 0.52;
        let cloud = f1.a - 0.5;
        albedo *= clamp(1.0 + tooth * mix(0.58, 0.36, waterMask) + cloud * 0.22, 0.80, 1.16);
        albedo *= in.aoTint.rgb;
    } else if (in.flags == FLAG_CARD || in.flags == FLAG_LAMP_GLOW) {
        let tYard = textureSampleGrad(yardAtlas, artSmp, in.uv, dxB, dyB);
        let tHelp = textureSampleGrad(helperAtlas, artSmp, in.uv, dxB, dyB);
        let texel = select(tYard, tHelp, in.atlasIdx == 1u);
        if (texel.a < 0.38) {
            discard;
        }
        albedo = texel.rgb;

        // Tightened crisp ~1.5px handmade die-cut silhouette edge (zero fuzzy white sticker halo!)
        let probeR = min(footprint * 1.15, 0.0032);
        var amin = texel.a;
        var alphaGrad = vec2<f32>(0.0);
        for (var i = 0; i < 6; i = i + 1) {
            let ang = f32(i) * 1.0471976 + 0.25;
            let dir2 = vec2<f32>(cos(ang), sin(ang));
            let sYard = textureSampleLevel(yardAtlas, artSmp, in.uv + dir2 * probeR, 0.0).a;
            let sHelp = textureSampleLevel(helperAtlas, artSmp, in.uv + dir2 * probeR, 0.0).a;
            let sa = select(sYard, sHelp, in.atlasIdx == 1u);
            amin = min(amin, sa);
            alphaGrad += dir2 * (sa - texel.a);
        }
        let edgeMask = 1.0 - smoothstep(0.36, 0.82, amin);
        let light2D = normalize(vec2<f32>(dot(L, frame.camRight_gobo.xyz), L.y) + vec2<f32>(1e-4));
        let gradDir = normalize(-alphaGrad + vec2<f32>(1e-4));
        let litSide = smoothstep(-0.15, 0.65, dot(gradDir, light2D));
        let localLuma = dot(albedo, vec3<f32>(0.299, 0.587, 0.114));
        let darkInkEdge = albedo * vec3<f32>(0.46, 0.41, 0.36);
        let litPaperLip = mix(albedo * 1.15, vec3<f32>(0.88, 0.82, 0.68), 0.38) * clamp(localLuma * 1.5 + 0.25, 0.35, 1.0);
        let outerMask = 1.0 - smoothstep(0.36, 0.58, amin);
        albedo = mix(albedo, litPaperLip, edgeMask * litSide * 0.42);
        albedo = mix(albedo, darkInkEdge, outerMask * 0.55);

        let fibreUv = in.localPos.xy * 0.78;
        let dfx = dLp_dx.xy * 0.78;
        let dfy = dLp_dy.xy * 0.78;
        let cf = textureSampleGrad(cardFibreTex, tileSmp, fibreUv, dfx, dfy);
        let cfFine = textureSampleGrad(cardFibreTex, tileSmp, fibreUv * 3.73 + vec2<f32>(0.41), dfx * 3.73, dfy * 3.73);
        let cfCrumple = textureSampleGrad(cardFibreTex, tileSmp, fibreUv * 0.24 + vec2<f32>(0.17), dfx * 0.24, dfy * 0.24);
        fibreNormal = mix(cf.xy, cfFine.xy, 0.42) - vec2<f32>(0.5);
        crumpleNormal = (cfCrumple.xy - vec2<f32>(0.5)) * 0.65;
        normalStrength = 0.60;

        let tooth = (cf.b - 0.5) + (cfFine.b - 0.5) * 0.55;
        let cloud = cf.a - 0.5;
        let toneSeed = (in.aoTint.a - 0.5) * 0.08;
        albedo *= clamp(1.0 + tooth * 0.78 + cloud * 0.42 + toneSeed, 0.72, 1.24);
        albedo *= in.aoTint.rgb;

        translucencyFactor = mix(0.06, 0.28, dayF);

        if (in.flags == FLAG_LAMP_GLOW) {
            let luma = dot(texel.rgb, vec3<f32>(0.299, 0.587, 0.114));
            if (luma > 0.62 && texel.r > texel.b * 1.10) {
                let amberCore = vec3<f32>(1.0, 0.68, 0.22);
                let glowAmt = 0.40 + lampInt * 1.10;
                emissiveCol = mix(albedo, amberCore, 0.60) * glowAmt;
            }
        }
    } else if (in.flags == FLAG_FOLDED_CARD) {
        let srgbPigment = max(in.aoTint.rgb, vec3<f32>(0.001));
        albedo = pow(srgbPigment, vec3<f32>(2.2));
        let fUv = triplanar_dominant_uv(in.localPos, in.localNormal) * 0.82;
        let dfx = triplanar_dominant_uv(dLp_dx, in.localNormal) * 0.82;
        let dfy = triplanar_dominant_uv(dLp_dy, in.localNormal) * 0.82;
        let cf = textureSampleGrad(cardFibreTex, tileSmp, fUv, dfx, dfy);
        let cfFine = textureSampleGrad(
            cardFibreTex,
            tileSmp,
            vec2<f32>(-fUv.y, fUv.x) * 3.73 + vec2<f32>(0.41),
            vec2<f32>(-dfx.y, dfx.x) * 3.73,
            vec2<f32>(-dfy.y, dfy.x) * 3.73
        );
        let cfCrumple = textureSampleGrad(cardFibreTex, tileSmp, fUv * 0.24 + vec2<f32>(0.31), dfx * 0.24, dfy * 0.24);
        fibreNormal = mix(cf.xy, cfFine.xy, 0.48) - vec2<f32>(0.5);
        // Fine 1024x1024 cold-press archival cotton cardstock
        crumpleNormal = (cfCrumple.xy - vec2<f32>(0.5)) * 0.24;
        normalStrength = 0.54;

        let tooth = (cf.b - 0.5) + (cfFine.b - 0.5) * 0.50;
        let cloud = cf.a - 0.5;
        let toneSeed = (in.aoTint.a - 0.5) * 0.055;
        var surfMod = 1.0 + tooth * 0.64 + cloud * 0.12 + toneSeed;

        // 2K Hand-Painted Pen-and-Ink + Matte Gouache Material Atlas (`materials_2k.vvtex`, 4x2 of 512x512)
        // Each tile is normalized to mean linear luminance 0.50 so multiplying preserves scene color balance!
        let srgbLuma = dot(srgbPigment, vec3<f32>(0.299, 0.587, 0.114));
        let maxC = max(srgbPigment.r, max(srgbPigment.g, srgbPigment.b));
        let minC = min(srgbPigment.r, min(srgbPigment.g, srgbPigment.b));
        let chromaSpan = maxC - minC;
        let sat = chromaSpan / max(maxC, 1e-4);
        let an = abs(in.localNormal);
        let tri = triplanar_dominant_uv(in.localPos, in.localNormal);
        let triDx = triplanar_dominant_uv(dLp_dx, in.localNormal);
        let triDy = triplanar_dominant_uv(dLp_dy, in.localNormal);

        // Soft material weights (mutually clean; suppresses puppet vivid/skin accents automatically)
        let wRoof = (1.0 - smoothstep(0.28, 0.39, srgbLuma))
            * smoothstep(-0.02, 0.05, srgbPigment.b - srgbPigment.r)
            * smoothstep(0.14, 0.30, an.y) * (1.0 - smoothstep(0.93, 0.99, an.y));
        let wPlaster = smoothstep(0.60, 0.72, srgbLuma)
            * (1.0 - smoothstep(0.11, 0.18, sat))
            * (1.0 - smoothstep(0.35, 0.58, an.y));
        let wFoliage = smoothstep(0.015, 0.06, srgbPigment.g - srgbPigment.r * 1.02)
            * smoothstep(0.03, 0.10, srgbPigment.g - srgbPigment.b);
        let wBamboo = smoothstep(0.42, 0.52, srgbLuma) * (1.0 - smoothstep(0.70, 0.78, srgbLuma))
            * smoothstep(0.10, 0.22, srgbPigment.r - srgbPigment.b)
            * smoothstep(0.06, 0.16, srgbPigment.g - srgbPigment.b)
            * (1.0 - smoothstep(0.10, 0.18, abs(srgbPigment.r - srgbPigment.g)))
            * (1.0 - wFoliage);
        let wTimber = smoothstep(0.06, 0.14, srgbPigment.r - srgbPigment.b * 1.15)
            * smoothstep(0.02, 0.09, srgbPigment.r - srgbPigment.g)
            * (1.0 - smoothstep(0.54, 0.65, srgbLuma))
            * smoothstep(0.10, 0.18, srgbLuma)
            * (1.0 - wBamboo) * (1.0 - wFoliage);
        let wStone = smoothstep(0.32, 0.42, srgbLuma) * (1.0 - smoothstep(0.66, 0.74, srgbLuma))
            * (1.0 - smoothstep(0.10, 0.17, sat))
            * (1.0 - wPlaster) * (1.0 - wRoof);

        // Select dominant atlas cell (single seam-free 4x anisotropic textureSampleGrad per fragment!)
        var matCol = 2.0;
        var matRow = 1.0; // neutral slot
        var matFreq = 0.85;
        var matStrength = 0.0;
        var bestW = 0.18;

        if (wRoof > bestW) {
            bestW = wRoof; matCol = 0.0; matRow = 0.0; matFreq = 0.88; matStrength = 0.82 * wRoof;
        }
        if (wPlaster > bestW) {
            bestW = wPlaster; matCol = 1.0; matRow = 0.0; matFreq = 0.66; matStrength = 0.52 * wPlaster;
        }
        if (wTimber > bestW) {
            bestW = wTimber; matCol = 2.0; matRow = 0.0; matFreq = 0.96; matStrength = 0.78 * wTimber;
        }
        if (wStone > bestW) {
            bestW = wStone; matCol = 3.0; matRow = 0.0; matFreq = 0.80; matStrength = 0.82 * wStone;
        }
        if (wFoliage > bestW) {
            bestW = wFoliage; matCol = 0.0; matRow = 1.0; matFreq = 1.08; matStrength = 0.80 * wFoliage;
        }
        if (wBamboo > bestW) {
            bestW = wBamboo; matCol = 1.0; matRow = 1.0; matFreq = 1.12; matStrength = 0.78 * wBamboo;
        }

        if (matStrength > 0.01) {
            let matRgb = sample_material_tile(matCol, matRow, tri, triDx, triDy, matFreq);
            let matRatio = clamp(matRgb / vec3<f32>(0.50), vec3<f32>(0.58), vec3<f32>(1.42));
            let matRatioLuma = dot(matRatio, vec3<f32>(0.299, 0.587, 0.114));
            let matTint = mix(vec3<f32>(matRatioLuma), matRatio, 0.62);
            albedo *= mix(vec3<f32>(1.0), matTint, matStrength);
            matRelief = dot(matRgb, vec3<f32>(0.299, 0.587, 0.114));
            matReliefStr = matStrength * 0.24;
        }

        // Gentle Huizhou plaster base moisture weathering
        if (wPlaster > 0.01) {
            let baseWeather = smoothstep(0.42, 0.0, in.localPos.y);
            albedo = mix(albedo, albedo * vec3<f32>(0.91, 0.88, 0.81), wPlaster * baseWeather * 0.32);
        }

        albedo *= clamp(surfMod, 0.72, 1.22);
        translucencyFactor = mix(0.03, 0.14, dayF);
    } else if (in.flags == FLAG_WINDOW_GLOW) {
        let srgbPigment = max(in.aoTint.rgb, vec3<f32>(0.05));
        let linPigment = pow(srgbPigment, vec3<f32>(2.2));
        let wUv = triplanar_dominant_uv(in.localPos, in.localNormal) * 1.8;
        let dwx = triplanar_dominant_uv(dLp_dx, in.localNormal) * 1.8;
        let dwy = triplanar_dominant_uv(dLp_dy, in.localNormal) * 1.8;
        let cf = textureSampleGrad(cardFibreTex, tileSmp, wUv, dwx, dwy);
        let paneGrain = clamp(0.84 + (cf.b - 0.5) * 0.40 + (cf.a - 0.5) * 0.32, 0.68, 1.14);

        let centered = (in.uv - vec2<f32>(0.5, 0.44)) * 2.0;
        let edgeT = clamp(dot(centered, centered) * 0.85, 0.0, 1.0);
        let isLantern = smoothstep(0.22, 0.44, srgbPigment.r - srgbPigment.g);

        let winCore = vec3<f32>(1.00, 0.78, 0.30);
        let winEdge = vec3<f32>(0.82, 0.25, 0.032);
        let winGrad = mix(winCore, winEdge, edgeT);

        let lanCore = vec3<f32>(1.00, 0.30, 0.036);
        let lanEdge = vec3<f32>(0.78, 0.052, 0.010);
        let lanGrad = mix(lanCore, lanEdge, edgeT);

        let styledColor = mix(winGrad, lanGrad, isLantern);
        let warmGlow = mix(linPigment, styledColor, 0.65) * paneGrain;

        let paneSeed = 0.78 + 0.42 * in.aoTint.a;
        let cellVar = 0.88 + 0.24 * hash21(floor(in.worldPos.xz * 2.2) + vec2<f32>(floor(in.worldPos.y * 2.0)));
        let variation = mix(paneSeed * cellVar, 0.96 + 0.16 * in.aoTint.a, isLantern);

        albedo = warmGlow * 0.78;
        let glowPower = (mix(0.38, 0.68, isLantern) + lampInt * mix(0.88, 1.32, isLantern)) * variation;
        let flicker = 1.0 + 0.035 * sin(frame.lampColor_time.w * 2.4 + in.worldPos.x * 3.1 + in.worldPos.z * 2.7);
        emissiveCol = warmGlow * glowPower * flicker;
        fibreNormal = (cf.xy - vec2<f32>(0.5)) * 0.5;
        normalStrength = 0.25;
    } else if (in.flags == FLAG_CUT_EDGE) {
        let edge = textureSampleGrad(cutEdgeTex, tileSmp, in.uv, dxB, dyB).rgb;
        albedo = edge * vec3<f32>(0.84, 0.77, 0.65) * in.aoTint.rgb;
        normalStrength = 0.15;
    } else if (in.flags == FLAG_BOOK_EDGE) {
        let edge = textureSampleGrad(cutEdgeTex, tileSmp, in.uv, dxB, dyB).rgb;
        albedo = edge * vec3<f32>(0.82, 0.74, 0.62) * in.aoTint.rgb;
        normalStrength = 0.20;
    } else if (in.flags == FLAG_RAIL) {
        let rUv = triplanar_dominant_uv(in.localPos, in.localNormal) * 1.35;
        let drx = triplanar_dominant_uv(dLp_dx, in.localNormal) * 1.35;
        let dry = triplanar_dominant_uv(dLp_dy, in.localNormal) * 1.35;
        let cf = textureSampleGrad(cardFibreTex, tileSmp, rUv, drx, dry);
        let cfCrumple = textureSampleGrad(cardFibreTex, tileSmp, rUv * 0.32 + vec2<f32>(0.13), drx * 0.32, dry * 0.32);
        albedo = vec3<f32>(0.36, 0.22, 0.12) * clamp(1.0 + (cf.b - 0.5) * 0.75, 0.78, 1.22) * in.aoTint.rgb;
        fibreNormal = cf.xy - vec2<f32>(0.5);
        crumpleNormal = (cfCrumple.xy - vec2<f32>(0.5)) * 0.5;
        normalStrength = 0.55;
    }

    // Uniform-flow micro-relief normal perturbation from painted material tile luminance
    let dMatX = dpdx(matRelief);
    let dMatY = dpdy(matRelief);
    let matReliefN = clamp(vec2<f32>(-dMatX, -dMatY) * 12.0, vec2<f32>(-0.30), vec2<f32>(0.30)) * matReliefStr;

    var N = normalize(in.worldNormal);
    let pn = (fibreNormal + crumpleNormal) * normalStrength + matReliefN;
    let upRef = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 0.0), abs(N.y) < 0.9);
    let T = normalize(cross(upRef, N));
    let B = cross(N, T);
    N = normalize(N + T * pn.x + B * pn.y);

    let wrap = frame.keyColor_wrap.w;
    let ndotl_raw = dot(N, L);
    let ndotl = clamp((ndotl_raw + wrap) / (1.0 + wrap), 0.0, 1.0);

    let backLit = pow(clamp((-ndotl_raw + 0.1) / 1.1, 0.0, 1.0), 1.35) * clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0);
    let transColor = mix(vec3<f32>(0.45, 0.60, 1.0), vec3<f32>(1.0, 0.70, 0.42), dayF);
    let transTint = transColor * backLit * translucencyFactor;

    var vis = 1.0;
    if (in.flags != FLAG_WINDOW_GLOW && frame.shadowLeak_str.w >= 0.01 && ndotl_raw > -wrap) {
        vis = compute_pcss_shadow(in.shadowPos, N, L, in.position.xy);
    }
    let shadowTint = mix(frame.shadowLeak_str.rgb, vec3<f32>(1.0), vis);

    let fillDir = normalize(V * 0.85 + vec3<f32>(0.0, 0.35, 0.0));
    let fillNdotL = clamp((dot(N, fillDir) + 0.35) / 1.35, 0.0, 1.0);
    let fillColor = mix(vec3<f32>(0.32, 0.46, 0.88), vec3<f32>(0.95, 0.86, 0.74), dayF);
    let fillWeight = mix(0.13, 0.22, dayF);
    let frontalFill = fillColor * (frame.keyDir_intensity.w * fillWeight) * fillNdotL * mix(0.65, 1.0, vis);

    let hemiT = N.y * 0.5 + 0.5;
    let hemi = mix(frame.groundColor_exp.rgb, frame.skyColor_hemi.rgb, hemiT) * frame.skyColor_hemi.w;
    let shadowBounce = frame.shadowLeak_str.rgb * (1.0 - vis) * 0.14;

    let direct = frame.keyColor_wrap.rgb * frame.keyDir_intensity.w * (ndotl + transTint) * shadowTint;
    var lit = albedo * (hemi + direct + frontalFill + shadowBounce);

    let goboT = clamp(dot(in.worldPos - frame.camTarget_slabHalf.xyz, frame.camRight_gobo.xyz) / 8.8, -1.0, 1.0);
    let goboFalloff = 1.0 - frame.camRight_gobo.w * goboT;
    let goboWarm = vec3<f32>(1.06, 0.94, 0.80);
    let goboCool = vec3<f32>(0.90, 0.95, 1.05);
    let goboGrade = mix(vec3<f32>(1.0), mix(goboWarm, goboCool, goboT * 0.5 + 0.5), smoothstep(0.10, 0.70, dayF));
    lit *= goboFalloff * goboGrade;

    if (lampInt > 0.01) {
        var mask = light_grid_mask(in.worldPos.xz);
        if (mask != 0u) {
            var poolAccum = vec3<f32>(0.0);
            var waterReflAccum = 0.0;
            let toCamXZ = normalize(vec3<f32>(V.x, 0.0, V.z) + vec3<f32>(1e-4, 0.0, 0.0));
            let albedoLuma = dot(albedo, vec3<f32>(0.299, 0.587, 0.114));
            let stoneContrast = mix(1.0, 0.66, smoothstep(0.26, 0.52, albedoLuma) * (1.0 - dayF));
            while (mask != 0u) {
                let i = countTrailingZeros(mask);
                mask &= mask - 1u;
                let lp = frame.lampPools[i];
                let rad = abs(lp.w);
                if (rad <= 0.01) { continue; }
                let toLamp = lp.xyz - in.worldPos;
                let d2 = dot(toLamp, toLamp);
                let rad2 = rad * rad;
                if (d2 >= rad2 && (waterMask <= 0.02 || d2 >= 12.96)) { continue; }
                let isDirectLantern = lp.w > 0.0;
                if (d2 < rad2) {
                    let d = sqrt(d2);
                    let f = 1.0 - d / rad;
                    let atten = f * f * (0.45 + 0.55 * f);
                    let lampWrap = clamp((dot(N, toLamp / max(d, 1e-4)) + 0.42) / 1.42, 0.12, 1.0);
                    let waterDamp = mix(1.0, 0.24, waterMask);
                    let dirW = select(0.72, 1.0, isDirectLantern);
                    poolAccum += frame.lampColor_time.rgb * (atten * lampWrap * waterDamp * dirW);
                }
                if (waterMask > 0.02 && d2 < 12.96) {
                    let dVec = vec3<f32>(in.worldPos.x - lp.x, 0.0, in.worldPos.z - lp.z);
                    let along = dot(dVec, toCamXZ);
                    let lateral = length(dVec - toCamXZ * along);
                    let streakAlong = smoothstep(-0.55, 0.22, along) * smoothstep(2.65, 0.15, along);
                    let streakWidth = 0.13 + max(along, 0.0) * 0.11;
                    let streakLat = exp(-(lateral * lateral) / streakWidth);
                    let rippleWave = 0.68 + 0.32 * sin(in.worldPos.x * 12.0 + in.worldPos.z * 9.5 + waterRipple * 9.0);
                    let weight = select(0.16, 1.0, isDirectLantern);
                    waterReflAccum += streakAlong * streakLat * rippleWave * weight;
                }
            }
            lit += albedo * poolAccum * (lampInt * 0.33 * stoneContrast);

            if (waterMask > 0.02 && waterReflAccum > 0.005) {
                let nightWaterBoost = mix(1.0, 0.12, smoothstep(0.15, 0.85, dayF));
                let compressed = waterReflAccum / (1.0 + waterReflAccum * 0.55);
                let reflStrength = compressed * waterMask * lampInt * 0.115 * nightWaterBoost;
                let goldenVermilion = mix(vec3<f32>(0.84, 0.088, 0.014), vec3<f32>(1.00, 0.265, 0.036), clamp(compressed * 0.85, 0.0, 1.0));
                lit += goldenVermilion * reflStrength;
                emissiveCol += goldenVermilion * (reflStrength * 0.28 * (1.0 - dayF));
            }
        }
    }

    if (waterMask > 0.02) {
        let fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        let waterSkySheen = mix(vec3<f32>(0.18, 0.30, 0.56), vec3<f32>(0.75, 0.86, 0.88), dayF);
        lit += waterSkySheen * (fresnel * waterMask * 0.18);
    }

    lit += emissiveCol;
    if (in.highlight > 0.01) {
        let fres = pow(1.0 - abs(dot(N, V)), 2.0);
        lit += vec3<f32>(1.0, 0.90, 0.58) * (in.highlight * (0.14 + 0.24 * fres));
    } else if (in.highlight < -0.01) {
        // Vermilion-red pulsing warning glow for blocked / invalid editor placements
        let warnAmt = min(-in.highlight, 1.5);
        let fres = pow(1.0 - abs(dot(N, V)), 1.8);
        let pulse = 0.84 + 0.16 * sin(frame.lampColor_time.w * 7.5);
        let vermilion = vec3<f32>(0.96, 0.14, 0.06);
        lit = mix(lit, vermilion * 0.85, clamp(warnAmt * 0.28, 0.0, 0.40));
        lit += vermilion * (warnAmt * (0.22 + 0.42 * fres) * pulse);
        emissiveCol += vermilion * (warnAmt * 0.35 * pulse);
    }

    let focusDist = length(in.worldPos.xz - frame.camTarget_slabHalf.xz);
    let fogK = smoothstep(7.4, 13.5, focusDist) * mix(0.42, 0.16, dayF);
    lit = mix(lit, frame.fogColor_lampInt.rgb * mix(0.42, 0.72, dayF), fogK);

    let emPeak = max(emissiveCol.r, max(emissiveCol.g, emissiveCol.b));
    let bloomMask = clamp(emPeak * 0.85, 0.0, 1.0);

    // Output front-oriented geometric view-space normal + linear view depth for Pass 4 AO & Pass 5 ink outlines
    let rawGeoN = normalize(in.worldNormal);
    let geoN = select(-rawGeoN, rawGeoN, isFront);
    let viewGeoN = normalize(vec3<f32>(
        dot(geoN, frame.camRight_gobo.xyz),
        dot(geoN, frame.camUp_dayFactor.xyz),
        -dot(geoN, frame.camFwd_bloomStr.xyz)
    ));
    let linZ = clamp(dot(in.worldPos - frame.camPos_aspect.xyz, frame.camFwd_bloomStr.xyz), 0.1, 490.0);
    return SceneFragOut(
        vec4<f32>(lit, bloomMask),
        encode_oct_unorm(viewGeoN),
        linZ
    );
}

// -----------------------------------------------------------------------------
// Pass 3: 1/4-Resolution Emissive-Masked Separable Gaussian Bloom
// -----------------------------------------------------------------------------

@group(1) @binding(0) var postTex0: texture_2d<f32>;
@group(1) @binding(1) var postSmp: sampler;

@fragment
fn bloom_extract_fs(in: QuadOut) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(postTex0));
    let texel = vec2<f32>(1.0) / max(dims, vec2<f32>(1.0));

    let s0 = textureSampleLevel(postTex0, postSmp, in.uv + vec2<f32>(-1.0, -1.0) * texel, 0.0);
    let s1 = textureSampleLevel(postTex0, postSmp, in.uv + vec2<f32>( 1.0, -1.0) * texel, 0.0);
    let s2 = textureSampleLevel(postTex0, postSmp, in.uv + vec2<f32>(-1.0,  1.0) * texel, 0.0);
    let s3 = textureSampleLevel(postTex0, postSmp, in.uv + vec2<f32>( 1.0,  1.0) * texel, 0.0);

    var avg = (s0.rgb * s0.a + s1.rgb * s1.a + s2.rgb * s2.a + s3.rgb * s3.a) * 0.25;
    avg = clamp(avg, vec3<f32>(0.0), vec3<f32>(4.5));
    return vec4<f32>(avg, 1.0);
}

@fragment
fn bloom_blur_h_fs(in: QuadOut) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(postTex0));
    let texelX = 1.0 / max(dims.x, 1.0);
    var offsets = array<f32, 4>(0.0, 1.44, 3.36, 5.28);
    var weights = array<f32, 4>(0.1964, 0.2969, 0.0945, 0.0104);

    var sum = textureSampleLevel(postTex0, postSmp, in.uv, 0.0).rgb * weights[0];
    for (var i = 1; i < 4; i = i + 1) {
        let off = vec2<f32>(offsets[i] * texelX, 0.0);
        sum += textureSampleLevel(postTex0, postSmp, in.uv + off, 0.0).rgb * weights[i];
        sum += textureSampleLevel(postTex0, postSmp, in.uv - off, 0.0).rgb * weights[i];
    }
    return vec4<f32>(sum, 1.0);
}

@fragment
fn bloom_blur_v_fs(in: QuadOut) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(postTex0));
    let texelY = 1.0 / max(dims.y, 1.0);
    var offsets = array<f32, 4>(0.0, 1.44, 3.36, 5.28);
    var weights = array<f32, 4>(0.1964, 0.2969, 0.0945, 0.0104);

    var sum = textureSampleLevel(postTex0, postSmp, in.uv, 0.0).rgb * weights[0];
    for (var i = 1; i < 4; i = i + 1) {
        let off = vec2<f32>(0.0, offsets[i] * texelY);
        sum += textureSampleLevel(postTex0, postSmp, in.uv + off, 0.0).rgb * weights[i];
        sum += textureSampleLevel(postTex0, postSmp, in.uv - off, 0.0).rgb * weights[i];
    }
    return vec4<f32>(sum, 1.0);
}

// -----------------------------------------------------------------------------
// Pass 4: Half-Res Exact-Normal Depth Contact AO + Macro Hybrid Tilt-Shift CoC
// -----------------------------------------------------------------------------

@group(1) @binding(0) var aoSceneLinZ: texture_2d<f32>;
@group(1) @binding(1) var aoSceneNormal: texture_2d<f32>;
@group(1) @binding(2) var aoBlueNoise: texture_2d<f32>;

fn load_scene_linz(uv: vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(aoSceneLinZ));
    let coord = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - vec2<f32>(1.0)));
    return textureLoad(aoSceneLinZ, coord, 0).r;
}

fn load_scene_normal(uv: vec2<f32>) -> vec2<f32> {
    let dims = vec2<f32>(textureDimensions(aoSceneNormal));
    let coord = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - vec2<f32>(1.0)));
    return textureLoad(aoSceneNormal, coord, 0).rg;
}

fn reconstruct_view_pos(uv: vec2<f32>, z: f32, tanHalf: f32, aspect: f32) -> vec3<f32> {
    return vec3<f32>((uv * 2.0 - vec2<f32>(1.0)) * vec2<f32>(tanHalf * aspect, -tanHalf) * z, -z);
}

@fragment
fn ao_coc_fs(in: QuadOut) -> @location(0) vec2<f32> {
    let z = load_scene_linz(in.uv);
    let tanHalf = frame.projParams.z;
    let aspect = frame.camPos_aspect.w;
    let focusZ = frame.projParams.w;

    let focusY = frame.tiltA.x;
    let halfBand = frame.tiltA.y;
    let ramp = frame.tiltA.z;
    let depthW = frame.tiltA.w;

    let sY = focusY - in.uv.y;
    let dofEnabled = frame.tiltB.x > 0.01;
    if (z > 500.0) {
        let bgCoc = select(0.0, clamp(0.28 + abs(sY) * 0.65, 0.28, 0.72), dofEnabled);
        return vec2<f32>(1.0, bgCoc);
    }

    let sD = (z - focusZ) / max(focusZ, 1.0) * 1.22;
    let c = mix(sY, sD, depthW);
    var blurMag = clamp((abs(c) - halfBand) / max(ramp, 0.01), 0.0, 1.0);
    blurMag = blurMag * blurMag * (3.0 - 2.0 * blurMag) * 0.40 + blurMag * 0.60;
    let nearGain = select(1.0, 1.55, c < 0.0);
    let signedCoc = select(0.0, select(1.0, -1.0, c < 0.0) * min(blurMag * nearGain, 1.0), dofEnabled);

    let P = reconstruct_view_pos(in.uv, z, tanHalf, aspect);
    let N = decode_oct_unorm(load_scene_normal(in.uv));

    let bnCoord = vec2<i32>(i32(in.position.x) & 63, i32(in.position.y) & 63);
    let ang = textureLoad(aoBlueNoise, bnCoord, 0).g * 6.2831853;
    let radius = frame.tiltB.y;
    let rUv = radius / (z * tanHalf * 2.0);
    var occ = 0.0;
    for (var i = 0; i < 10; i = i + 1) {
        let a = ang + f32(i) * 0.6283185;
        let isNear = i < 5;
        let radScale = select(1.05, 0.42, isNear);
        let rad = ((f32(i % 5) + 0.5) / 5.0) * radScale;
        let suv = in.uv + vec2<f32>(cos(a), sin(a)) * (rUv * rad);
        let sz = load_scene_linz(suv);
        if (sz > 500.0) { continue; }
        let sp = reconstruct_view_pos(suv, sz, tanHalf, aspect);
        let diff = sp - P;
        let dl = length(diff);
        let maxD = radius * select(2.5, 1.4, isNear);
        if (dl > 1e-3 && dl < maxD) {
            let horizon = max(0.0, dot(N, diff / dl) - 0.11);
            let atten = 1.0 - clamp(dl / maxD, 0.0, 1.0);
            occ += horizon * atten * select(0.85, 1.25, isNear);
        }
    }
    var ao = clamp(1.0 - (occ / 10.0) * frame.tiltB.z * 2.45, 0.34, 1.0);
    ao = mix(ao, 1.0, smoothstep(0.35, 0.95, abs(signedCoc)) * 0.55);
    return vec2<f32>(ao, signedCoc);
}

// -----------------------------------------------------------------------------
// Pass 5: 36-Tap Golden-Angle Bokeh + Warm Ink/Crease Outlines + CAS + Bloom + ACES
// -----------------------------------------------------------------------------

@group(1) @binding(0) var compSceneTex: texture_2d<f32>;
@group(1) @binding(1) var compAoCocTex: texture_2d<f32>;
@group(1) @binding(2) var compBloomTex: texture_2d<f32>;
@group(1) @binding(3) var compBlueNoise: texture_2d<f32>;
@group(1) @binding(4) var compSmp: sampler;
@group(1) @binding(5) var compNormalTex: texture_2d<f32>;
@group(1) @binding(6) var compLinZTex: texture_2d<f32>;

// Precomputed 36-tap Golden-Angle spiral bokeh kernel: (cos(a)*r_norm, sin(a)*r_norm, radialWeight)
const BOKEH_TAPS: array<vec3<f32>, 36> = array<vec3<f32>, 36>(
    vec3<f32>(-0.045753,  0.041913, 0.624146),
    vec3<f32>( 0.011079, -0.126240, 0.680419),
    vec3<f32>( 0.107469,  0.140174, 0.713612),
    vec3<f32>(-0.216450, -0.038287, 0.738424),
    vec3<f32>( 0.218378, -0.138914, 0.758661),
    vec3<f32>(-0.076551,  0.284766, 0.775952),
    vec3<f32>(-0.151499, -0.291702, 0.791162),
    vec3<f32>( 0.338850,  0.123747, 0.804811),
    vec3<f32>(-0.361710,  0.149309, 0.817239),
    vec3<f32>( 0.178292, -0.381000, 0.828682),
    vec3<f32>( 0.134357,  0.428351, 0.839310),
    vec3<f32>(-0.412078, -0.238807, 0.849251),
    vec3<f32>( 0.491072, -0.107961, 0.858604),
    vec3<f32>(-0.304008,  0.432421, 0.867447),
    vec3<f32>(-0.071160, -0.549132, 0.875843),
    vec3<f32>( 0.442162,  0.372654, 0.883843),
    vec3<f32>(-0.601723,  0.024883, 0.891489),
    vec3<f32>( 0.443527, -0.441369, 0.898817),
    vec3<f32>(-0.029965,  0.648039, 0.905857),
    vec3<f32>(-0.430117, -0.515424, 0.912636),
    vec3<f32>( 0.687302,  0.092475, 0.919176),
    vec3<f32>(-0.587160,  0.408531, 0.925496),
    vec3<f32>( 0.161703, -0.718789, 0.931614),
    vec3<f32>( 0.376801,  0.657567, 0.937544),
    vec3<f32>(-0.741847, -0.236669, 0.943300),
    vec3<f32>( 0.725505, -0.335202, 0.948894),
    vec3<f32>(-0.316350,  0.755905, 0.954336),
    vec3<f32>(-0.284098, -0.789863, 0.959637),
    vec3<f32>( 0.760482,  0.399687, 0.964804),
    vec3<f32>(-0.849573,  0.223945, 0.969846),
    vec3<f32>( 0.485584, -0.755197, 0.974769),
    vec3<f32>( 0.155296,  0.903617, 0.979581),
    vec3<f32>(-0.739771, -0.572919, 0.984287),
    vec3<f32>( 0.951036, -0.078792, 0.988892),
    vec3<f32>(-0.660550,  0.714037, 0.993403),
    vec3<f32>( 0.004833, -0.990938, 0.997823)
);

fn aces_filmic(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + vec3<f32>(0.03))) / (x * (2.43 * x + vec3<f32>(0.59)) + vec3<f32>(0.14)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn fxaa_luma(c: vec3<f32>) -> f32 {
    // Perceptual sqrt-luma on linear HDR gives balanced AA sensitivity on dark slate tiles & bright eaves
    return sqrt(max(dot(c, vec3<f32>(0.299, 0.587, 0.114)), 0.0));
}

@fragment
fn composite_fs(in: QuadOut) -> @location(0) vec4<f32> {
    let sharp = textureSampleLevel(compSceneTex, compSmp, in.uv, 0.0);
    let ac = textureSampleLevel(compAoCocTex, compSmp, in.uv, 0.0).rg;
    let ao = ac.r;
    let signedCoc = ac.g;
    let coc = abs(signedCoc);

    let maxBlur = frame.tiltB.x;
    let dims = vec2<f32>(textureDimensions(compSceneTex));
    let texel = vec2<f32>(1.0) / max(dims, vec2<f32>(1.0));
    let bnCoord = vec2<i32>(i32(in.position.x) & 63, i32(in.position.y) & 63);
    let bnVal = textureLoad(compBlueNoise, bnCoord, 0).r;
    let isInteractive = frame.quality_pad.x > 0.5;

    var col = sharp.rgb;
    if (coc > 0.015 && maxBlur > 0.01) {
        var taps = 36;
        var radNormScale = 1.0;
        if (isInteractive) {
            if (coc < 0.25) {
                taps = 12;
                radNormScale = 2.042748; // (36/12)^0.65
            } else if (coc < 0.65) {
                taps = 20;
                radNormScale = 1.465392; // (36/20)^0.65
            } else {
                taps = 28;
                radNormScale = 1.177487; // (36/28)^0.65
            }
        }
        var blurAcc = sharp.rgb * 0.60;
        var wAcc = 0.60;
        let rPx = coc * maxBlur * radNormScale;
        let jAng = bnVal * (6.2831853 * 0.28);
        let jc = cos(jAng);
        let js = sin(jAng);
        let jRot = mat2x2<f32>(vec2<f32>(jc, js), vec2<f32>(-js, jc));
        var bokehTaps = BOKEH_TAPS;
        for (var i = 0; i < taps; i = i + 1) {
            let tap = bokehTaps[i];
            let suv = in.uv + (jRot * tap.xy) * rPx * texel;
            let sAc = textureSampleLevel(compAoCocTex, compSmp, suv, 0.0).rg;
            let sCoc = abs(sAc.g);
            let scatterW = select(
                smoothstep(0.0, 0.28, sCoc + coc * 0.52),
                smoothstep(0.0, 0.24, sCoc),
                sAc.g < -0.05
            );
            let sSamp = textureSampleLevel(compSceneTex, compSmp, suv, 0.0);
            let hiBoost = 1.0 + min(sSamp.a * 1.35, 1.35);
            let w = scatterW * hiBoost * tap.z;
            blurAcc += sSamp.rgb * w;
            wAcc += w;
        }
        let blurred = blurAcc / max(wAcc, 1e-4);
        col = mix(col, blurred, smoothstep(0.015, 0.34, coc));
    }

    if (isInteractive && coc <= 0.10) {
        // Subpixel FXAA 3.11 + FidelityFX Contrast-Adaptive Sharpening (CAS) in-place (0 extra passes!)
        let cN  = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>( 0.0, -texel.y), 0.0).rgb;
        let cS  = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>( 0.0,  texel.y), 0.0).rgb;
        let cW  = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>(-texel.x,  0.0), 0.0).rgb;
        let cE  = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>( texel.x,  0.0), 0.0).rgb;
        let cNW = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>(-texel.x, -texel.y), 0.0).rgb;
        let cNE = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>( texel.x, -texel.y), 0.0).rgb;
        let cSW = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>(-texel.x,  texel.y), 0.0).rgb;
        let cSE = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>( texel.x,  texel.y), 0.0).rgb;

        let lM  = fxaa_luma(col);
        let lN  = fxaa_luma(cN);
        let lS  = fxaa_luma(cS);
        let lW  = fxaa_luma(cW);
        let lE  = fxaa_luma(cE);
        let lNW = fxaa_luma(cNW);
        let lNE = fxaa_luma(cNE);
        let lSW = fxaa_luma(cSW);
        let lSE = fxaa_luma(cSE);

        let lumaMin = min(lM, min(min(lN, lS), min(lW, lE)));
        let lumaMax = max(lM, max(max(lN, lS), max(lW, lE)));
        let lumaRange = lumaMax - lumaMin;

        var aaCol = col;
        if (lumaRange >= max(0.065, lumaMax * 0.18)) {
            let dirX = -((lNW + lNE) - (lSW + lSE));
            let dirY =  ((lNW + lSW) - (lNE + lSE));
            let dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
            let rcpDirMin = 1.0 / (min(abs(dirX), abs(dirY)) + dirReduce);
            let dir = clamp(vec2<f32>(dirX, dirY) * rcpDirMin, vec2<f32>(-3.5), vec2<f32>(3.5)) * texel;

            let sA0 = textureSampleLevel(compSceneTex, compSmp, in.uv + dir * (-0.166667), 0.0).rgb;
            let sA1 = textureSampleLevel(compSceneTex, compSmp, in.uv + dir * ( 0.166667), 0.0).rgb;
            let rgbA = (sA0 + sA1) * 0.5;
            let sB0 = textureSampleLevel(compSceneTex, compSmp, in.uv + dir * (-0.5), 0.0).rgb;
            let sB1 = textureSampleLevel(compSceneTex, compSmp, in.uv + dir * ( 0.5), 0.0).rgb;
            let rgbB = rgbA * 0.5 + (sB0 + sB1) * 0.25;
            let lumaB = fxaa_luma(rgbB);
            let edgeCol = select(rgbB, rgbA, lumaB < lumaMin || lumaB > lumaMax);

            // Light subpixel polish alongside hardware 4x MSAA (zero smearing on crisp paper grain)
            let avg4 = (lN + lS + lW + lE) * 0.25;
            let subpix = clamp(abs(avg4 - lM) / max(lumaRange, 1e-4), 0.0, 1.0);
            let subpixW = smoothstep(0.0, 1.0, subpix);
            let avgCol = (cN + cS + cW + cE) * 0.25;
            aaCol = mix(edgeCol, avgCol, subpixW * subpixW * 0.16);
        }

        // Gentle FidelityFX Contrast-Adaptive Sharpening (CAS ~0.24, zero halos with 4x MSAA)
        let minRGB = min(aaCol, min(min(cN, cS), min(cW, cE)));
        let maxRGB = max(aaCol, max(max(cN, cS), max(cW, cE)));
        let amp = sqrt(clamp(
            min(minRGB, max(vec3<f32>(2.0) - maxRGB, vec3<f32>(0.0))) / max(maxRGB, vec3<f32>(1e-4)),
            vec3<f32>(0.0),
            vec3<f32>(1.0)
        ));
        let casW = amp * (-0.115);
        let casCol = clamp(
            (aaCol + (cN + cS + cW + cE) * casW) / max(vec3<f32>(1.0) + casW * 4.0, vec3<f32>(0.30)),
            minRGB * 0.95,
            maxRGB * 1.05
        );
        let sharpBlend = 1.0 - smoothstep(0.02, 0.10, coc);
        col = mix(col, casCol, sharpBlend);
    } else if (coc <= 0.015) {
        let nL = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>(-texel.x, 0.0), 0.0).rgb;
        let nR = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>( texel.x, 0.0), 0.0).rgb;
        let nU = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>(0.0, -texel.y), 0.0).rgb;
        let nD = textureSampleLevel(compSceneTex, compSmp, in.uv + vec2<f32>(0.0,  texel.y), 0.0).rgb;
        let blur4 = (nL + nR + nU + nD) * 0.25;
        let detail = clamp(col - blur4, vec3<f32>(-0.14), vec3<f32>(0.14));
        col += detail * 0.16;
    }

    let dayF = frame.camUp_dayFactor.w;

    // Full-Res Papertrails-Style Warm Sepia Pen-and-Ink Silhouettes, Fold Creases & Sunlit Cut-Paper Rim
    let iDims = vec2<i32>(textureDimensions(compLinZTex));
    let px = clamp(vec2<i32>(in.position.xy), vec2<i32>(0), iDims - vec2<i32>(1));
    let z0 = textureLoad(compLinZTex, px, 0).r;
    if (z0 < 500.0 && coc < 0.38) {
        let pL = vec2<i32>(max(px.x - 1, 0), px.y);
        let pR = vec2<i32>(min(px.x + 1, iDims.x - 1), px.y);
        let pU = vec2<i32>(px.x, max(px.y - 1, 0));
        let pD = vec2<i32>(px.x, min(px.y + 1, iDims.y - 1));

        let zL = textureLoad(compLinZTex, pL, 0).r;
        let zR = textureLoad(compLinZTex, pR, 0).r;
        let zU = textureLoad(compLinZTex, pU, 0).r;
        let zD = textureLoad(compLinZTex, pD, 0).r;

        let n0 = decode_oct_unorm(textureLoad(compNormalTex, px, 0).rg);
        let nL = decode_oct_unorm(textureLoad(compNormalTex, pL, 0).rg);
        let nR = decode_oct_unorm(textureLoad(compNormalTex, pR, 0).rg);
        let nU = decode_oct_unorm(textureLoad(compNormalTex, pU, 0).rg);
        let nD = decode_oct_unorm(textureLoad(compNormalTex, pD, 0).rg);

        // Foreground-anchored silhouette jump (compensates oblique grazing ground)
        let grazing = 1.0 + (1.0 - clamp(n0.z, 0.15, 1.0)) * 2.1;
        let dzFg = max(max(zL - z0, zR - z0), max(zU - z0, zD - z0));
        let depthEdge = smoothstep(0.030 * grazing, 0.082 * grazing, dzFg / max(z0, 1.0));

        // Architectural & origami fold crease (ignore backdrop neighbors)
        let dL = select(1.0, dot(n0, nL), zL < 500.0);
        let dR = select(1.0, dot(n0, nR), zR < 500.0);
        let dU = select(1.0, dot(n0, nU), zU < 500.0);
        let dD = select(1.0, dot(n0, nD), zD < 500.0);
        let minDot = min(min(dL, dR), min(dU, dD));
        let creaseEdge = smoothstep(0.28, 0.62, 1.0 - minDot);

        let focusFade = 1.0 - smoothstep(0.06, 0.38, coc);
        let timeFade = mix(0.32, 1.0, dayF);
        let inkAmt = clamp(max(depthEdge * 0.48, creaseEdge * 0.30), 0.0, 0.52) * focusFade * timeFade;
        col = mix(col, col * vec3<f32>(0.46, 0.37, 0.30), inkAmt);

        // Subtle 1px warm sunlit cut-paper rim on convex key-lit edges
        let L = normalize(frame.keyDir_intensity.xyz);
        let viewL = normalize(vec3<f32>(
            dot(L, frame.camRight_gobo.xyz),
            dot(L, frame.camUp_dayFactor.xyz),
            -dot(L, frame.camFwd_bloomStr.xyz)
        ));
        let facingKey = smoothstep(0.08, 0.55, dot(n0, viewL));
        let topEdge = smoothstep(0.025, 0.075, max(zU - z0, 0.0) / max(z0, 1.0));
        let litRim = clamp(max(topEdge, creaseEdge * 0.65) * facingKey, 0.0, 1.0) * focusFade * mix(0.14, 1.0, dayF);
        col = mix(col, vec3<f32>(0.95, 0.90, 0.78), litRim * 0.16);
    }

    let aoTintColor = mix(vec3<f32>(0.08, 0.12, 0.30), vec3<f32>(0.36, 0.20, 0.09), dayF);
    col *= mix(aoTintColor, vec3<f32>(1.0), ao);

    let bloom = textureSampleLevel(compBloomTex, compSmp, in.uv, 0.0).rgb;
    col += bloom * frame.camFwd_bloomStr.w;

    let wb = mix(vec3<f32>(0.94, 0.96, 1.06), vec3<f32>(1.03, 0.985, 0.96), dayF);
    col *= frame.groundColor_exp.w * wb;

    let dv = in.uv * 2.0 - vec2<f32>(1.0);
    let vigAmt = frame.tiltB.w * mix(0.75, 0.28, dayF);
    let vig = clamp(1.0 - dot(dv, dv) * vigAmt, mix(0.30, 0.62, dayF), 1.0);
    let vigTint = mix(vec3<f32>(0.04, 0.06, 0.14), vec3<f32>(0.28, 0.19, 0.11), dayF);
    col = mix(col * vigTint, col, vig);

    col = aces_filmic(col);
    col = pow(max(col, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));

    let contrast = mix(1.08, 1.12, dayF);
    col = clamp((col - vec3<f32>(0.42)) * contrast + vec3<f32>(0.42), vec3<f32>(0.0), vec3<f32>(1.0));

    let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    let gm = smoothstep(0.10, 0.28, col.g - col.b) * smoothstep(-0.18, -0.04, col.g - col.r) * 0.22;
    col = mix(col, mix(vec3<f32>(luma), col, 0.55) * vec3<f32>(0.97, 1.0, 1.02), gm);

    let liftTint = mix(vec3<f32>(0.05, 0.08, 0.20), vec3<f32>(0.22, 0.13, 0.05), dayF);
    col += liftTint * 0.030 * (1.0 - smoothstep(0.0, 0.42, luma));

    let grainAmt = mix(0.008, 0.004, coc);
    col += (bnVal - 0.5) * grainAmt;

    return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
