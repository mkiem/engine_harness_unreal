extends CanvasLayer
## A text box at the bottom of the screen. say() shows lines one at a time; the player presses Enter/Space to go on.

signal finished
signal picked(index: int)

var _panel: PanelContainer
var _label: Label
var _lines: Array = []
var open := false
var _choices: VBoxContainer
var _choosing := false

func _ready() -> void:
	layer = 10
	_panel = PanelContainer.new()
	_panel.anchor_left = 0.0
	_panel.anchor_right = 1.0
	_panel.anchor_top = 1.0
	_panel.anchor_bottom = 1.0
	_panel.offset_left = 4
	_panel.offset_right = -4
	_panel.offset_top = -52
	_panel.offset_bottom = -4
	add_child(_panel)
	_label = Label.new()
	_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_panel.add_child(_label)
	_panel.visible = false
	_choices = VBoxContainer.new()
	_choices.anchor_left = 1.0
	_choices.anchor_right = 1.0
	_choices.offset_left = -120
	_choices.offset_right = -4
	_choices.offset_top = 4
	add_child(_choices)

## Shows a question with choices; answers the chosen index, or -1 when the player presses Esc.
func choose(question: String, options: Array) -> int:
	open = true
	_choosing = true
	_panel.visible = true
	_label.text = question
	for child in _choices.get_children():
		child.queue_free()
	for i in options.size():
		var button := Button.new()
		button.text = str(options[i])
		button.pressed.connect(func(): picked.emit(i))
		_choices.add_child(button)
	await get_tree().process_frame
	if _choices.get_child_count() > 0:
		(_choices.get_child(0) as Button).grab_focus()
	var index: int = await picked
	for child in _choices.get_children():
		child.queue_free()
	_choosing = false
	_panel.visible = false
	open = false
	Sound.play("select")
	return index

func say(lines: Array) -> void:
	_lines = lines.duplicate()
	open = true
	_panel.visible = true
	_next()
	await finished

func _next() -> void:
	if _lines.is_empty():
		_panel.visible = false
		open = false
		finished.emit()
		return
	_label.text = str(_lines.pop_front())
	Sound.play("select")

func _unhandled_input(event: InputEvent) -> void:
	if _choosing:
		if event.is_action_pressed("ui_cancel"):
			get_viewport().set_input_as_handled()
			picked.emit(-1)
		return
	if open and event.is_action_pressed("ui_accept"):
		get_viewport().set_input_as_handled()
		_next()
