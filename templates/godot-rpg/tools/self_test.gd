extends Node
## Checks the game's data and systems without playing: every reference between data files, every formula, levelling,
## saving and loading, and a battle. Prints one line per problem (SELFTEST FAIL ...) and SELFTEST OK when all pass.
##   godot --headless --path . res://tools/self_test.tscn

var failures: Array = []

func fail(text: String) -> void:
	failures.append(text)
	print("SELFTEST FAIL " + text)

func _ready() -> void:
	_check_data()
	_check_formulas()
	_check_levels()
	_check_save()
	_check_battle()
	if failures.is_empty():
		print("SELFTEST OK")
	get_tree().quit(0 if failures.is_empty() else 1)

func _check_data() -> void:
	for id in Data.party.get("members", []):
		if not Data.characters.has(id):
			fail("party.json starts with %s, which is not in characters.json" % id)
	for id in Data.characters.keys():
		var info: Dictionary = Data.characters[id]
		for skill in info.get("skills", []) + info.get("learns", {}).values():
			if not Data.skills.has(skill):
				fail("character %s knows skill %s, which is not in skills.json" % [id, skill])
	for id in Data.enemies.keys():
		for skill in Data.enemies[id].get("skills", []):
			if not Data.skills.has(skill):
				fail("enemy %s uses skill %s, which is not in skills.json" % [id, skill])
		var drop: Dictionary = Data.enemies[id].get("drop", {})
		if drop.has("item") and not Data.items.has(drop["item"]):
			fail("enemy %s drops %s, which is not in items.json" % [id, drop["item"]])
	for zone in Data.encounters.keys():
		for group in Data.encounters[zone].get("groups", []):
			for enemy in group:
				if not Data.enemies.has(enemy):
					fail("encounter zone %s has enemy %s, which is not in enemies.json" % [zone, enemy])
	for id in Data.party.get("items", {}).keys():
		if not Data.items.has(id):
			fail("party.json starts with item %s, which is not in items.json" % id)
	if not Data.maps.has(Data.party.get("map", "")):
		fail("party.json starts on map %s, which is not in maps.json" % Data.party.get("map", ""))
	for map_id in Data.maps.keys():
		var info: Dictionary = Data.maps[map_id]
		var rows := Data.map_rows(map_id)
		if rows.is_empty():
			fail("map %s has no rows (maps/%s)" % [map_id, info.get("file", "")])
			continue
		for y in rows.size():
			for x in rows[y].length():
				if not Data.legend.has(rows[y][x]):
					fail("map %s uses '%s' at %d,%d, which is not in legend.json" % [map_id, rows[y][x], x, y])
		var zone: String = info.get("encounters", "")
		if zone != "" and not Data.encounters.has(zone):
			fail("map %s uses encounter zone %s, which is not in encounters.json" % [map_id, zone])
		for npc in info.get("npcs", []):
			if npc.get("role", "") != "chest" and not Data.dialogue.has(npc.get("dialogue", "")):
				fail("NPC %s on %s says %s, which is not in dialogue.json" % [npc.get("id", "?"), map_id, npc.get("dialogue", "")])
			if _solid(rows, int(npc["x"]), int(npc["y"])):
				fail("NPC %s on %s stands on a solid tile at %d,%d" % [npc.get("id", "?"), map_id, int(npc["x"]), int(npc["y"])])
			for item in npc.get("stock", []):
				if not Data.items.has(item):
					fail("shop %s on %s sells %s, which is not in items.json" % [npc.get("id", "?"), map_id, item])
			for enemy in npc.get("enemies", []):
				if not Data.enemies.has(enemy):
					fail("NPC %s on %s fights %s, which is not in enemies.json" % [npc.get("id", "?"), map_id, enemy])
			if npc.has("item") and not Data.items.has(npc["item"]):
				fail("chest %s on %s holds %s, which is not in items.json" % [npc.get("id", "?"), map_id, npc["item"]])
		for warp in info.get("warps", []):
			if not Data.maps.has(warp.get("to", "")):
				fail("a warp on %s leads to map %s, which is not in maps.json" % [map_id, warp.get("to", "")])
			elif _solid(Data.map_rows(warp["to"]), int(warp["to_x"]), int(warp["to_y"])):
				fail("a warp on %s lands on a solid tile of %s" % [map_id, warp["to"]])
	var start: Array = Data.party.get("position", [0, 0])
	if Data.maps.has(Data.party.get("map", "")) and _solid(Data.map_rows(Data.party["map"]), int(start[0]), int(start[1])):
		fail("the party starts on a solid tile")

func _solid(rows: PackedStringArray, x: int, y: int) -> bool:
	if y < 0 or y >= rows.size() or x < 0 or x >= rows[y].length():
		return true
	return bool(Data.legend.get(rows[y][x], {}).get("solid", false))

func _check_formulas() -> void:
	var sample := {"atk": 10, "mag": 10, "def": 5, "level": 3, "power": 1.0, "variance": 1.0, "spd": 6}
	for name in ["physical", "magic", "heal", "xp_to_next", "run_chance"]:
		if not Data.formulas.has(name):
			fail("formulas.json has no %s formula" % name)
			continue
		var expression := Expression.new()
		if expression.parse(Data.formulas[name], PackedStringArray(sample.keys())) != OK:
			fail("formula %s does not parse: %s" % [name, expression.get_error_text()])

func _check_levels() -> void:
	Game.new_game()
	if Game.party.is_empty():
		fail("the starting party is empty")
		return
	var before := int(Game.party[0]["level"])
	Game.gain_xp(Game.xp_for_level(before) + 1)
	if int(Game.party[0]["level"]) <= before:
		fail("gaining enough XP did not raise a level (check xp_to_next)")

func _check_save() -> void:
	Game.new_game()
	Game.gold = 1234
	if not Game.save_game():
		fail("could not save to user://save.json")
		return
	Game.gold = 0
	if not Game.load_game() or Game.gold != 1234:
		fail("saving and loading did not round-trip")

func _check_battle() -> void:
	Game.new_game()
	for zone in Data.encounters.values():
		for group in zone.get("groups", []):
			var logic := BattleLogic.new()
			logic.setup(Game.party.map(func(m): return m.duplicate()), group, 7)
			if logic.run_auto() == "timeout":
				fail("a battle against %s did not end within 200 turns" % ", ".join(group))
			return
