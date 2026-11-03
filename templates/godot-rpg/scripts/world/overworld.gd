extends Node2D
## The map you walk around: built from maps/<id>.txt with the tiles in maps/legend.json, plus the NPCs, warps,
## triggers and encounters in maps/maps.json. Arrow keys move, Enter/Space talks, Esc opens the menu.
##
## People and places start story events (data/events.json, run by EventRunner): an NPC's "event", a map's "on_enter"
## and its "triggers" (a tile that starts an event when stepped on). NPCs without an event use their "dialogue" and
## "role": inn (rest for a price), shop (buy and sell "stock"), chest (gives "item"/"gold" once), battle (a fixed
## fight) and waystone (fast travel between attuned waystones, from the Gameplay Atlas by loopyhop). "only_if"/"hide_if" a flag shows or hides an NPC; a warp with "requires" a flag stays shut until it is set.
## This node is also the host EventRunner asks to talk, offer choices, move people, start battles and warp.

const STEP_TIME := 0.14
const DIRECTIONS := {"up": Vector2i.UP, "down": Vector2i.DOWN, "left": Vector2i.LEFT, "right": Vector2i.RIGHT}

var tile_size := 16
var rows: PackedStringArray
var map_info: Dictionary
var tiles: TileMapLayer
var player: Sprite2D
var camera: Camera2D
var npcs: Dictionary = {}         # Vector2i -> npc info
var npc_sprites: Dictionary = {}  # npc id -> Sprite2D
var moving := false
var in_event := false
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
	_after_battle.call_deferred()

func busy() -> bool:
	return moving or in_event or dialogue.open or menu.open or Router.busy

## Back from a story battle: what it said to do after winning ("after" dialogue, "then" commands) or losing ("lose").
func _after_battle() -> void:
	var event := Game.pending_event
	Game.pending_event = {}
	if event.is_empty():
		_on_enter()
		return
	var key := str(event.get("after", ""))
	if key != "" and Data.dialogue.has(key):
		await dialogue.say(Data.dialogue[key])
	var commands: Array = event.get("lose", []) if bool(event.get("lost", false)) else event.get("then", [])
	if not commands.is_empty():
		await run_commands(commands)

func npc_visible(npc: Dictionary) -> bool:
	if npc.has("only_if") and not Game.has(str(npc["only_if"])):
		return false
	if npc.has("hide_if") and Game.has(str(npc["hide_if"])):
		return false
	if Game.has(EventRunner.hidden_flag(str(npc.get("id", "")))):
		return false
	if npc.get("role", "") == "battle" and not bool(npc.get("stay", false)) and Game.has(battle_flag(npc)):
		return false
	return true

func battle_flag(npc: Dictionary) -> String:
	return str(npc.get("flag", "beat_%s" % npc.get("id", "")))

func chest_flag(npc: Dictionary) -> String:
	return str(npc.get("flag", "chest_%s_%s" % [Game.map_id, npc.get("id", "")]))

func npc_position(npc: Dictionary) -> Vector2i:
	var moved: Array = Game.npc_moved.get("%s/%s" % [Game.map_id, npc.get("id", "")], [])
	if moved.size() == 2:
		return Vector2i(int(moved[0]), int(moved[1]))
	return Vector2i(int(npc["x"]), int(npc["y"]))

func _load_map(map_id: String) -> void:
	for child in get_children():
		if child != dialogue and child != menu:
			child.queue_free()
	npcs.clear()
	npc_sprites.clear()
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
		var at := npc_position(npc)
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
		npc_sprites[str(npc.get("id", ""))] = sprite
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
	Game.battle_background = str(map_info.get("battle_background", ""))

## A map's "on_enter" events, run on arriving (each "once" event only the first time).
func _on_enter() -> void:
	for entry in map_info.get("on_enter", []):
		if await _maybe_run(entry, "enter"):
			return

