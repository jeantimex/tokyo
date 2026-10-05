// Window glass and water that reflect the city: screen-space reflections, for the window panes and for rivers,
// moats and ponds. The facade shader marks its panes in the alpha channel of the colour buffer (1 everywhere
// else), the ground shader its water (alpha 0: a mirror lying flat, with ripples). For each
// marked pixel the mirrored view ray is marched through the depth buffer; where it meets something that
// is on screen, the pane shows it. A ray that leaves the screen or finds nothing keeps what the pane had:
// the reflection of the sky from the environment map.
import {
  Fn, If, Loop, Break, uniform, float, vec2, vec3, vec4, mat3, mix, max, clamp, dot, cross, normalize, reflect, select, floor, fract, sin, pow,
  smoothstep, transpose, dFdx, dFdy, uv, screenCoordinate, getViewPosition, getScreenPosition,
} from 'three/tsl';
import { shared } from './materials.js';

const STEPS = 56;

const rippleHash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const rippleNoise = Fn(([p]) => {
  const i = floor(p).toVar(), f0 = fract(p), f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  return mix(mix(rippleHash(i), rippleHash(i.add(vec2(1, 0))), f.x), mix(rippleHash(i.add(vec2(0, 1))), rippleHash(i.add(vec2(1, 1))), f.x), f.y);
});

// colour, depth: the texture nodes of the scene's picture. Returns { node: the picture with the
// reflections laid in (alpha 1), strength: a uniform }.
export function windowReflections(colour, depth, camera) {
  const uProjection = uniform(camera.projectionMatrix), uInverse = uniform(camera.projectionMatrixInverse), uCamWorld = uniform(camera.matrixWorld);
  const strength = uniform(1);
  const viewAt = (q) => getViewPosition(q, depth.sample(q).r, uInverse);

  const node = Fn(() => {
    const at = uv(), input = colour.sample(at).toVar(), d0 = depth.sample(at).r.toVar();
    const out = vec4(input.rgb, 1).toVar();
    const pane = input.a.oneMinus().toVar();
    // (taken outside the branch: derivatives)
    const P = getViewPosition(at, d0, uInverse).toVar();
    const flat = cross(dFdx(P), dFdy(P)).toVar();

    If(pane.greaterThanEqual(0.02).and(d0.lessThan(1)), () => {
      // the pane's normal from the depth buffer: walls are flat, so neighbouring pixels give it
      const N = normalize(flat).toVar(), V = normalize(P).toVar();
      If(dot(N, V).greaterThan(0), () => { N.assign(N.negate()); });
      const water = input.a.lessThan(0.02).toVar();
      If(water, () => {
        // ripples: the mirror is tilted a little this way and that, moving with the time
        const w = uCamWorld.mul(vec4(P, 1)).xz.toVar(), t = shared.uTime;
        const tilt = vec2(rippleNoise(w.mul(0.33).add(vec2(t.mul(0.21), t.mul(0.08)))), rippleNoise(w.mul(0.33).add(17).add(vec2(t.mul(-0.15), t.mul(0.19))))).sub(0.5).toVar();
        N.assign(normalize(N.add(transpose(mat3(uCamWorld)).mul(vec3(tilt.x, 0, tilt.y)).mul(0.006))));
      });
      const R = reflect(V, N).toVar();
      // (heading back at the camera: what it would show is not on screen)
      If(R.z.greaterThan(-0.02).and(dot(R, V).lessThan(0)).not(), () => {
        // steps grow with distance: the next building is tens of metres away, the skyline a kilometre
        const jitter = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));
        // (a jittered start hides the steps in a pane; on open water it shows as grain. Finer steps over water:
        // a clear mirror)
        const t = jitter.mul(select(water, 0.15, 1)).add(1.5).toVar(), growth = select(water, 1.12, 1.24).toVar();
        const hit = vec2(-1).toVar(), last = float(0).toVar();
        Loop(STEPS, () => {
          const Q = P.add(R.mul(t)).toVar();
          If(Q.z.greaterThan(-1), () => { Break(); }); // behind the camera
          const q = getScreenPosition(Q, uProjection).toVar();
          If(q.x.lessThan(0).or(q.x.greaterThan(1)).or(q.y.lessThan(0)).or(q.y.greaterThan(1)), () => { Break(); });
          const d = depth.sample(q).r.toVar();
          If(d.lessThan(1), () => {
            const behind = getViewPosition(q, d, uInverse).z.sub(Q.z).toVar(); // > 0: the ray is behind what is drawn there
            If(behind.greaterThan(0).and(behind.lessThan(max(3, t.sub(last).mul(select(water, 1.1, 1.5))))), () => {
              // halve the last step a few times to land on the surface
              const lo = last.toVar(), hi = t.toVar();
              Loop(8, () => {
                const mid = lo.add(hi).mul(0.5).toVar(), M = P.add(R.mul(mid)).toVar();
                const mq = getScreenPosition(M, uProjection).toVar();
                If(viewAt(mq).z.sub(M.z).greaterThan(0), () => { hi.assign(mid); }).Else(() => { lo.assign(mid); });
                q.assign(mq);
              });
              hit.assign(q);
              Break();
            });
          });
          last.assign(t);
          t.assign(t.mul(growth).add(0.5));
        });
        If(hit.x.greaterThanEqual(0), () => {
          // glass reflects more at a glancing angle; reflections fade out towards the edge of the screen
          const fresnel = select(water, 0.72, 0.3).add(select(water, 0.28, 0.7).mul(pow(max(dot(V.negate(), N), 0).oneMinus(), 3)));
          const edge = smoothstep(vec2(0), vec2(0.08), hit).mul(smoothstep(vec2(0.92), vec2(1), hit).oneMinus());
          const k = pane.mul(fresnel).mul(edge.x).mul(edge.y).mul(strength);
          // (what water mirrors is a little darker and greener than the thing itself)
          const seen = colour.sample(hit).rgb.mul(select(water, vec3(0.9, 0.94, 0.96), vec3(1)));
          out.rgb.assign(mix(input.rgb, seen, clamp(k, 0, 1)));
        });
      });
    });
    return out;
  })();
  return { node, strength };
}
