extends CanvasLayer
## Esc on the map opens this: the party's stats, items to use, saving, and back to the title.

signal closed

var _panel: PanelContainer
var _info: Label
var _buttons: VBoxContainer
var open := false

func _ready() -> void:
	layer = 20
	_panel = PanelContainer.new()
	_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	_panel.offset_left = 8
	_panel.offset_top = 8
	_panel.offset_right = -8
	_panel.offset_bottom = -8
	add_child(_panel)
	var row := HBoxContainer.new()
	_panel.add_child(row)
	_buttons = VBoxContainer.new()
	row.add_child(_buttons)
	_info = Label.new()
	_info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(_info)
	_panel.visible = false

func show_menu() -> void:
	open = true
	_panel.visible = true
	_refresh()

func _refresh() -> void:
	for child in _buttons.get_children():
		child.queue_free()
	var lines: Array = ["Gold: %d" % Game.gold, ""]
	for member in Game.party:
		var name: String = Data.characters.get(member["id"], {}).get("name", member["id"])
		lines.append("%s  Lv %d" % [name, int(member["level"])])
		lines.append("  HP %d/%d  MP %d/%d" % [int(member["hp"]), Game.stat(member, "hp"), int(member["mp"]), Game.stat(member, "mp")])
		lines.append("  ATK %d DEF %d MAG %d SPD %d" % [Game.stat(member, "atk"), Game.stat(member, "def"), Game.stat(member, "mag"), Game.stat(member, "spd")])
	_info.text = "\n".join(lines)
	for id in Game.inventory.keys():
		var item: Dictionary = Data.items.get(id, {})
		_add_button("%s x%d" % [item.get("name", id), int(Game.inventory[id])], _use_item.bind(id))
	_add_button("Save", _save)
	_add_button("Title", func(): close(); Router.title())
	_add_button("Close", close)
	await get_tree().process_frame
	if _buttons.get_child_count() > 0:
		(_buttons.get_child(0) as Button).grab_focus()

func _add_button(text: String, action: Callable) -> void:
	var button := Button.new()
	button.text = text
	button.pressed.connect(action)
	_buttons.add_child(button)

func _use_item(id: String) -> void:
	var item: Dictionary = Data.items.get(id, {})
	if int(Game.inventory.get(id, 0)) <= 0:
		return
	# Use on the most hurt member.
	var target: Dictionary = Game.party[0]
	for member in Game.party:
		if float(member["hp"]) / Game.stat(member, "hp") < float(target["hp"]) / Game.stat(target, "hp"):
			target = member
	if item.get("effect", "heal") == "heal":
		target["hp"] = min(Game.stat(target, "hp"), int(target["hp"]) + int(item.get("amount", 10)))
	elif item.get("effect") == "mp":
		target["mp"] = min(Game.stat(target, "mp"), int(target["mp"]) + int(item.get("amount", 5)))
	Game.add_item(id, -1)
	Sound.play("heal")
	_refresh()

func _save() -> void:
	Game.save_game()
	Sound.play("select")
	_info.text = "Saved.\n\n" + _info.text

func close() -> void:
	open = false
	_panel.visible = false
	closed.emit()

func _unhandled_input(event: InputEvent) -> void:
	if open and event.is_action_pressed("ui_cancel"):
		get_viewport().set_input_as_handled()
		close()
