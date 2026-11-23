extends Node3D

@onready var player: CharacterBody3D = $Player
@onready var player_spawn: Marker3D = $PlayerSpawn

func _ready() -> void:
	if player and player_spawn:
		player.global_position = player_spawn.global_position
	if "--autotest" in OS.get_cmdline_user_args():
		print("AUTOTEST 3D starter scene loaded with playable CharacterBody3D")
		get_tree().quit(0)
