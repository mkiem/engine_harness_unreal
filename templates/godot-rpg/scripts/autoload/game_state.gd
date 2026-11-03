extends Node
## Everything that changes while playing: the party (and who waits in reserve), equipment, the inventory, gold, story
## flags, quests and where the player is. Saved to and loaded from user://save_<slot>.json (three slots).

const SLOTS := 3
const SAVE_VERSION := 2
const EQUIP_SLOTS := ["weapon", "armor", "accessory"]

var party: Array = []          # active members: [{id, level, xp, hp, mp, equipment: {slot: item id}, status: [ids]}]
var reserve: Array = []        # members who joined but are not in the active party
var away: Dictionary = {}      # id -> member who left, kept so they come back as they were
var inventory: Dictionary = {} # item id -> count (equipped items are not counted here)
var gold := 0
var flags: Dictionary = {}
var quests: Dictionary = {}    # quest id -> stage id ("done" when finished)
var npc_moved: Dictionary = {} # "map/npc" -> [x, y] after a cutscene moved them
var map_id := ""
var position := Vector2i.ZERO
var facing := Vector2i.DOWN
var pending_battle: Array = [] # enemy ids for the next battle
## A story battle in progress: {"flag", "after", "then", "ending", "no_run", "can_lose", "lose_then"}; empty otherwise.
var pending_event: Dictionary = {}
var battle_background := ""    # the current map's battle background (colour or image)
var steps_since_battle := 0
var play_time := 0.0
var slot := 1

func _process(delta: float) -> void:
	if not party.is_empty():
		play_time += delta

func rule(name: String, fallback = null):
	return Data.rules.get(name, fallback)

func new_game() -> void:
	var start: Dictionary = Data.party
	party = []
	reserve = []
	away = {}
	for id in start.get("members", []):
		_place(make_member(id, int(start.get("level", 1))))
	inventory = start.get("items", {}).duplicate()
	gold = int(start.get("gold", 0))
	flags = {}
	quests = {}
	npc_moved = {}
	pending_event = {}
	pending_battle = []
	map_id = start.get("map", "town")
	var pos: Array = start.get("position", [2, 2])
	position = Vector2i(int(pos[0]), int(pos[1]))
	facing = Vector2i.DOWN
	steps_since_battle = 0
	play_time = 0.0

func make_member(id: String, level: int) -> Dictionary:
	var info: Dictionary = Data.characters.get(id, {})
	var member := {"id": id, "level": level, "xp": 0, "equipment": {}, "status": []}
	for slot_name in EQUIP_SLOTS:
		var item_id := str(info.get("equipment", {}).get(slot_name, ""))
		if item_id != "":
			member["equipment"][slot_name] = item_id
	member["hp"] = stat(member, "hp")
	member["mp"] = stat(member, "mp")
	return member

func member_name(member: Dictionary) -> String:
	return str(Data.characters.get(member["id"], {}).get("name", member["id"]))

## A member's stat: base + growth * (level - 1), plus what their equipment adds.
func stat(member: Dictionary, name: String) -> int:
	return base_stat(member, name, int(member["level"])) + gear_bonus(member, name)

func base_stat(member: Dictionary, name: String, level: int) -> int:
	var info: Dictionary = Data.characters.get(member["id"], {})
	var base := float(info.get("base", {}).get(name, 0))
	var growth := float(info.get("growth", {}).get(name, 0))
	return int(round(base + growth * (level - 1)))

func gear_bonus(member: Dictionary, name: String) -> int:
	var total := 0
	for item_id in member.get("equipment", {}).values():
		total += int(Data.items.get(item_id, {}).get("stats", {}).get(name, 0))
	return total

## What a member's equipment gives besides stats: the weapon's element, resisted elements, statuses they are immune
## to, and extra critical-hit chance.
func gear_traits(member: Dictionary) -> Dictionary:
	var traits := {"element": "", "resist": [], "immune": [], "crit": 0.0}
	for item_id in member.get("equipment", {}).values():
		var item: Dictionary = Data.items.get(item_id, {})
		if item.get("slot", "") == "weapon" and str(item.get("element", "")) != "":
			traits["element"] = str(item["element"])
		traits["resist"] += item.get("resist", [])
		traits["immune"] += item.get("immune", [])
		traits["crit"] += float(item.get("crit", 0.0))
	return traits

