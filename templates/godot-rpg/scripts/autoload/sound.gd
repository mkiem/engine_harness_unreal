extends Node
## Music and sound effects. Missing files are skipped quietly, so the game runs before any audio exists.

var _music: AudioStreamPlayer
var _sfx: Array[AudioStreamPlayer] = []
var _current := ""

func _ready() -> void:
	_music = AudioStreamPlayer.new()
	_music.volume_db = -8.0
	add_child(_music)
	for i in 4:
		var player := AudioStreamPlayer.new()
		add_child(player)
		_sfx.append(player)

func _load(path: String) -> AudioStream:
	if path == "":
		return null
	if ResourceLoader.exists(path):
		return load(path)
	if path.ends_with(".wav") and FileAccess.file_exists(path):
		return AudioStreamWAV.load_from_file(ProjectSettings.globalize_path(path))
	return null

func music(path: String) -> void:
	if path == _current:
		return
	_current = path
	var stream := _load(path)
	if stream == null:
		_music.stop()
		return
	if stream is AudioStreamWAV:
		stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
		stream.loop_end = int(stream.get_length() * stream.mix_rate)
	_music.stream = stream
	_music.play()

## Plays the first of the names whose sound exists, so a game can add specific sounds ("fire") over general ones ("hit").
func play(name: String, fallback: String = "") -> void:
	var stream := _load("res://audio/%s.wav" % name)
	if stream == null and fallback != "":
		stream = _load("res://audio/%s.wav" % fallback)
	if stream == null:
		return
	for player in _sfx:
		if not player.playing:
			player.stream = stream
			player.play()
			return
