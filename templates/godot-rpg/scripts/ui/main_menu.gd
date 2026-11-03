extends Control
## The title screen: New Game, Continue (choose one of the save slots, when there is a save) and Quit.

var _column: VBoxContainer

func _ready() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	var background := ColorRect.new()
	background.color = Color(Data.game.get("title_background", "#1d2b53"))
	background.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(background)
	var column := VBoxContainer.new()
	_column = column
	column.set_anchors_preset(Control.PRESET_CENTER)
	column.alignment = BoxContainer.ALIGNMENT_CENTER
	add_child(column)
	var title := Label.new()
	title.text = Data.game.get("title", ProjectSettings.get_setting("application/config/name"))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", ThemeDB.get_default_theme().default_font_size * 2)
	column.add_child(title)
	var tagline := Label.new()
	tagline.text = Data.game.get("tagline", "")
	tagline.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	column.add_child(tagline)
	_add(column, "New Game", _new_game)
	if Game.has_save():
		_add(column, "Continue", _continue)
	_add(column, "Quit", func(): get_tree().quit())
	Sound.music(Data.game.get("title_music", ""))
	await get_tree().process_frame
	column.position = (get_viewport_rect().size - column.size) / 2
	(column.get_child(2) as Button).grab_focus()
	if OS.get_cmdline_user_args().has("--autotest"):
		print("AUTOTEST title: ready")
		get_tree().quit(0)

func _add(column: VBoxContainer, text: String, action: Callable) -> void:
	var button := Button.new()
	button.text = text
	button.pressed.connect(action)
	column.add_child(button)

func _new_game() -> void:
	Game.new_game()
	Router.overworld()

## Replaces the menu with the save slots; Back returns to it.
func _continue() -> void:
	var keep := 2
	for child in _column.get_children().slice(keep):
		_column.remove_child(child)
		child.queue_free()
	for number in range(1, Game.SLOTS + 1):
		var button := Button.new()
		button.text = "Slot %d: %s" % [number, Game.slot_summary(number)]
		button.disabled = not Game.has_save(number)
		button.pressed.connect(func():
			if Game.load_game(number):
				Router.overworld())
		_column.add_child(button)
	_add(_column, "Back", func(): get_tree().reload_current_scene())
	await get_tree().process_frame
	_column.position = (get_viewport_rect().size - _column.size) / 2
	for child in _column.get_children().slice(keep):
		if child is Button and not child.disabled:
			child.grab_focus()
			break
