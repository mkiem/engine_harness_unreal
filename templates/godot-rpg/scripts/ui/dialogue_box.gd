extends CanvasLayer
## A text box at the bottom of the screen. say() shows lines one at a time; the player presses Enter/Space to go on.

signal finished

var _panel: PanelContainer
var _label: Label
var _lines: Array = []
var open := false

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
	_label.add_theme_font_size_override("font_size", 8)
	_panel.add_child(_label)
	_panel.visible = false

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
	if open and event.is_action_pressed("ui_accept"):
		get_viewport().set_input_as_handled()
		_next()
