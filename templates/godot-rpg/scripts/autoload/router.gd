extends Node
## Moves between screens with a short fade: title, overworld, battle, game over.

signal changed(scene_path: String)

var _fade: ColorRect
var _layer: CanvasLayer
var busy := false

func _ready() -> void:
	_layer = CanvasLayer.new()
	_layer.layer = 100
	add_child(_layer)
	_fade = ColorRect.new()
	_fade.color = Color(0, 0, 0, 0)
	_fade.set_anchors_preset(Control.PRESET_FULL_RECT)
	_fade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_layer.add_child(_fade)

func go(scene_path: String) -> void:
	if busy:
		return
	busy = true
	var tween := create_tween()
	tween.tween_property(_fade, "color:a", 1.0, 0.15)
	await tween.finished
	get_tree().change_scene_to_file(scene_path)
	await get_tree().process_frame
	var back := create_tween()
	back.tween_property(_fade, "color:a", 0.0, 0.15)
	await back.finished
	busy = false
	changed.emit(scene_path)

func title() -> void:
	go("res://scenes/main_menu.tscn")

func overworld() -> void:
	go("res://scenes/overworld.tscn")

func battle(enemy_ids: Array) -> void:
	Game.pending_battle = enemy_ids
	go("res://scenes/battle.tscn")