func can_equip(member: Dictionary, item_id: String) -> bool:
	var item: Dictionary = Data.items.get(item_id, {})
	if not EQUIP_SLOTS.has(item.get("slot", "")):
		return false
	var users: Array = item.get("users", [])
	return users.is_empty() or users.has(member["id"])

## Puts an item from the inventory on a member (the old one goes back to the inventory). "" takes the slot off.
func equip(member: Dictionary, slot_name: String, item_id: String) -> bool:
	if item_id != "" and (not can_equip(member, item_id) or Data.items[item_id].get("slot") != slot_name or int(inventory.get(item_id, 0)) <= 0):
		return false
	var old := str(member["equipment"].get(slot_name, ""))
	if old != "":
		add_item(old)
		member["equipment"].erase(slot_name)
	if item_id != "":
		add_item(item_id, -1)
		member["equipment"][slot_name] = item_id
	member["hp"] = mini(int(member["hp"]), stat(member, "hp"))
	member["mp"] = mini(int(member["mp"]), stat(member, "mp"))
	return true

## The best item for each empty or weaker slot, judged by the stats it adds; for "Optimize" and new members.
func best_equipment(member: Dictionary) -> void:
	for slot_name in EQUIP_SLOTS:
		var best := str(member["equipment"].get(slot_name, ""))
		var best_score := _gear_score(best)
		for item_id in inventory.keys():
			if Data.items.get(item_id, {}).get("slot") == slot_name and can_equip(member, item_id) and _gear_score(item_id) > best_score:
				best = item_id
				best_score = _gear_score(item_id)
		if best != str(member["equipment"].get(slot_name, "")):
			equip(member, slot_name, best)

func _gear_score(item_id: String) -> float:
	if item_id == "":
		return -1.0
	var total := 0.0
	for value in Data.items.get(item_id, {}).get("stats", {}).values():
		total += float(value)
	return total

func xp_for_level(level: int) -> int:
	return int(Data.formula("xp_to_next", {"level": level}))

## Adds XP to everyone standing (reserve members get rules.reserve_xp of it); answers who levelled up:
## [{name, level, gains: {stat: amount}, learned: [skill names]}].
func gain_xp(amount: int) -> Array:
	var raised: Array = []
	for member in party:
		if int(member["hp"]) > 0:
			raised += _add_xp(member, amount)
	for member in reserve:
		_add_xp(member, int(amount * float(rule("reserve_xp", 0.5))))
	return raised

func _add_xp(member: Dictionary, amount: int) -> Array:
	var raised: Array = []
	member["xp"] = int(member["xp"]) + amount
	while int(member["xp"]) >= xp_for_level(int(member["level"])):
		member["xp"] = int(member["xp"]) - xp_for_level(int(member["level"]))
		var before_skills := skills_for(member)
		var gains := {}
		for name in ["hp", "mp", "atk", "def", "mag", "spd"]:
			gains[name] = base_stat(member, name, int(member["level"]) + 1) - base_stat(member, name, int(member["level"]))
		member["level"] = int(member["level"]) + 1
		member["hp"] = stat(member, "hp")
		member["mp"] = stat(member, "mp")
		var learned: Array = []
		for skill_id in skills_for(member):
			if not before_skills.has(skill_id):
				learned.append(Data.skills.get(skill_id, {}).get("name", skill_id))
		raised.append({"name": member_name(member), "level": int(member["level"]), "gains": gains, "learned": learned})
	return raised

func skills_for(member: Dictionary) -> Array:
	var info: Dictionary = Data.characters.get(member["id"], {})
	var known: Array = info.get("skills", []).duplicate()
	var by_level: Dictionary = info.get("learns", {})
	for level in by_level.keys():
		if int(member["level"]) >= int(level) and not known.has(by_level[level]):
			known.append(by_level[level])
	return known

func add_item(id: String, count := 1) -> void:
	inventory[id] = int(inventory.get(id, 0)) + count
	if int(inventory[id]) <= 0:
		inventory.erase(id)

## How many the party owns, including what is equipped.
func item_count(id: String) -> int:
	var total := int(inventory.get(id, 0))
	for member in party + reserve:
		for item_id in member.get("equipment", {}).values():
			if item_id == id:
				total += 1
	return total

# ---- party --------------------------------------------------------------------------------------------------------