## Runs a trigger or on_enter entry if its conditions hold and (when "once") it has not run before.
func _maybe_run(entry: Dictionary, kind: String) -> bool:
	var seen := "seen_%s_%s_%s" % [Game.map_id, kind, entry.get("event", "")]
	if bool(entry.get("once", false)) and Game.has(seen):
		return false
	if entry.has("if") and not EventRunner.test(entry["if"]):
		return false
	if bool(entry.get("once", false)):
		Game.set_flag(seen)
	await run_event(str(entry.get("event", "")))
	return true

func _width() -> int:
	var width := 0
	for row in rows:
		width = maxi(width, row.length())
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
	player.frame = _facing_row(direction) * 2

static func _facing_row(direction: Vector2i) -> int:
	if direction == Vector2i.LEFT:
		return 1
	if direction == Vector2i.RIGHT:
		return 2
	if direction == Vector2i.UP:
		return 3
	return 0

func _process(_delta: float) -> void:
	if busy():
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
	if busy():
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
	for trigger in map_info.get("triggers", []):
		if Vector2i(int(trigger["x"]), int(trigger["y"])) == Game.position:
			if await _maybe_run(trigger, "trigger"):
				return
	for warp in map_info.get("warps", []):
		if Vector2i(int(warp["x"]), int(warp["y"])) == Game.position:
			if warp.has("requires") and not Game.has(str(warp["requires"])):
				in_event = true
				await dialogue.say(Data.dialogue.get(str(warp.get("locked", "")), ["The way is shut."]))
				in_event = false
				return
			warp_to(str(warp["to"]), int(warp["to_x"]), int(warp["to_y"]))
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

func warp_to(map_id: String, x: int, y: int) -> void:
	Game.position = Vector2i(x, y)
	Sound.play("door")
	_load_map(map_id)
	await _on_enter()

func interact() -> void:
	var at := Game.position + Game.facing
	if not npcs.has(at):
		return
	var npc: Dictionary = npcs[at]
	in_event = true
	if npc.has("event"):
		await run_event(str(npc["event"]))
	elif npc.get("role", "") == "chest":
		await _chest(npc)
	elif npc.get("role", "") == "waystone":
		await waystone(npc)
	else:
		await say(Data.dialogue.get(dialogue_key(npc), ["..."]), "")
		Game.set_flag(str(npc.get("sets", "")))
		match npc.get("role", ""):
			"inn":
				await inn(int(npc.get("price", 0)))
			"shop":
				await shop(npc.get("stock", []))
			"waystone":
				await waystone(npc)
			"battle":
				battle({"battle": npc.get("enemies", []), "flag": battle_flag(npc), "after": npc.get("after", ""),
					"ending": bool(npc.get("ending", false)), "no_run": bool(npc.get("no_run", true))})
	in_event = false

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
		await say(["It's empty."], "")
		return
	Game.set_flag(flag)
	var found: Array = []
	if npc.has("item"):
		Game.add_item(str(npc["item"]), int(npc.get("count", 1)))
		var count := int(npc.get("count", 1))
		found.append("%s%s" % [Data.items.get(str(npc["item"]), {}).get("name", npc["item"]), " x%d" % count if count > 1 else ""])
	if int(npc.get("gold", 0)) > 0:
		Game.gold += int(npc["gold"])
		found.append("%d gold" % int(npc["gold"]))
	Sound.play("item")
	await say(["Found %s!" % " and ".join(found) if not found.is_empty() else "Found nothing."], "")
	refresh()

# ---- the event host ---------------------------------------------------------------------------------------------

func run_event(id: String) -> void:
	if not Data.events.has(id):
		return
	await run_commands(Data.events[id])

func run_commands(commands: Array) -> void:
	var was := in_event
	in_event = true
	var runner := EventRunner.new(self)
	await runner.run(commands)
	in_event = was

func say(lines: Array, who: String) -> void:
	await dialogue.say(lines, who)

func choose(question: String, options: Array) -> int:
	return await dialogue.choose(question, options)

func refresh() -> void:
	_load_map(Game.map_id)

