extends Node
## Everything that changes while playing: the party, the inventory, gold, story flags and where the player is.
## Saved to and loaded from user://save.json.

const SAVE_PATH := "user://save.json"

var party: Array = []          # [{id, level, xp, hp, mp}]
var inventory: Dictionary = {} # item id -> count
var gold := 0
var flags: Dictionary = {}
var map_id := ""
var position := Vector2i.ZERO
var facing := Vector2i.DOWN
var pending_battle: Array = [] # enemy ids for the next battle
## A story battle in progress (a boss): {"flag", "after", "ending", "no_run"}; empty for random encounters.
var pending_event: Dictionary = {}
var steps_since_battle := 0

func new_game() -> void:
	var start: Dictionary = Data.party
	party = []
	for id in start.get("members", []):
		party.append(make_member(id, int(start.get("level", 1))))
	inventory = start.get("items", {}).duplicate()
	gold = int(start.get("gold", 0))
	flags = {}
	pending_event = {}
	map_id = start.get("map", "town")
	var pos: Array = start.get("position", [2, 2])
	position = Vector2i(int(pos[0]), int(pos[1]))
	facing = Vector2i.DOWN
	steps_since_battle = 0

func make_member(id: String, level: int) -> Dictionary:
	var member := {"id": id, "level": level, "xp": 0}
	member["hp"] = stat(member, "hp")
	member["mp"] = stat(member, "mp")
	return member

## A member's stat at their level: base + growth * (level - 1).
func stat(member: Dictionary, name: String) -> int:
	var info: Dictionary = Data.characters.get(member["id"], {})
	var base := float(info.get("base", {}).get(name, 0))
	var growth := float(info.get("growth", {}).get(name, 0))
	return int(round(base + growth * (int(member["level"]) - 1)))

func xp_for_level(level: int) -> int:
	return int(Data.formula("xp_to_next", {"level": level}))

## Adds XP and levels up; answers the names of members who levelled up.
func gain_xp(amount: int) -> Array:
	var raised: Array = []
	for member in party:
		if int(member["hp"]) <= 0:
			continue
		member["xp"] = int(member["xp"]) + amount
		while int(member["xp"]) >= xp_for_level(int(member["level"])):
			member["xp"] = int(member["xp"]) - xp_for_level(int(member["level"]))
			member["level"] = int(member["level"]) + 1
			member["hp"] = stat(member, "hp")
			member["mp"] = stat(member, "mp")
			raised.append(Data.characters.get(member["id"], {}).get("name", member["id"]))
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

## Story flags: has("met_elder"), set_flag("met_elder"). Flags are saved with the game.
func has(flag: String) -> bool:
	return flag != "" and bool(flags.get(flag, false))

func set_flag(flag: String, value := true) -> void:
	if flag != "":
		flags[flag] = value

func heal_all() -> void:
	for member in party:
		member["hp"] = stat(member, "hp")
		member["mp"] = stat(member, "mp")

func save_game() -> bool:
	var file := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(JSON.stringify({
		"party": party, "inventory": inventory, "gold": gold, "flags": flags,
		"map": map_id, "position": [position.x, position.y], "facing": [facing.x, facing.y],
	}, "\t"))
	return true

func has_save() -> bool:
	return FileAccess.file_exists(SAVE_PATH)

func load_game() -> bool:
	if not has_save():
		return false
	var data = JSON.parse_string(FileAccess.get_file_as_string(SAVE_PATH))
	if typeof(data) != TYPE_DICTIONARY:
		return false
	party = data.get("party", [])
	inventory = data.get("inventory", {})
	gold = int(data.get("gold", 0))
	flags = data.get("flags", {})
	map_id = data.get("map", "town")
	var pos: Array = data.get("position", [2, 2])
	position = Vector2i(int(pos[0]), int(pos[1]))
	var face: Array = data.get("facing", [0, 1])
	facing = Vector2i(int(face[0]), int(face[1]))
	return true
