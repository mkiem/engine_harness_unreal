/**
 * A built character, ready to drop into a Godot 4 scene: res://characters/<slug>/ gets the GLB (mesh, skeleton with
 * Godot's humanoid bone names, textures, animations), a scene that plays its animations, and its style's look: toon
 * is cel-shaded with an outline, voxel and retro keep crisp pixels. A headless check loads it and reports what Godot
 * sees.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CHARACTER_SCRIPT = `extends Node3D
## A character built by Engine Harness from reference images. It plays one of its animations (idle, walk, run,
## attack) and gives itself its style's look: toon is cel-shaded with an outline, voxel and retro keep crisp pixels.
## play("walk") switches animation.

@export var style := "lowpoly"
@export var animation := "idle"
var player: AnimationPlayer

func _ready() -> void:
	player = _find(self, "AnimationPlayer") as AnimationPlayer
	_apply_style(self)
	play(animation)
	if OS.get_cmdline_user_args().has("--character-check"):
		_report.call_deferred()

## Plays an animation by name ("idle", "walk", "run", "attack"); answers false when there is none.
func play(name: String) -> bool:
	if player == null:
		return false
	for candidate in player.get_animation_list():
		if candidate == name or String(candidate).ends_with(name):
			var clip := player.get_animation(candidate)
			clip.loop_mode = Animation.LOOP_NONE if name == "attack" else Animation.LOOP_LINEAR
			player.play(candidate)
			return true
	return false

func _find(node: Node, type: String) -> Node:
	if node.is_class(type):
		return node
	for child in node.get_children():
		var found := _find(child, type)
		if found:
			return found
	return null

func _meshes(node: Node, out: Array) -> Array:
	if node is MeshInstance3D:
		out.append(node)
	for child in node.get_children():
		_meshes(child, out)
	return out

func _apply_style(root: Node) -> void:
	for mesh: MeshInstance3D in _meshes(root, []):
		for surface in mesh.mesh.get_surface_count():
			var base := mesh.get_active_material(surface) as StandardMaterial3D
			if base == null:
				continue
			if style == "toon":
				var toon := ShaderMaterial.new()
				toon.shader = load("res://characters/toon.gdshader")
				toon.set_shader_parameter("albedo_texture", base.albedo_texture)
				var outline := ShaderMaterial.new()
				outline.shader = load("res://characters/outline.gdshader")
				toon.next_pass = outline
				mesh.set_surface_override_material(surface, toon)
			elif style in ["voxel", "retro"]:
				var crisp := base.duplicate() as StandardMaterial3D
				crisp.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST_WITH_MIPMAPS
				mesh.set_surface_override_material(surface, crisp)

func _report() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	var skeleton := _find(self, "Skeleton3D") as Skeleton3D
	var meshes := _meshes(self, [])
	var box := AABB()
	var textured := false
	for mesh: MeshInstance3D in meshes:
		box = box.merge(mesh.get_aabb())
		var material := mesh.get_active_material(0)
		if material is StandardMaterial3D and material.albedo_texture != null:
			textured = true
		elif material is ShaderMaterial and material.get_shader_parameter("albedo_texture") != null:
			textured = true
	print("CHARACTER_CHECK " + JSON.stringify({
		"bones": skeleton.get_bone_count() if skeleton else 0,
		"hips": skeleton.find_bone("Hips") >= 0 if skeleton else false,
		"animations": Array(player.get_animation_list()) if player else [],
		"playing": player.current_animation if player else "",
		"meshes": meshes.size(), "textured": textured, "height": snappedf(box.size.y, 0.01), "style": style,
	}))
	get_tree().quit(0)
`

export const TOON_SHADER = `shader_type spatial;
// Cel shading for Engine Harness characters: the albedo texture, lit in two flat bands with a soft rim.
uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform float bands = 2.0;
uniform float shadow = 0.55;

void fragment() {
	ALBEDO = texture(albedo_texture, UV).rgb;
	ROUGHNESS = 1.0;
	SPECULAR = 0.0;
}

void light() {
	float lit = clamp(dot(NORMAL, LIGHT), 0.0, 1.0) * ATTENUATION;
	float stepped = floor(lit * bands + 0.5) / bands;
	DIFFUSE_LIGHT += ALBEDO * LIGHT_COLOR / PI * mix(shadow, 1.0, stepped);
}
`

export const OUTLINE_SHADER = `shader_type spatial;
// An ink outline for toon characters: the back faces, pushed out along the normals, drawn dark.
render_mode unshaded, cull_front;
uniform float width = 0.012;
uniform vec4 colour : source_color = vec4(0.08, 0.06, 0.1, 1.0);

void vertex() {
	VERTEX += NORMAL * width;
}

void fragment() {
	ALBEDO = colour.rgb;
}
`

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'character'

/** Copies a built character into a Godot project; answers the scene's res:// path. */
export function installGodotCharacter(godotProject: string, buildDir: string, build: { name: string; style: string; files: { glb?: string } }): { scene: string; files: string[] } {
  if (!build.files.glb) throw new Error('this build has no GLB: build it with engine "godot" or "both"')
  const id = slug(build.name)
  const dir = join(godotProject, 'characters', id)
  mkdirSync(dir, { recursive: true })
  const glb = join(dir, `${id}.glb`)
  copyFileSync(join(buildDir, build.files.glb), glb)
  const shared = join(godotProject, 'characters')
  const files = [glb]
  for (const [file, text] of [['toon.gdshader', TOON_SHADER], ['outline.gdshader', OUTLINE_SHADER], ['character.gd', CHARACTER_SCRIPT]] as const) {
    const path = join(shared, file)
    writeFileSync(path, text)
    files.push(path)
  }
  const scene = join(dir, `${build.name}.tscn`)
  writeFileSync(scene, [
    '[gd_scene load_steps=3 format=3]',
    '',
    `[ext_resource type="PackedScene" path="res://characters/${id}/${id}.glb" id="1_model"]`,
    '[ext_resource type="Script" path="res://characters/character.gd" id="2_script"]',
    '',
    `[node name="${build.name.replace(/[^A-Za-z0-9_]/g, '')}" type="Node3D"]`,
    'script = ExtResource("2_script")',
    `style = "${build.style}"`,
    '',
    '[node name="Model" parent="." instance=ExtResource("1_model")]',
    '',
  ].join('\n'))
  files.push(scene)
  return { scene: `res://characters/${id}/${build.name}.tscn`, files }
}

export function hasGodotProject(dir: string): boolean {
  return existsSync(join(dir, 'project.godot'))
}
