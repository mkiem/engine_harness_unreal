extends Node
## Checks the game's data and systems without playing: references between data files, formulas, levelling, equipment,
## the party, saving and loading, the battle rules (elements, statuses, revive, boss phases, enemy AI) and every story
## event. Prints one line per problem (SELFTEST FAIL ...) and SELFTEST OK when all pass.
##   godot --headless --path . res://tools/self_test.tscn

var failures: Array = []

func fail(text: String) -> void:
	failures.append(text)
	print("SELFTEST FAIL " + text)

func expect(ok: bool, text: String) -> void:
	if not ok:
		fail(text)

func _ready() -> void:
	_check_data()
	_check_formulas()
	_check_levels()
	_check_equipment()
	_check_party()
	_check_save()
	_check_battles()
	_check_rules()
	await _check_events()
	if failures.is_empty():
		print("SELFTEST OK")
	get_tree().quit(0 if failures.is_empty() else 1)

func _check_data() -> void:
	for id in Data.party.get("members", []):
		expect(Data.characters.has(id), "party.json starts with %s, which is not in characters.json" % id)
	for id in Data.characters.keys():
		var info: Dictionary = Data.characters[id]
		for skill in info.get("skills", []) + info.get("learns", {}).values():
			expect(Data.skills.has(skill), "character %s knows skill %s, which is not in skills.json" % [id, skill])
		for slot_name in info.get("equipment", {}).keys():
			var item_id := str(info["equipment"][slot_name])
			expect(Data.items.get(item_id, {}).get("slot", "") == slot_name, "character %s starts with %s in their %s slot, which is not a %s in items.json" % [id, item_id, slot_name, slot_name])
	for id in Data.enemies.keys():
		for skill in Data.enemies[id].get("skills", []):
			expect(Data.skills.has(skill), "enemy %s uses skill %s, which is not in skills.json" % [id, skill])
		for rule in Data.enemies[id].get("ai", []):
			var skill_id := str(rule.get("skill", "attack"))
			expect(skill_id in ["attack", "defend"] or Data.skills.has(skill_id), "enemy %s's AI uses %s, which is not in skills.json" % [id, skill_id])
	for zone in Data.encounters.keys():
		for group in Data.encounters[zone].get("groups", []):
			for enemy in group:
				expect(Data.enemies.has(enemy), "encounter zone %s has enemy %s, which is not in enemies.json" % [zone, enemy])
	for id in Data.party.get("items", {}).keys():
		expect(Data.items.has(id), "party.json starts with item %s, which is not in items.json" % id)
	expect(Data.maps.has(Data.party.get("map", "")), "party.json starts on map %s, which is not in maps.json" % Data.party.get("map", ""))
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
		for npc in info.get("npcs", []):
			if npc.has("event"):
				expect(Data.events.has(npc["event"]), "NPC %s on %s runs event %s, which is not in events.json" % [npc.get("id", "?"), map_id, npc["event"]])
			elif not npc.get("role", "") in ["chest", "waystone"]:
				expect(Data.dialogue.has(npc.get("dialogue", "")), "NPC %s on %s says %s, which is not in dialogue.json" % [npc.get("id", "?"), map_id, npc.get("dialogue", "")])
			expect(not _solid(rows, int(npc["x"]), int(npc["y"])), "NPC %s on %s stands on a solid tile at %d,%d" % [npc.get("id", "?"), map_id, int(npc["x"]), int(npc["y"])])
		for warp in info.get("warps", []):
			if not Data.maps.has(warp.get("to", "")):
				fail("a warp on %s leads to map %s, which is not in maps.json" % [map_id, warp.get("to", "")])
			elif _solid(Data.map_rows(warp["to"]), int(warp["to_x"]), int(warp["to_y"])):
				fail("a warp on %s lands on a solid tile of %s" % [map_id, warp["to"]])
	var start: Array = Data.party.get("position", [0, 0])
	if Data.maps.has(Data.party.get("map", "")):
		expect(not _solid(Data.map_rows(Data.party["map"]), int(start[0]), int(start[1])), "the party starts on a solid tile")

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
	var member: Dictionary = Game.party[0]
	var before := int(member["level"])
	var raised := Game.gain_xp(Game.xp_for_level(before) + 1)
	expect(int(member["level"]) > before, "gaining enough XP did not raise a level (check xp_to_next)")
	expect(not raised.is_empty() and raised[0].has("gains"), "a level-up does not report what it gained")

