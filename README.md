# Procedural Tokyo

A real-time 3D model of Tokyo in the browser, compiled from public data with procedural detail on top.
Fly over the city, change the time of day, and watch the traffic, the trains and the birds.

https://github.com/user-attachments/assets/242e40ca-6ea8-4b89-bfec-f166fe3d23a6

**Live: https://jeantimex.github.io/tokyo/** (not recommended for mobile browsers :))

The buildings, roads and terrain are real: they come from Japan's open 3D city model (Project PLATEAU),
OpenStreetMap and the national elevation survey. Everything the data does not carry is generated:
facades and windows, street furniture, road paint, traffic, night lighting, water, weather.

The architecture follows [BoundlessNYC](https://github.com/mkturkcan/boundless-nyc): an offline compiler turns
raw records into compact binary tiles, and the client streams and meshes them.

## Scenes

| Area | What is there |
|---|---|
| Tokyo | Tokyo Station, Marunouchi, the Imperial Palace moats |
| Shiba | Tokyo Tower (built member by member as a steel lattice), Zojo-ji, Shiba Park |
| Shibuya | The Scramble Crossing, the station, the expressway |
| Shinjuku | The station, the skyscraper district, Kabukicho, Shinjuku Gyoen |
| Chiyoda | Akihabara, Kanda, Ochanomizu (north of the Tokyo area) |
| Chuo | Tsukiji, Kachidoki, Tsukishima and Harumi: the waterfront and its canals |
| Fujinomiya | A town at the foot of Mt Fuji, with the mountain as a 60 km terrain backdrop |

Each area is about 3.4 x 2.8 km. Adding another city that PLATEAU covers is one entry in
`tools/pipeline/config.mjs` (see [Pipeline](#pipeline)).

PLATEAU covers about 300 Japanese cities so far and adds more each year. The official lists:
[open data by city](https://www.mlit.go.jp/plateau/open-data/) (Project PLATEAU, MLIT), the
[dataset catalogue](https://www.geospatial.jp/ckan/dataset/plateau) (G-Spatial Information Center) and the
[PLATEAU VIEW](https://plateauview.mlit.go.jp/) map. Detail varies: city centres tend to have roof shapes and
photo textures, smaller towns plain blocks.

## Features

- **Buildings**: real footprints and heights. Central districts use PLATEAU's detailed roof shapes and its aerial
  roof photos; walls blend from the (smeared) aerial wall photo at a distance to a generated facade close up.
  Facades are textured by building use, with windows fitted per wall, interior-mapped rooms, parapets, rooftop
  equipment, balconies and shop sign bands.
- **Ground**: terrain from the 5 m elevation model under an aerial photo, PLATEAU road surfaces with kerbs, parks,
  woods and water, lane lines, zebra crossings, stop lines, lane arrows, 止まれ and painted speed limits.
- **Street objects**: trees (full models up close, simple shapes far away), utility poles with wires, street
  lights, traffic signals that cycle, vending machines, torii, station platforms, footbridges, parked cars.
- **Signs and adverts**: shop signs named from OpenStreetMap, and invented neon billboards, LED screens and
  banners (no real brand or character is used).
- **Traffic and trains**: cars on the real road graph that keep left, obey signals and one-way streets, queue
  at junctions and follow the expressway and its ramps; trains that run the real railway lines.
- **Time of day**: a slider or a live Tokyo clock drives the sun, moon, sky, shadows and exposure. At dusk the
  city lights come on first and the darkness then follows the sun down through twilight.
- **Night**: lit windows that switch on and off, street-lamp and headlight pools on the road, glowing signs,
  lights on Tokyo Tower.
- **Sky**: physically based atmosphere with aerial perspective, and optional volumetric clouds that cast shadows
  ([three-geospatial](https://github.com/takram-design-engineering/three-geospatial)).
- **Water**: rippled rivers, moats and ponds that mirror the city, the sky and the clouds.
- **Reflections**: window glass reflects the surrounding city and catches the sun.
- **Birds**: flocks that stay in view, land in trees and fly out again; they cast shadows.
- **Mt Fuji**: an optional terrain backdrop around an area, under aerial photos, with a snow cap.

## Controls

Drag to pan, right-drag to rotate, wheel to zoom, WASD to move (shift: fast), N to flip day and night, click a
building to inspect it. The Settings panel (top right) switches city and controls time, traffic, clouds,
lighting and rendering quality; settings are remembered in the browser.

URL parameters: `?area=tokyo|shiba|shibuya|shinjuku|chiyoda|chuo|fujinomiya`, `?time=18.5` (Tokyo hour), `?night=1`,
`?cam=x,z,distance,azimuth,elevation`, `?radius=900`, `?traffic=0`, `?cars=600`, `?birds=150`, `?clouds=0.25`,
`?ortho=0`. A page opened with parameters does not overwrite the saved settings.

## Technical notes

Some of the problems that shaped the code:

- **Three datasets, one frame.** PLATEAU, OpenStreetMap and the GSI elevation model are projected into one
  local metre grid. Elevation is a single 5 m grid for the whole area, so neighbouring tiles compute identical
  heights along a shared edge and there are no seams. Building bases are checked against the terrain at compile
  time and the difference is logged (a median of about 0.1 m in Fujinomiya).
- **Paint that stays on the road.** Road surfaces, lane lines and symbols are split along the terrain mesh's own
  triangles (`src/world/drape.js`), so markings never sink into a slope, even across tile boundaries. `npm test`
  checks the clearance geometrically.
- **Roads without detail.** Where PLATEAU maps a road only as an outline, it is split into carriageway and
  sidewalk from the OpenStreetMap centrelines (`tools/pipeline/roadsplit.mjs`).
- **Bridges and flyovers.** The elevation model shows the top of a bridge, not what passes under it. Street
  bridges are levelled bank to bank, the expressway is lifted onto its own structure by layer, and ramps are
  graded so they always land (`tools/pipeline/roadprofile.mjs`).
- **Thousands of lamps without thousands of lights.** Street lamps and headlights are flat quads drawn from
  above into a light map, where overlapping lamps keep the brighter value instead of adding up. Lit surfaces
  read that map, with the lamp's height stored alongside so a lamp under a flyover does not light the deck
  (`src/world/lamplight.js`).
- **Water as a mirror.** The city is drawn a second time, flipped below the water level, and laid on the water
  by viewing angle. Ripples shift the picture; the clouds are added by sampling the cloud system's own weather
  map where the reflected ray meets the cloud base (`src/world/mirror.js`, `materials.js`).
- **Window reflections.** Glass panes are marked in the colour buffer's alpha channel and resolved in a
  screen-space reflection pass (`src/world/reflections.js`).
- **Birds on the GPU.** Every bird is placed in the vertex shader from the time and a few random numbers; a
  small texture carries each flock's tree and how far it has settled, so a thousand birds cost the CPU almost
  nothing (`src/world/birds.js`).
- **A mountain behind a town.** The backdrop is a 120 m terrain grid 60 km wide under two aerial photos: a
  coarse one of everything and a sharp one of the land just beyond the houses (`src/world/backdrop.js`).
- **Streaming.** Tiles are 256 m squares meshed in Web Workers. The site loads what lies near the view by
  default; "whole city" in the settings loads everything.

Rendering uses three.js on **WebGPU** (`WebGPURenderer`, with every material and pass written as TSL nodes): the
scene, then one node pipeline of window reflections, ambient occlusion, atmosphere and clouds, bloom and tone
mapping. It needs a browser with WebGPU (a recent Chrome, Edge or Safari).

- **Ported from WebGL, picture for picture.** The first version ran on WebGL with the pmndrs `postprocessing`
  composer, N8AO and takram's cloud effect. None of those have node versions, so the ambient occlusion
  (`src/world/occlusion.js`), the mipmap-blur bloom (`src/world/bloom.js`) and the volumetric clouds with their
  shadow map, haze and temporal gathering (`src/world/clouds.js`) were rewritten as nodes after them, and the
  result compared against the WebGL picture view by view (`tools/compare.mjs`) until the two agreed to about one
  level in 255.
- **Keeping three's WebGPU renderer quick.** One facade material serves every tile (a tile's wall photos are its
  mesh's own texture), instanced meshes pass their matrices as vertex attributes so that they share shaders
  (58 pipelines instead of 678), the environment map is re-baked into the same texture, and shared values live
  in one uniform group updated once per rendering rather than once per object.

## Running it locally

```
npm install
node tools/assets/fetch_textures.mjs    # once: CC0 textures from Poly Haven -> public/textures/ (14 MB)
npm run fetch -- --area=tokyo           # raw data -> data/raw/<area>/
npm run compile -- --area=tokyo         # data/raw -> public/tiles/<area>/
npm run dev                             # http://localhost:5280
```

The compiled cities are not in the repository; they are rebuilt from the sources. Raw downloads are large
(Tokyo 3.6 GB, Shiba 3.0 GB, Shibuya 1.3 GB, Fujinomiya 0.2 GB), mostly PLATEAU's building photos. Compiling
takes seconds to a few minutes per area.

## Pipeline

```
npm run fetch      # raw data -> data/raw/<area>/ and aerial photos -> public/ortho/<area>/
npm run compile    # data/raw -> public/tiles/<area>/   (add --no-ads to leave out the invented billboards)
npm run preview    # top-down render -> data/preview/<area>.png
npm test           # tile format round trip + road-marking clearance over the compiled areas
```

All scripts take `--area=<id>`. An area is a centre point and a block of PLATEAU grid squares, defined in
`tools/pipeline/config.mjs`; optional `backdrop` (kilometres of surrounding terrain) and `view` (the opening
camera) can be added per area.

| Source | What is taken |
|---|---|
| [Project PLATEAU](https://www.mlit.go.jp/plateau/) CityGML | Buildings (footprints, heights, storeys, use, detailed shells and photo textures where available), road surfaces, bridges, street furniture and vegetation models |
| [OpenStreetMap](https://www.openstreetmap.org/) (Overpass) | Road graph (class, lanes, one-way, speed, layer, bridge/tunnel), railways, parks, woods, water, trees, crossings, signals, named places, small objects |
| [GSI](https://maps.gsi.go.jp/development/ichiran.html) elevation tiles | Terrain: 5 m model, 10 m to fill gaps; a coarse model for the backdrop |
| GSI seamless aerial photo | Ground photo of the area, and the backdrop photos |

PLATEAU files are fetched per grid square through the PLATEAU data catalog API. The Tokyo dataset lists a square
under every ward it touches, so buildings and roads are deduplicated by `gml:id`. Coverage varies by city: some
have no detailed shells, photo textures or street furniture, and the client falls back to generated detail.

## Compiled output (`public/tiles/<area>/`)

World frame: metres, x east, y up (Tokyo Peil height), z south; the origin is the area's centre.

| File | Contents |
|---|---|
| `manifest.json` | origin, bounds, tile list, terrain grid, bridge decks, attribution |
| `t_<x>_<z>.bin` | one 256 m tile: buildings, ground surfaces, paint, props, wires, signs (`src/shared/tileformat.js`) |
| `terrain.bin` | Float32 height grid, 5 m spacing |
| `roads.json` | road graph with a level per point (ground, bridge or flyover), and signalled junctions |
| `rails.json`, `structures.json` | railway lines; footbridges, platforms and canopies |
| `backdrop.bin` | optional: the coarse terrain around the area |

`src/shared/` is used by both the compiler and the client.

## Deploying

```
npm run deploy     # builds and force-pushes dist/ as one commit to the gh-pages branch of origin
```

This publishes whatever cities are compiled on the machine (about 650 MB for the seven above).

## Attribution

3D city model, roof photos, bridges and street furniture: Project PLATEAU (MLIT Japan). Elevation and aerial
photos: Geospatial Information Authority of Japan (GSI). Road network, railways and places: © OpenStreetMap
contributors (ODbL); a redistributed compiled area is a derived database under the ODbL. Textures: Poly Haven
(CC0). Trees: ez-tree (MIT). Atmosphere and clouds: takram three-geospatial (MIT).

## License

The code is under the [MIT License](LICENSE). The licence covers the code only: the city data keeps the terms of
its sources listed above, and the cloud textures in `public/assets/takram` are from takram three-geospatial (MIT).
