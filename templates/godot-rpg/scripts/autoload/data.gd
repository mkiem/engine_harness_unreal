extends Node
## Loads every data file once: the game's content lives in data/*.json and maps/,
## so changing a stat, a skill or a map never needs code.

var characters: Dictionary = {}
var enemies: Dictionary = {}
var skills: Dictionary = {}
var items: Dictionary = {}
var encounters: Dictionary = {}
var dialogue: Dictionary = {}
var formulas: Dictionary = {}
var party: Dictionary = {}
var maps: Dictionary = {}
var legend: Dictionary = {}
var game: Dictionary = {}

func _ready() -> void:
	reload()

func reload() -> void:
	characters = read_json("res://data/characters.json")
	enemies = read_json("res://data/enemies.json")
	skills = read_json("res://data/skills.json")
	items = read_json("res://data/items.json")
	encounters = read_json("res://data/encounters.json")
	dialogue = read_json("res://data/dialogue.json")
	formulas = read_json("res://data/formulas.json")
	party = read_json("res://data/party.json")
	game = read_json("res://data/game.json")
	maps = read_json("res://maps/maps.json")
	legend = read_json("res://maps/legend.json")
	apply_ui()

## The look of every box, button and text, from "ui" in data/game.json: panel, border, text and accent colours, a
## font file (a .ttf or .otf in fonts/, pixel fonts look best) and the text size.
func apply_ui() -> void:
	var ui: Dictionary = game.get("ui", {})
	var theme := ThemeDB.get_default_theme()
	theme.default_font_size = int(ui.get("font_size", 8))
	if ui.is_empty():
		return
	var panel_color := Color(ui.get("panel", "#181425e6"))
	var border := Color(ui.get("border", "#c2c3c7"))
	var text := Color(ui.get("text", "#fff1e8"))
	var accent := Color(ui.get("accent", "#ffa300"))
	var box := func(fill: Color, edge: Color) -> StyleBoxFlat:
		var style := StyleBoxFlat.new()
		style.bg_color = fill
		style.border_color = edge
		style.set_border_width_all(1)
		style.set_corner_radius_all(int(ui.get("corner", 2)))
		style.set_content_margin_all(3)
		return style
	theme.set_stylebox("panel", "PanelContainer", box.call(panel_color, border))
	theme.set_stylebox("panel", "Panel", box.call(panel_color, border))
	theme.set_stylebox("normal", "Button", box.call(panel_color, border))
	theme.set_stylebox("hover", "Button", box.call(panel_color.lightened(0.15), accent))
	theme.set_stylebox("pressed", "Button", box.call(accent.darkened(0.4), accent))
	theme.set_stylebox("focus", "Button", box.call(panel_color.lightened(0.1), accent))
	for type in ["Label", "Button"]:
		theme.set_color("font_color", type, text)
	for name in ["font_hover_color", "font_focus_color", "font_pressed_color"]:
		theme.set_color(name, "Button", accent)
	var font_path := str(ui.get("font", ""))
	if font_path != "":
		var font: Font = null
		if ResourceLoader.exists(font_path):
			font = load(font_path)
		elif FileAccess.file_exists(font_path):
			var file := FontFile.new()
			if file.load_dynamic_font(ProjectSettings.globalize_path(font_path)) == OK:
				font = file
		if font:
			if font is FontFile:
				font.antialiasing = TextServer.FONT_ANTIALIASING_NONE
			theme.default_font = font
		else:
			push_error("Missing font: %s" % font_path)

func read_json(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		push_error("Missing data file: %s" % path)
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("%s is not a JSON object" % path)
		return {}
	return parsed

## The rows of a text map, without trailing blank lines.
func map_rows(map_id: String) -> PackedStringArray:
	var info: Dictionary = maps.get(map_id, {})
	var path := "res://maps/%s" % info.get("file", map_id + ".txt")
	if not FileAccess.file_exists(path):
		push_error("Missing map file: %s" % path)
		return PackedStringArray()
	var rows := FileAccess.get_file_as_string(path).replace("\r", "").split("\n")
	while rows.size() > 0 and rows[rows.size() - 1].strip_edges() == "":
		rows.remove_at(rows.size() - 1)
	return rows

## A texture from the project, or loaded straight from the PNG when it has not been imported yet.
func texture(path: String) -> Texture2D:
	if ResourceLoader.exists(path):
		var loaded = load(path)
		if loaded is Texture2D:
			return loaded
	if FileAccess.file_exists(path):
		var image := Image.load_from_file(ProjectSettings.globalize_path(path))
		if image:
			return ImageTexture.create_from_image(image)
	push_error("Missing texture: %s" % path)
	return null

## Evaluates a formula from data/formulas.json, such as "max(1, atk * power - def / 2)".
func formula(name: String, values: Dictionary) -> float:
	var text: String = formulas.get(name, "0")
	var expression := Expression.new()
	var names := PackedStringArray(values.keys())
	if expression.parse(text, names) != OK:
		push_error("Formula %s does not parse: %s" % [name, expression.get_error_text()])
		return 0.0
	var result = expression.execute(values.values(), self)
	if expression.has_execute_failed():
		push_error("Formula %s failed: %s" % [name, text])
		return 0.0
	return float(result)