## A new member joins (or one who left comes back as they were): into the active party if there is room, else the
## reserve. Their level is at least `level`; with level 0, the party's average.
func join(id: String, level := 0) -> Dictionary:
	for member in party + reserve:
		if member["id"] == id:
			return member
	var member: Dictionary = away.get(id, {})
	away.erase(id)
	if member.is_empty():
		member = make_member(id, maxi(1, level if level > 0 else average_level()))
	elif level > int(member["level"]):
		member["level"] = level
		member["hp"] = stat(member, "hp")
		member["mp"] = stat(member, "mp")
	_place(member)
	return member

func _place(member: Dictionary) -> void:
	if party.size() < int(rule("max_party", 4)):
		party.append(member)
	else:
		reserve.append(member)

## A member leaves the party (their equipment goes with them and comes back when they do).
func leave(id: String) -> void:
	for list in [party, reserve]:
		for member in list:
			if member["id"] == id:
				list.erase(member)
				away[id] = member
				if party.is_empty() and not reserve.is_empty():
					party.append(reserve.pop_front())
				return

## Swaps an active member with one in reserve (the party is never left empty).
func swap(active_index: int, reserve_index: int) -> void:
	if active_index < 0 or reserve_index < 0 or reserve_index >= reserve.size():
		return
	var incoming: Dictionary = reserve[reserve_index]
	if active_index >= party.size():
		if party.size() < int(rule("max_party", 4)):
			reserve.remove_at(reserve_index)
			party.append(incoming)
		return
	reserve[reserve_index] = party[active_index]
	party[active_index] = incoming

func has_member(id: String) -> bool:
	for member in party + reserve:
		if member["id"] == id:
			return true
	return false

func average_level() -> int:
	if party.is_empty():
		return int(Data.party.get("level", 1))
	var total := 0
	for member in party:
		total += int(member["level"])
	return int(round(float(total) / party.size()))

func all_down() -> bool:
	for member in party:
		if int(member["hp"]) > 0:
			return false
	return true

# ---- outside battle: items and skills ---------------------------------------------------------------------------

## Uses an item on a member outside battle; answers what happened, or "" when it would do nothing.
func use_item(item_id: String, member: Dictionary) -> String:
	var item: Dictionary = Data.items.get(item_id, {})
	if int(inventory.get(item_id, 0)) <= 0:
		return ""
	var text := apply_restore(item, member, float(item.get("amount", 0)))
	if text != "":
		add_item(item_id, -1)
	return text

## Casts a healing, reviving or curing skill outside battle.
func use_skill(caster: Dictionary, skill_id: String, member: Dictionary) -> String:
	var skill: Dictionary = Data.skills.get(skill_id, {})
	if int(caster["mp"]) < int(skill.get("mp", 0)) or not field_usable(skill):
		return ""
	var amount := 0.0
	if skill.get("type") == "heal" or bool(skill.get("revive", false)):
		amount = Data.formula("heal", {"mag": stat(caster, "mag"), "level": int(caster["level"]), "power": float(skill.get("power", 1.0)),
			"atk": stat(caster, "atk"), "def": 0, "variance": 1.0})
	var text := apply_restore(skill, member, amount)
	if text != "":
		caster["mp"] = int(caster["mp"]) - int(skill.get("mp", 0))
	return text

## Whether a skill or item does something useful outside battle (heal, MP, revive, cure).
func field_usable(entry: Dictionary) -> bool:
	return entry.get("type") == "heal" or ["heal", "mp", "revive", "cure"].has(entry.get("effect", "")) or bool(entry.get("revive", false)) or not entry.get("cures", []).is_empty()

## Shared by items and skills outside battle: revive, heal HP (amount), restore MP, cure statuses.
func apply_restore(entry: Dictionary, member: Dictionary, amount: float) -> String:
	var name := member_name(member)
	var down := int(member["hp"]) <= 0
	var revive: bool = bool(entry.get("revive", false)) or entry.get("effect", "") == "revive"
	var parts: Array = []
	if down and not revive:
		return ""
	if revive and down:
		var hp := maxi(1, int(stat(member, "hp") * float(entry.get("revive_percent", 0.25))))
		member["hp"] = maxi(hp, int(amount)) if entry.get("type") == "heal" else hp
		parts.append("%s is back on their feet" % name)
	elif entry.get("effect", "") == "mp":
		var before := int(member["mp"])
		member["mp"] = mini(stat(member, "mp"), before + int(amount))
		if int(member["mp"]) > before:
			parts.append("%s +%d MP" % [name, int(member["mp"]) - before])
	elif entry.get("type") == "heal" or entry.get("effect", "") == "heal":
		var before := int(member["hp"])
		member["hp"] = mini(stat(member, "hp"), before + int(amount))
		if int(member["hp"]) > before:
			parts.append("%s +%d HP" % [name, int(member["hp"]) - before])
	var cured: Array = []
	for status_id in entry.get("cures", []):
		if member.get("status", []).has(status_id):
			member["status"].erase(status_id)
			cured.append(Data.statuses.get(status_id, {}).get("name", status_id))
	if not cured.is_empty():
		parts.append("%s cured of %s" % [name, ", ".join(cured)])
	return ". ".join(parts) + ("." if not parts.is_empty() else "")

