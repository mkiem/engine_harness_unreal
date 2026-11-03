extends Node2D
## The map you walk around: built from maps/<id>.txt with the tiles in maps/legend.json, plus the NPCs, warps and
## encounters in maps/maps.json. Arrow keys move, Enter/Space talks, Esc opens the menu.
## Story events come from the NPC entries: "sets" a flag after talking, "dialogue_after" {flag: key} changes what they
## say, "only_if"/"hide_if" a flag shows or hides them, and roles: inn, shop, battle (a fixed fight such as a boss),
## chest (gives an item or gold once). A warp with "requires" a flag stays shut until it is set.

const STEP_TIME := 0.14

var tile_size := 16
var rows: PackedStringArray
var map_info: Dictionary
var tiles: TileMapLayer
var player: Sprite2D
var camera: Camera2D
var npcs: Dictionary = {}   # Vector2i -> npc info
var moving := false
var dialogue: CanvasLayer
var menu: CanvasLayer
var autotest := false
var _autotest_steps := 0

func _ready() -> void:
	tile_size = int(Data.game.get("tile_size", 16))
	autotest = OS.get_cmdline_user_args().has("--autotest")
	if Game.map_id == "" or Game.party.is_empty():
		Game.new_game()
	dialogue = preload("res://scripts/ui/dialogue_box.gd").new()
	add_child(dialogue)
	menu = preload("res://scripts/ui/pause_menu.gd").new()
	add_child(menu)
	_load_map(Game.map_id)
	_after_event.call_deferred()

## After a story battle: its "after" dialogue, once.
func _after_event() -> void:
	var event := Game.pending_event
	Game.pending_event = {}
	var key := str(event.get("after", ""))
	if key != "" and Data.dialogue.has(key):
		await dialogue.say(Data.dialogue[key])

func npc_visible(npc: Dictionary) -> bool:
	if npc.has("only_if") and not Game.has(str(npc["only_if"])):
		return false
	if npc.has("hide_if") and Game.has(str(npc["hide_if"])):
		return false
	if npc.get("role", "") == "battle" and not bool(npc.get("stay", false)) and Game.has(battle_flag(npc)):
		return false
	return true

func battle_flag(npc: Dictionary) -> String:
	return str(npc.get("flag", "beat_%s" % npc.get("id", "")))

func chest_flag(npc: Dictionary) -> String:
	return str(npc.get("flag", "chest_%s_%s" % [Game.map_id, npc.get("id", "")]))

func _load_map(map_id: String) -> void:
	for child in get_children():
		if child != dialogue and child != menu:
			child.queue_free()
	npcs.clear()
	Game.map_id = map_id
	map_info = Data.maps.get(map_id, {})
	rows = Data.map_rows(map_id)
	tiles = TileMapLayer.new()
	tiles.tile_set = _make_tileset()
	add_child(tiles)
	for y in rows.size():
		for x in rows[y].length():
			var info: Dictionary = Data.legend.get(rows[y][x], Data.legend.get(".", {}))
			tiles.set_cell(Vector2i(x, y), 0, Vector2i(int(info.get("tile", 0)), 0))
	for npc in map_info.get("npcs", []):
		if not npc_visible(npc):
			continue
		var at := Vector2i(int(npc["x"]), int(npc["y"]))
		npcs[at] = npc
		var sprite := Sprite2D.new()
		sprite.texture = Data.texture(Data.game.get("npc_sprites", "res://art/npcs.png"))
		sprite.hframes = int(Data.game.get("npc_frames", 4))
		var frame := int(npc.get("frame", 0))
		if npc.get("role", "") == "chest" and Game.has(chest_flag(npc)):
			frame = int(npc.get("open_frame", frame))
		sprite.frame = frame
		sprite.centered = false
		sprite.position = Vector2(at * tile_size)
		add_child(sprite)
	player = Sprite2D.new()
	player.texture = Data.texture(Data.game.get("hero_sprite", "res://art/hero.png"))
	player.hframes = 2
	player.vframes = 4
	player.centered = false
	player.position = Vector2(Game.position * tile_size)
	add_child(player)
	_face(Game.facing)
	camera = Camera2D.new()
	camera.limit_left = 0
	camera.limit_top = 0
	camera.limit_right = _width() * tile_size
	camera.limit_bottom = rows.size() * tile_size
	camera.position = Vector2(tile_size / 2.0, tile_size / 2.0)
	player.add_child(camera)
	camera.make_current()
	Sound.music(map_info.get("music", ""))

