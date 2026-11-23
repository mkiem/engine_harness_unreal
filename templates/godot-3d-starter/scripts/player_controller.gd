extends CharacterBody3D

@export var walk_speed: float = 4.5
@export var run_speed: float = 7.5
@export var jump_velocity: float = 5.5
@export var turn_speed: float = 10.0
@export var camera_turn_speed: float = 2.2
@export var mouse_sensitivity: float = 0.005

@onready var visual_root: Node3D = $VisualRoot
@onready var fallback_mesh: MeshInstance3D = $VisualRoot/FallbackMesh
@onready var camera_pivot: Node3D = $CameraPivot

var _gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity", 9.8)
var _character_node: Node = null
var _current_anim: String = ""
var _attack_timer: float = 0.0
var _dragging_camera: bool = false

func _ready() -> void:
	_load_installed_character()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_RIGHT:
		_dragging_camera = event.pressed
	elif event is InputEventMouseMotion and _dragging_camera:
		camera_pivot.rotate_y(-event.relative.x * mouse_sensitivity)
		var spring := camera_pivot.get_node_or_null("SpringArm3D") as Node3D
		if spring:
			spring.rotation.x = clampf(spring.rotation.x - event.relative.y * mouse_sensitivity, -1.1, 0.25)
	elif event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_F:
		_trigger_attack()

func _physics_process(delta: float) -> void:
	# Keyboard camera orbit (Q / E)
	var cam_turn := 0.0
	if Input.is_key_pressed(KEY_Q):
		cam_turn += 1.0
	if Input.is_key_pressed(KEY_E):
		cam_turn -= 1.0
	if cam_turn != 0.0:
		camera_pivot.rotate_y(cam_turn * camera_turn_speed * delta)

	if not is_on_floor():
		velocity.y -= _gravity * delta
	elif Input.is_action_just_pressed("ui_accept"):
		velocity.y = jump_velocity

	var input_vec := Vector2(
		Input.get_action_strength("ui_right") - Input.get_action_strength("ui_left")
			+ (1.0 if Input.is_key_pressed(KEY_D) else 0.0) - (1.0 if Input.is_key_pressed(KEY_A) else 0.0),
		Input.get_action_strength("ui_down") - Input.get_action_strength("ui_up")
			+ (1.0 if Input.is_key_pressed(KEY_S) else 0.0) - (1.0 if Input.is_key_pressed(KEY_W) else 0.0),
	)
	if input_vec.length() > 1.0:
		input_vec = input_vec.normalized()

	var sprinting := Input.is_key_pressed(KEY_SHIFT)
	var speed := run_speed if sprinting else walk_speed
	var cam_basis := camera_pivot.global_transform.basis
	var move_dir := (cam_basis * Vector3(input_vec.x, 0.0, input_vec.y))
	move_dir.y = 0.0
	if move_dir.length_squared() > 0.0001:
		move_dir = move_dir.normalized()
		velocity.x = move_dir.x * speed
		velocity.z = move_dir.z * speed
		var target_yaw := atan2(move_dir.x, move_dir.z)
		visual_root.rotation.y = lerp_angle(visual_root.rotation.y, target_yaw, turn_speed * delta)
	else:
		velocity.x = move_toward(velocity.x, 0.0, speed * 8.0 * delta)
		velocity.z = move_toward(velocity.z, 0.0, speed * 8.0 * delta)

	move_and_slide()

	if _attack_timer > 0.0:
		_attack_timer -= delta
	else:
		var horizontal_speed := Vector2(velocity.x, velocity.z).length()
		if horizontal_speed < 0.2:
			_play_anim("idle")
		elif sprinting:
			_play_anim("run")
		else:
			_play_anim("walk")

func _trigger_attack() -> void:
	_attack_timer = 0.55
	_play_anim("attack")

func _play_anim(anim_name: String) -> void:
	if anim_name == _current_anim or _character_node == null:
		return
	_current_anim = anim_name
	if _character_node.has_method("play"):
		_character_node.call("play", anim_name)

func _load_installed_character() -> void:
	var dir := DirAccess.open("res://characters")
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while entry != "":
		if dir.current_is_dir() and not entry.begins_with("."):
			var sub := DirAccess.open("res://characters/" + entry)
			if sub != null:
				sub.list_dir_begin()
				var f := sub.get_next()
				while f != "":
					if f.ends_with(".tscn"):
						var scene := load("res://characters/" + entry + "/" + f) as PackedScene
						if scene:
							_character_node = scene.instantiate()
							visual_root.add_child(_character_node)
							if fallback_mesh:
								fallback_mesh.visible = false
							_play_anim("idle")
							return
					f = sub.get_next()
		entry = dir.get_next()