func _check_equipment() -> void:
	Game.new_game()
	var member: Dictionary = Game.party[0]
	for slot_name in Game.EQUIP_SLOTS:
		var item_id := str(member["equipment"].get(slot_name, ""))
		if item_id == "":
			continue
		var bonus := int(Data.items[item_id].get("stats", {}).get("atk", 0))
		var with_it := Game.stat(member, "atk")
		Game.equip(member, slot_name, "")
		expect(Game.stat(member, "atk") == with_it - bonus, "taking off %s did not change attack by its bonus" % item_id)
		expect(int(Game.inventory.get(item_id, 0)) >= 1, "taking off %s did not put it back in the inventory" % item_id)
		expect(Game.equip(member, slot_name, item_id), "could not put %s back on" % item_id)
		expect(Game.stat(member, "atk") == with_it, "putting %s back on did not restore attack" % item_id)
	for item_id in Data.items.keys():
		var item: Dictionary = Data.items[item_id]
		if item.has("slot"):
			expect(item["slot"] in Game.EQUIP_SLOTS, "item %s has slot %s; slots are %s" % [item_id, item["slot"], ", ".join(Game.EQUIP_SLOTS)])
			for user in item.get("users", []):
				expect(Data.characters.has(user), "item %s can be used by %s, who is not in characters.json" % [item_id, user])

func _check_party() -> void:
	Game.new_game()
	var size := Game.party.size()
	for id in Data.characters.keys():
		if not Game.has_member(id):
			Game.join(id)
			expect(Game.has_member(id), "%s could not join the party" % id)
			Game.leave(id)
			expect(not Game.has_member(id), "%s could not leave the party" % id)
			Game.join(id)
			expect(Game.has_member(id), "%s could not join again after leaving" % id)
	expect(Game.party.size() <= int(Game.rule("max_party", 4)), "the party grew past max_party")
	expect(Game.party.size() >= size, "joining made the party smaller")

func _check_save() -> void:
	Game.new_game()
	Game.gold = 1234
	Game.set_flag("selftest")
	Game.set_quest("selftest", "start")
	var weapon := str(Game.party[0]["equipment"].get("weapon", ""))
	if not Game.save_game(Game.SLOTS):
		fail("could not save to user://save_%d.json" % Game.SLOTS)
		return
	Game.new_game()
	expect(Game.load_game(Game.SLOTS) and Game.gold == 1234, "saving and loading did not round-trip the gold")
	expect(Game.has("selftest") and Game.quest_stage("selftest") == "start", "saving and loading lost flags or quests")
	expect(str(Game.party[0]["equipment"].get("weapon", "")) == weapon, "saving and loading lost equipment")
	DirAccess.remove_absolute(Game.save_path(Game.SLOTS))

## Every encounter group and story battle ends within 200 rounds at a generous level.
func _check_battles() -> void:
	var groups: Array = []
	for zone in Data.encounters.values():
		groups += zone.get("groups", [])
	for event_id in Data.events.keys():
		_collect_battles(Data.events[event_id], groups)
	for group in groups:
		Game.new_game()
		var members: Array = Game.party.map(func(m): return Game.make_member(m["id"], 12))
		var logic := BattleLogic.new()
		logic.setup(members, group, 7)
		if logic.run_auto() == "timeout":
			fail("a battle against %s did not end within 200 rounds" % ", ".join(group))

func _collect_battles(commands: Array, into: Array) -> void:
	for c in commands:
		if typeof(c) != TYPE_DICTIONARY:
			continue
		if c.has("battle"):
			into.append(c["battle"])
		for key in ["then", "else", "lose"]:
			if typeof(c.get(key)) == TYPE_ARRAY:
				_collect_battles(c[key], into)
		for option in c.get("options", []):
			_collect_battles(option.get("then", []), into)