# ---- story --------------------------------------------------------------------------------------------------------

## Story flags: has("met_elder"), set_flag("met_elder"). Flags are saved with the game.
func has(flag: String) -> bool:
	return flag != "" and bool(flags.get(flag, false))

func set_flag(flag: String, value := true) -> void:
	if flag != "":
		if value:
			flags[flag] = true
		else:
			flags.erase(flag)

func quest_stage(id: String) -> String:
	return str(quests.get(id, ""))

func set_quest(id: String, stage: String) -> void:
	quests[id] = stage

## Revives, heals and cures everyone (the inn; after losing a battle).
func heal_all() -> void:
	for member in party + reserve:
		member["hp"] = stat(member, "hp")
		member["mp"] = stat(member, "mp")
		member["status"] = []

# ---- saving ---------------------------------------------------------------------------------------------------------

func save_path(number: int) -> String:
	return "user://save_%d.json" % number

func save_game(number := -1) -> bool:
	if number < 1:
		number = slot
	var file := FileAccess.open(save_path(number), FileAccess.WRITE)
	if file == null:
		return false
	slot = number
	file.store_string(JSON.stringify({
		"version": SAVE_VERSION, "party": party, "reserve": reserve, "away": away, "inventory": inventory, "gold": gold,
		"flags": flags, "quests": quests, "npc_moved": npc_moved, "map": map_id, "position": [position.x, position.y],
		"facing": [facing.x, facing.y], "play_time": play_time,
		"summary": "%s Lv %d · %s · %s" % [member_name(party[0]) if not party.is_empty() else "?", int(party[0]["level"]) if not party.is_empty() else 0,
			Data.maps.get(map_id, {}).get("name", map_id), time_text(play_time)],
	}, "\t"))
	return true

func time_text(seconds: float) -> String:
	var minutes := int(seconds / 60)
	return "%d:%02d" % [minutes / 60, minutes % 60]

## Whether a slot has a save (number 0: any slot).
func has_save(number := 0) -> bool:
	if number == 0:
		for i in range(1, SLOTS + 1):
			if has_save(i):
				return true
		return false
	return FileAccess.file_exists(save_path(number)) or (number == 1 and FileAccess.file_exists("user://save.json"))

func slot_summary(number: int) -> String:
	if not has_save(number):
		return "Empty"
	var data = _read_save(number)
	return str(data.get("summary", "Saved game")) if typeof(data) == TYPE_DICTIONARY else "Unreadable"

func _read_save(number: int):
	var path := save_path(number)
	if not FileAccess.file_exists(path):
		path = "user://save.json"   # saves from before slots
	return JSON.parse_string(FileAccess.get_file_as_string(path))

func load_game(number := 1) -> bool:
	if not has_save(number):
		return false
	var data = _read_save(number)
	if typeof(data) != TYPE_DICTIONARY:
		return false
	slot = number
	party = data.get("party", [])
	reserve = data.get("reserve", [])
	away = data.get("away", {})
	for member in party + reserve + away.values():
		if not member.has("equipment") or typeof(member["equipment"]) != TYPE_DICTIONARY:
			member["equipment"] = {}
		if not member.has("status"):
			member["status"] = []
		for key in ["level", "xp", "hp", "mp"]:
			member[key] = int(member.get(key, 0))
	inventory = {}
	for id in data.get("inventory", {}):
		inventory[id] = int(data["inventory"][id])
	gold = int(data.get("gold", 0))
	flags = data.get("flags", {})
	quests = data.get("quests", {})
	npc_moved = data.get("npc_moved", {})
	map_id = data.get("map", "town")
	var pos: Array = data.get("position", [2, 2])
	position = Vector2i(int(pos[0]), int(pos[1]))
	var face: Array = data.get("facing", [0, 1])
	facing = Vector2i(int(face[0]), int(face[1]))
	play_time = float(data.get("play_time", 0.0))
	pending_event = {}
	pending_battle = []
	return true