func _width() -> int:
	var width := 0
	for row in rows:
		width = max(width, row.length())
	return width

func _make_tileset() -> TileSet:
	var tileset := TileSet.new()
	tileset.tile_size = Vector2i(tile_size, tile_size)
	var source := TileSetAtlasSource.new()
	source.texture = Data.texture(Data.game.get("tiles", "res://art/tiles.png"))
	source.texture_region_size = Vector2i(tile_size, tile_size)
	var count := int(source.texture.get_width() / tile_size) if source.texture else 1
	for i in count:
		source.create_tile(Vector2i(i, 0))
	tileset.add_source(source, 0)
	return tileset

func tile_info(at: Vector2i) -> Dictionary:
	if at.y < 0 or at.y >= rows.size() or at.x < 0 or at.x >= rows[at.y].length():
		return {"solid": true}
	return Data.legend.get(rows[at.y][at.x], {})

func _face(direction: Vector2i) -> void:
	Game.facing = direction
	var row := 0
	if direction == Vector2i.LEFT:
		row = 1
	elif direction == Vector2i.RIGHT:
		row = 2
	elif direction == Vector2i.UP:
		row = 3
	player.frame = row * 2

func _process(_delta: float) -> void:
	if moving or dialogue.open or menu.open or Router.busy:
		return
	if autotest:
		_autotest_step()
		return
	var direction := Vector2i.ZERO
	if Input.is_action_pressed("ui_up"):
		direction = Vector2i.UP
	elif Input.is_action_pressed("ui_down"):
		direction = Vector2i.DOWN
	elif Input.is_action_pressed("ui_left"):
		direction = Vector2i.LEFT
	elif Input.is_action_pressed("ui_right"):
		direction = Vector2i.RIGHT
	if direction != Vector2i.ZERO:
		step(direction)

func _unhandled_input(event: InputEvent) -> void:
	if moving or dialogue.open or menu.open or Router.busy:
		return
	if event.is_action_pressed("ui_accept"):
		interact()
	elif event.is_action_pressed("ui_cancel"):
		menu.show_menu()

func step(direction: Vector2i) -> void:
	_face(direction)
	var target := Game.position + direction
	if bool(tile_info(target).get("solid", false)) or npcs.has(target):
		return
	moving = true
	var tween := create_tween()
	tween.tween_property(player, "position", Vector2(target * tile_size), STEP_TIME)
	player.frame = player.frame - player.frame % 2 + 1
	await tween.finished
	player.frame = player.frame - player.frame % 2
	Game.position = target
	moving = false
	_after_step()

func _after_step() -> void:
	for warp in map_info.get("warps", []):
		if Vector2i(int(warp["x"]), int(warp["y"])) == Game.position:
			if warp.has("requires") and not Game.has(str(warp["requires"])):
				await dialogue.say(Data.dialogue.get(str(warp.get("locked", "")), ["The way is shut."]))
				return
			Game.position = Vector2i(int(warp["to_x"]), int(warp["to_y"]))
			Sound.play("door")
			_load_map(warp["to"])
			return
	var info := tile_info(Game.position)
	var zone: String = map_info.get("encounters", "")
	if zone != "" and bool(info.get("encounters", false)):
		Game.steps_since_battle += 1
		var table: Dictionary = Data.encounters.get(zone, {})
		if Game.steps_since_battle > 3 and randf() < float(table.get("rate", 0.1)):
			var groups: Array = table.get("groups", [])
			if not groups.is_empty():
				Game.steps_since_battle = 0
				Sound.play("encounter")
				Router.battle(groups[randi() % groups.size()])

func interact() -> void:
	var at := Game.position + Game.facing
	if not npcs.has(at):
		return
	var npc: Dictionary = npcs[at]
	if npc.get("role", "") == "chest":
		await _chest(npc)
		return
	var lines: Array = Data.dialogue.get(dialogue_key(npc), ["..."])
	await dialogue.say(lines)
	Game.set_flag(str(npc.get("sets", "")))
	match npc.get("role", ""):
		"inn":
			Game.heal_all()
			Sound.play("heal")
			await dialogue.say(["Your party is fully rested."])
		"shop":
			await _shop(npc.get("stock", []))
		"battle":
			Game.pending_event = {"flag": battle_flag(npc), "after": npc.get("after", ""), "ending": bool(npc.get("ending", false)), "no_run": bool(npc.get("no_run", true))}
			Sound.play("encounter")
			Router.battle(npc.get("enemies", []))