## The battle rules themselves, on made-up fighters, so a change to battle_logic.gd that breaks one shows up here.
func _check_rules() -> void:
	var logic := BattleLogic.new()
	logic.rng.seed = 3
	var dummy := func(name: String) -> Dictionary:
		return {"name": name, "side": "enemy", "id": "", "hp": 100, "max_hp": 100, "mp": 0, "max_mp": 0,
			"base": {"atk": 10, "def": 0, "mag": 10, "spd": 5}, "skills": [], "level": 1, "defending": false, "statuses": {},
			"element": "", "weak": [], "resist": [], "absorb": [], "immune": [], "crit": 0.0, "evade": 0.0, "on_hit": {},
			"ai": [], "phases": [], "phase": 0, "used": {}, "intent": {}, "charging": {}, "acted": -1, "shield": 0, "max_shield": 0,
			"uninterruptible": false}
	var hero: Dictionary = dummy.call("Hero")
	hero["side"] = "party"
	var foe: Dictionary = dummy.call("Foe")
	logic.party = [hero]
	logic.enemies = [foe]
	var statuses := Data.statuses
	if statuses.has("poison"):
		logic.inflict(hero, "poison", 1.0)
		logic.begin_turn(hero)
		expect(int(hero["hp"]) < 100, "poison did no damage at the start of a turn")
		hero["statuses"] = {}
		hero["hp"] = 100
		hero["immune"] = ["poison"]
		expect(logic.inflict(hero, "poison", 1.0) == "", "immunity did not stop poison")
		hero["immune"] = []
	if statuses.has("sleep"):
		logic.inflict(foe, "sleep", 1.0)
		expect(not logic.begin_turn(foe), "a sleeping fighter still acted")
		logic.act(hero, "attack", foe)
		expect(not foe["statuses"].has("sleep") or int(foe["hp"]) <= 0, "a hit did not wake a sleeping fighter")
		foe["statuses"] = {}
	if statuses.has("atk_up"):
		var before := logic.stat(hero, "atk")
		logic.inflict(hero, "atk_up", 1.0)
		expect(logic.stat(hero, "atk") > before, "Attack Up did not raise attack")
		for i in 10:
			logic.end_turn(hero)
		expect(not hero["statuses"].has("atk_up"), "Attack Up never wore off")
	# Elements: a weakness hurts more than a neutral hit, a resistance less, absorbing heals.
	var element := str(Data.rules.get("elements", ["fire"])[0]) if not Data.rules.get("elements", []).is_empty() else "fire"
	var skill := {"type": "magic", "power": 1.0, "element": element, "name": "Test"}
	var damage := func(kind: String) -> int:
		foe["weak"] = []
		foe["resist"] = []
		foe["absorb"] = []
		if kind != "":
			foe[kind] = [element]
		foe["hp"] = 100
		logic.rng.seed = 5
		logic._apply(hero, foe, skill, false, 1.0)
		return 100 - int(foe["hp"])
	var neutral: int = damage.call("")
	expect(int(damage.call("weak")) > neutral, "a weakness did not increase damage")
	expect(int(damage.call("resist")) < neutral, "a resistance did not reduce damage")
	foe["hp"] = 50
	foe["absorb"] = [element]
	foe["weak"] = []
	foe["resist"] = []
	logic._apply(hero, foe, skill, false, 1.0)
	expect(int(foe["hp"]) >= 50, "an absorbed element still did damage")
	foe["absorb"] = []
	# Revive brings back a fallen fighter; a phase triggers when HP falls.
	hero["hp"] = 0
	logic._apply(foe, hero, {"type": "heal", "revive": true, "power": 1.0, "target": "ko_ally"}, false, 1.0)
	expect(int(hero["hp"]) > 0, "revive did not bring back a fallen fighter")
	foe["hp"] = 100
	foe["phases"] = [{"below": 0.5, "stats": {"atk": 2.0}}]
	foe["phase"] = 0
	logic._hurt(foe, 60, {"kind": "damage"})
	expect(int(foe["phase"]) == 1 and logic.stat(foe, "atk") == 20, "a boss phase did not start below its threshold")
	foe["phases"] = []
	_check_atlas_rules(logic, dummy)