func wait(seconds: float) -> void:
	await get_tree().create_timer(seconds).timeout

func face(who: String, direction: String) -> void:
	var dir: Vector2i = DIRECTIONS.get(direction, Vector2i.DOWN)
	if who == "player":
		_face(dir)

## Walks the player or an NPC along a path of directions, one tile at a time (a cutscene).
func move(who: String, path: Array) -> void:
	for word in path:
		var dir: Vector2i = DIRECTIONS.get(str(word), Vector2i.ZERO)
		if dir == Vector2i.ZERO:
			continue
		if who == "player":
			_face(dir)
			var tween := create_tween()
			Game.position += dir
			tween.tween_property(player, "position", Vector2(Game.position * tile_size), STEP_TIME * 1.5)
			await tween.finished
			continue
		var sprite: Sprite2D = npc_sprites.get(who)
		if sprite == null:
			return
		var from := Vector2i(sprite.position / tile_size)
		var npc: Dictionary = npcs.get(from, {})
		npcs.erase(from)
		var to := from + dir
		npcs[to] = npc
		Game.npc_moved["%s/%s" % [Game.map_id, who]] = [to.x, to.y]
		var tween := create_tween()
		tween.tween_property(sprite, "position", Vector2(to * tile_size), STEP_TIME * 1.5)
		await tween.finished

## An inn: rest for a price (0 is free); everyone is revived, healed and cured.
func inn(price: int) -> void:
	if price > 0:
		var index := await choose("Stay the night for %d gold? (You have %d.)" % [price, Game.gold], ["Stay", "Leave"])
		if index != 0:
			return
		if Game.gold < price:
			Sound.play("cancel")
			await say(["You don't have enough gold."], "")
			return
		Game.gold -= price
	Game.heal_all()
	Sound.play("heal")
	await say(["You rest well. Everyone is back to full strength."], "")

## A waystone: touching one attunes it (it must be reached on foot first); then travel to any other attuned waystone.
func waystone(npc: Dictionary) -> void:
	var flag := waystone_flag(Game.map_id, npc)
	var name := str(npc.get("name", Data.maps.get(Game.map_id, {}).get("name", Game.map_id)))
	if not Game.has(flag):
		Game.set_flag(flag)
		Sound.play("magic")
		await say(["The waystone hums. Attuned: %s." % name], "")
	var destinations: Array = []
	for map_id in Data.maps.keys():
		for other in Data.maps[map_id].get("npcs", []):
			if other.get("role", "") == "waystone" and Game.has(waystone_flag(map_id, other)) and not (map_id == Game.map_id and other.get("id") == npc.get("id")):
				destinations.append({"map": map_id, "npc": other})
	if destinations.is_empty():
		await say(["Attune other waystones on your travels to journey between them."], "")
		return
	var labels: Array = destinations.map(func(d): return str(d["npc"].get("name", Data.maps.get(d["map"], {}).get("name", d["map"]))))
	var index := await choose("Travel to which waystone?", labels + ["Stay"])
	if index < 0 or index >= destinations.size():
		return
	var target: Dictionary = destinations[index]
	var arrive: Array = target["npc"].get("arrive", [int(target["npc"]["x"]), int(target["npc"]["y"]) + 1])
	Game.facing = Vector2i.DOWN
	await warp_to(str(target["map"]), int(arrive[0]), int(arrive[1]))

static func waystone_flag(map_id: String, npc: Dictionary) -> String:
	return "waystone_%s_%s" % [map_id, npc.get("id", "")]

## A shop: buy from its stock (equipment shows what it would change for each member) and sell what you carry.
func shop(stock: Array) -> void:
	while true:
		var index := await choose("Gold: %d. What would you like to do?" % Game.gold, ["Buy", "Sell", "Leave"])
		if index == 0:
			await _buy(stock)
		elif index == 1:
			await _sell()
		else:
			return