## The dialogue an NPC uses now: the last "dialogue_after" entry whose flag is set, else "dialogue".
func dialogue_key(npc: Dictionary) -> String:
	var key := str(npc.get("dialogue", ""))
	var after: Dictionary = npc.get("dialogue_after", {})
	for flag in after:
		if Game.has(str(flag)):
			key = str(after[flag])
	return key

func _chest(npc: Dictionary) -> void:
	var flag := chest_flag(npc)
	if Game.has(flag):
		await dialogue.say(["It's empty."])
		return
	Game.set_flag(flag)
	var found: Array = []
	if npc.has("item"):
		Game.add_item(str(npc["item"]), int(npc.get("count", 1)))
		found.append("%s x%d" % [Data.items.get(str(npc["item"]), {}).get("name", npc["item"]), int(npc.get("count", 1))])
	if int(npc.get("gold", 0)) > 0:
		Game.gold += int(npc["gold"])
		found.append("%d gold" % int(npc["gold"]))
	Sound.play("item")
	await dialogue.say(["Found %s!" % " and ".join(found) if not found.is_empty() else "Found nothing."])
	_load_map(Game.map_id)

## A shop: pick an item to buy, as many times as you like; Esc or Leave closes it.
func _shop(stock: Array) -> void:
	while true:
		var options: Array = []
		for id in stock:
			var item: Dictionary = Data.items.get(id, {})
			options.append("%s  %dG" % [item.get("name", id), int(item.get("price", 10))])
		options.append("Leave")
		var index: int = await dialogue.choose("Gold: %d. What would you like?" % Game.gold, options)
		if index < 0 or index >= stock.size():
			return
		var id: String = stock[index]
		var item: Dictionary = Data.items.get(id, {})
		var price := int(item.get("price", 10))
		if Game.gold < price:
			Sound.play("cancel")
			await dialogue.say(["You need %d gold for %s." % [price, item.get("name", id)]])
			continue
		Game.gold -= price
		Game.add_item(id)
		Sound.play("coin")
		await dialogue.say(["Bought %s. (%d gold left)" % [item.get("name", id), Game.gold]])

## For headless tests: walks to a map with encounters (through its warps), then through encounter tiles until a battle
## starts. The battle scene, also in autotest mode, fights it out and quits. Gives up after 300 steps.
var _route: Array = []

func _autotest_step() -> void:
	_autotest_steps += 1
	if _autotest_steps > 300:
		print("AUTOTEST overworld: walked %d steps without a battle" % _autotest_steps)
		get_tree().quit(0)
		return
	if _route.is_empty():
		_route = _route_to_goal()
		if _route.is_empty():
			print("AUTOTEST overworld: nowhere to go")
			get_tree().quit(1)
			return
	var next: Vector2i = _route.pop_front()
	var direction := next - Game.position
	if abs(direction.x) + abs(direction.y) != 1:
		_route.clear()
		return
	step(direction)

## A shortest walk to the goal: an encounter tile when this map has encounters (then back and forth on them), else a warp.
func _route_to_goal() -> Array:
	var goals: Array = []
	if map_info.get("encounters", "") != "":
		for y in rows.size():
			for x in rows[y].length():
				var at := Vector2i(x, y)
				if bool(tile_info(at).get("encounters", false)) and at != Game.position:
					goals.append(at)
	else:
		for warp in map_info.get("warps", []):
			goals.append(Vector2i(int(warp["x"]), int(warp["y"])))
	var came := {Game.position: Game.position}
	var queue: Array = [Game.position]
	while not queue.is_empty():
		var at: Vector2i = queue.pop_front()
		if goals.has(at):
			var path: Array = []
			while at != Game.position:
				path.push_front(at)
				at = came[at]
			return path
		for direction in [Vector2i.RIGHT, Vector2i.DOWN, Vector2i.LEFT, Vector2i.UP]:
			var next: Vector2i = at + direction
			if came.has(next) or npcs.has(next) or bool(tile_info(next).get("solid", false)):
				continue
			came[next] = at
			queue.append(next)
	return []