## Intent, charged attacks and interrupts, taunts and break shields (from the Gameplay Atlas by loopyhop).
func _check_atlas_rules(logic: BattleLogic, dummy: Callable) -> void:
	var a: Dictionary = dummy.call("A")
	var b: Dictionary = dummy.call("B")
	for c in [a, b]:
		c["side"] = "party"
	var foe: Dictionary = dummy.call("Foe")
	logic.party = [a, b]
	logic.enemies = [foe]
	logic.outcome = ""
	# Intent: what an enemy plans at the start of the round is what it does.
	foe["ai"] = [{"skill": "attack", "target": "weakest"}]
	b["hp"] = 50
	logic.start_round()
	expect(is_same(foe["intent"].get("target", {}), b), "an enemy's planned target (intent) is not the one its rule picks")
	expect(logic.intent_text(foe) == "Attack -> B", "the intent text does not say what the enemy will do")
	logic.enemy_turn(foe)
	expect(int(b["hp"]) < 50 and int(a["hp"]) == 100, "an enemy did not do what its intent showed")
	# Taunt: a taunting fighter draws planned single-target attacks.
	if Data.statuses.has("taunt"):
		logic.start_round()
		logic.inflict(a, "taunt", 1.0)
		expect(is_same(foe["intent"].get("target", {}), a), "a taunt did not redirect a planned attack")
		a["statuses"] = {}
	# Charge and interrupt: a charged skill waits a turn and an interrupting hit cancels it.
	var charged := ""
	var breaker := ""
	for id in Data.skills.keys():
		if int(Data.skills[id].get("charge", 0)) > 0 and charged == "":
			charged = id
		if bool(Data.skills[id].get("interrupts", false)) and breaker == "":
			breaker = id
	if charged != "":
		foe["mp"] = 99
		var before := int(a["hp"])
		logic.act(foe, "skill", a, charged)
		expect(not foe["charging"].is_empty() and int(a["hp"]) == before, "a charged skill did not wait to gather power")
		if breaker != "":
			a["mp"] = 99
			logic.act(a, "skill", foe, breaker)
			expect(foe["charging"].is_empty(), "an interrupting skill did not stop a gathering attack")
		foe["charging"] = {}
	# Break: weakness hits wear a shield down; at zero the enemy is broken and takes more damage.
	if Data.statuses.has("broken"):
		var element := str(Data.rules.get("elements", ["fire"])[0]) if not Data.rules.get("elements", []).is_empty() else "fire"
		foe["weak"] = [element]
		foe["shield"] = 2
		foe["max_shield"] = 2
		foe["hp"] = 100
		foe["statuses"] = {}
		var spell := {"type": "magic", "power": 0.1, "element": element, "name": "Test"}
		logic._apply(a, foe, spell, false, 1.0)
		expect(int(foe["shield"]) == 1, "a weakness hit did not wear down a break shield")
		logic._apply(a, foe, spell, false, 1.0)
		expect(foe["statuses"].has("broken"), "an enemy whose shield reached zero was not broken")
		expect(not logic.begin_turn(foe), "a broken enemy still acted")
		for i in 3:
			logic.end_turn(foe)
		expect(not foe["statuses"].has("broken") and int(foe["shield"]) == 2, "a broken enemy did not recover its shield")

## Every event runs to the end without a host, taking each choice in turn, and only names things that exist.
func _check_events() -> void:
	for event_id in Data.events.keys():
		var problems := EventCheck.problems(Data.events[event_id])
		for problem in problems:
			fail("event %s: %s" % [event_id, problem])
		for pick in 3:
			Game.new_game()
			var runner := EventRunner.new()
			for i in 20:
				runner.choices.append(pick)
			await runner.run_event(event_id)
