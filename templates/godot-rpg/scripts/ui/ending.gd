extends Control
## The ending: the lines of "ending" in data/dialogue.json one at a time, then "The End" and back to the title screen.
## Reached by winning a battle whose NPC has "ending": true.

var _label: Label
var _lines: Array = []

func _ready() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	var background := ColorRect.new()
	background.color = Color(Data.game.get("title_background", "#1d2b53"))
	background.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(background)
	_label = Label.new()
	_label.set_anchors_preset(Control.PRESET_FULL_RECT)
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_label)
	Sound.music(Data.game.get("ending_music", Data.game.get("title_music", "")))
	_lines = Data.dialogue.get("ending", []).duplicate()
	_lines.append("The End\n\n%s\n\nThank you for playing!" % Data.game.get("title", ""))
	_next()
	if OS.get_cmdline_user_args().has("--autotest"):
		print("AUTOTEST ending: %d lines" % _lines.size())
		get_tree().quit(0)

func _next() -> void:
	if _lines.is_empty():
		Game.party = []
		Game.map_id = ""
		Router.title()
		return
	_label.text = str(_lines.pop_front())

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_accept"):
		get_viewport().set_input_as_handled()
		Sound.play("select")
		_next()