func _buy(stock: Array) -> void:
	while true:
		var labels: Array = stock.map(func(id): return "%s  %dG" % [Data.items.get(id, {}).get("name", id), int(Data.items.get(id, {}).get("price", 10))])
		var index: int = await dialogue.choose("Gold: %d. Buy what?" % Game.gold, labels + ["Back"], func(i): return item_details(stock[i]) if i < stock.size() else "")
		if index < 0 or index >= stock.size():
			return
		var id: String = stock[index]
		var item: Dictionary = Data.items.get(id, {})
		var price := int(item.get("price", 10))
		if Game.gold < price:
			Sound.play("cancel")
			await say(["You need %d gold for that." % price], "")
			continue
		Game.gold -= price
		Game.add_item(id)
		Sound.play("coin")
		if item.has("slot"):
			for member in Game.party:
				if Game.can_equip(member, id) and _better(member, id):
					var equip_now := await choose("Equip the %s on %s now?" % [item.get("name", id), Game.member_name(member)], ["Equip", "Not now"])
					if equip_now == 0:
						Game.equip(member, str(item["slot"]), id)
						Sound.play("select")
					break

func _better(member: Dictionary, id: String) -> bool:
	var slot_name := str(Data.items.get(id, {}).get("slot", ""))
	var current := str(member["equipment"].get(slot_name, ""))
	return Game._gear_score(id) > Game._gear_score(current)

func _sell() -> void:
	while true:
		var ids: Array = Game.inventory.keys().filter(func(id): return int(Data.items.get(id, {}).get("price", 0)) > 0 and Data.items.get(id, {}).get("kind", "") != "key")
		if ids.is_empty():
			await say(["You have nothing to sell."], "")
			return
		var rate := float(Game.rule("sell_rate", 0.5))
		var labels: Array = ids.map(func(id): return "%s x%d  %dG" % [Data.items[id].get("name", id), int(Game.inventory[id]), int(Data.items[id].get("price", 0) * rate)])
		var index: int = await dialogue.choose("Gold: %d. Sell what?" % Game.gold, labels + ["Back"], func(i): return item_details(ids[i]) if i < ids.size() else "")
		if index < 0 or index >= ids.size():
			return
		Game.add_item(ids[index], -1)
		Game.gold += int(Data.items[ids[index]].get("price", 0) * rate)
		Sound.play("coin")

## What an item does, and for equipment what it would change for each member who can use it.
func item_details(id: String) -> String:
	var item: Dictionary = Data.items.get(id, {})
	var lines: Array = [str(item.get("about", ""))]
	if item.has("slot"):
		for member in Game.party + Game.reserve:
			if not Game.can_equip(member, id):
				continue
			var current := str(member["equipment"].get(item["slot"], ""))
			var changes: Array = []
			for stat_name in ["hp", "mp", "atk", "def", "mag", "spd"]:
				var delta := int(item.get("stats", {}).get(stat_name, 0)) - int(Data.items.get(current, {}).get("stats", {}).get(stat_name, 0))
				if delta != 0:
					changes.append("%s %+d" % [stat_name.to_upper(), delta])
			lines.append("%s: %s" % [Game.member_name(member), ", ".join(changes) if not changes.is_empty() else "no change"])
	return "\n".join(lines)

## A story battle; the event stops here and continues from "then" (or "lose") back on the map.
func battle(command: Dictionary) -> void:
	Game.pending_event = {"flag": str(command.get("flag", "")), "after": str(command.get("after", "")), "then": command.get("then", []),
		"lose": command.get("lose", []), "ending": bool(command.get("ending", false)), "no_run": bool(command.get("no_run", true)),
		"can_lose": bool(command.get("can_lose", false))}
	if command.has("background"):
		Game.battle_background = str(command["background"])
	Sound.play("encounter")
	Router.battle(command.get("battle", []))

func warp(map_id: String, x: int, y: int) -> void:
	await warp_to(map_id, x, y)

func ending() -> void:
	Router.go("res://scenes/ending.tscn")

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
