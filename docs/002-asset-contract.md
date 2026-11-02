# 002 Asset contract

Every asset that crosses a ticket boundary is described twice: by the **spec** the plan promised (`AssetSpec` in `src/core/model.ts`) and by the **record** the worker delivered (`AssetRecord`). The contract (`src/contracts/index.ts`) compares the two. A worker's facts must come from the inspection scripts in `dcc/`, never estimates; where the harness can measure the file itself (audio), it does, and its measurement wins.

Each violation has a stable `rule` code. The same code is sent back to the worker as revision feedback, shown to people, and asserted in tests.

## Naming

| Kind | Prefix | Example |
| --- | --- | --- |
| static_mesh | `SM_` | `SM_VintageRadio` |
| skeletal_mesh | `SK_` | `SK_Guard` |
| texture_set | `T_` (maps `_BC`, `_N`, `_ORM`, `_E`, `_O`) | `T_VintageRadio_ORM` |
| audio_clip | `SFX_`, `MUS_`, `VO_`, `AMB_` | `SFX_RadioStatic` |
| audio_event | `Play_`, `Stop_` | `Play_RadioStatic` |
| blueprint | `BP_` | `BP_VintageRadio` |
| level_placement | `PL_` | `PL_VintageRadio` |
| test_result | `QA_` | `QA_VintageRadio` |

Collision: `UCX_<mesh>_NN` (convex), `UBX_` (box), `USP_` (sphere), `UCP_` (capsule). `<mesh>` must equal the render mesh's name exactly. LODs: `<mesh>_LOD0..n` in an LOD group.

## Rules by kind

**Every asset:** `naming.prefix`, `kind.mismatch`, `file.missing`, `file.outside` (paths may not leave the ticket directory), `file.hash` (changed after reporting), `file.engine-path`, `provenance.recipe` (procedural needs a recipe script), `provenance.model` (generative names its model), `facts.invalid` (a required fact is missing). Delivery as a whole: `delivery.missing`, `delivery.unpromised`.

**Static and skeletal meshes** (facts from `dcc/blender/inspect_export.py`):

| Rule | Check |
| --- | --- |
| `file.export` | An `.fbx`, `.glb` or `.gltf` export exists |
| `mesh.triangles` | LOD0 triangles ≤ `maxTriangles` |
| `mesh.lods` | LOD count ≥ `lods` |
| `mesh.transforms` | Rotation and scale applied on every object |
| `mesh.uv` | At least one UV channel |
| `naming.mesh` | A render mesh is named after the asset (or its LODs) |
| `collision.missing` / `collision.name` / `collision.target` / `collision.unexpected` | UCX hulls present, well named, named for this mesh; none when the spec says `engine` or `none` |
| `mesh.pivot` | Pivot within 0.5 cm of the bottom centre (`base`) or world origin (`origin`) |
| `mesh.size` | Each axis within `sizeTolerance` of `approxSizeCm`; a ×100 or ×0.01 error is named as a unit-scale mistake |
| `mesh.materials` | Material slots exactly as listed, in order |
| `mesh.bones` | Skeletal meshes: at least `bones` |

**Texture sets:** `texture.missing`, `naming.texture`, `texture.resolution`, `texture.srgb` (colour maps sRGB, data maps linear), `texture.normal` (DirectX for Unreal).

**Audio clips** (measured from the WAV): `audio.format` (PCM), `audio.rate`, `audio.channels`, `audio.bits`, `audio.length`, `audio.peak` (≤ `maxPeakDb`), `audio.loudness` (RMS within `loudnessDb`; a LUFS meter can replace RMS), `audio.loop-seam` (no click at the loop point), `audio.unreadable`.

**Audio events:** `audio.event-clip`, `audio.attenuation`, `audio.distance`, `audio.soundbank`.

**Blueprints:** `blueprint.compile`, `blueprint.parent`, `blueprint.component`, `blueprint.interface`.

**Level placements:** `placement.map`, `placement.class`, `placement.location` (within 1 cm), `placement.ofpa` (an external actor file when the map uses One File Per Actor).

**Test results:** `test.missing`, `test.failed`.

**Ingest** (engine-side, from `dcc/unreal/import_pipeline.py`): `ingest.import`, `ingest.collision` (imported without its hulls), `ingest.lods`, `ingest.size`, `ingest.wwise` (no AkAudioEvent asset), `ingest.error`.

## Blender to Unreal conventions

- Metric, Unit Scale 1.0, model at real size; export FBX with `apply_scale_options='FBX_SCALE_UNITS'`.
- Apply rotation and scale; keep the exporter's default axes, which the import script expects.
- Pivot at the bottom centre for props; at the origin for characters.
- Ingest settings are fixed in one place, `dcc/unreal/import_pipeline.py`: no FBX materials or textures, LODs from the file, lightmap UVs generated, collision generated only when the spec asks for `engine`.

## Adding a kind

1. Add the kind to `AssetKind`, its requirements schema to `AssetSpec`, and its prefix to `PREFIX`.
2. Say which domain produces it in `PRODUCES`, and whether ingest imports it (`INGESTED`).
3. Add its facts schema and checks to `checkAsset`, each with a rule code, and a test per rule.
4. Write the inspection script that produces its facts in `dcc/`, and describe it in the domain's prompt.
