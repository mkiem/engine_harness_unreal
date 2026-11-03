extends Node
## Plays a story event without the screen, as the game would, and prints what happened as one JSON line starting with
## EVENT_RESULT: every line said, each choice taken, and how flags, items, gold, quests and the party changed. A
## battle, warp or ending stops it, as in the game. Run headless:
##   godot --headless --path . res://tools/event_test.tscn -- --event elder --choices 0,1 --flags met_elder
##     --items kid_charm:1 --quests wolf=start --members ranger --gold 100

var said: Array = []
var asked: Array = []
var stopped_by := {}
var choices: Array = []

func _ready() -> void:
	var args := _args()
	Game.new_game()
	for flag in str(args.get("flags", "")).split(",", false):
		Game.set_flag(flag)
	for entry in str(args.get("items", "")).split(",", false):
		var parts := entry.split(":")
		Game.add_item(parts[0], int(parts[1]) if parts.size() > 1 else 1)
	for entry in str(args.get("quests", "")).split(",", false):
		var parts := entry.split("=")
		Game.set_quest(parts[0], parts[1] if parts.size() > 1 else "start")
	for id in str(args.get("members", "")).split(",", false):
		Game.join(id)
	if args.has("gold"):
		Game.gold = int(args["gold"])
	if args.has("map"):
		Game.map_id = str(args["map"])
	for choice in str(args.get("choices", "")).split(",", false):
		choices.append(int(choice))
	var before := _state()
	var id := str(args.get("event", ""))
	if not Data.events.has(id):
		print("EVENT_RESULT " + JSON.stringify({"error": "no event %s in data/events.json; events: %s" % [id, ", ".join(Data.events.keys())]}))
		get_tree().quit(1)
		return
	var runner := EventRunner.new(self)
	await runner.run_event(id)
	var after := _state()
	print("EVENT_RESULT " + JSON.stringify({"event": id, "said": said, "choices": asked, "stopped_by": stopped_by,
		"changes": _diff(before, after), "problems": EventCheck.problems(Data.events[id])}))
	get_tree().quit(0)

func _state() -> Dictionary:
	return {"flags": Game.flags.duplicate(), "items": Game.inventory.duplicate(), "gold": Game.gold, "quests": Game.quests.duplicate(),
		"party": Game.party.map(func(m): return m["id"]), "reserve": Game.reserve.map(func(m): return m["id"])}

func _diff(before: Dictionary, after: Dictionary) -> Dictionary:
	var out := {}
	var flags_set: Array = after["flags"].keys().filter(func(k): return not before["flags"].has(k))
	var flags_cleared: Array = before["flags"].keys().filter(func(k): return not after["flags"].has(k))
	if not flags_set.is_empty():
		out["flags_set"] = flags_set
	if not flags_cleared.is_empty():
		out["flags_cleared"] = flags_cleared
	var items := {}
	for id in after["items"].keys() + before["items"].keys():
		var delta := int(after["items"].get(id, 0)) - int(before["items"].get(id, 0))
		if delta != 0:
			items[id] = delta
	if not items.is_empty():
		out["items"] = items
	if int(after["gold"]) != int(before["gold"]):
		out["gold"] = int(after["gold"]) - int(before["gold"])
	for id in after["quests"].keys():
		if before["quests"].get(id, "") != after["quests"][id]:
			out["quest_" + str(id)] = after["quests"][id]
	if after["party"] != before["party"] or after["reserve"] != before["reserve"]:
		out["party"] = after["party"]
		out["reserve"] = after["reserve"]
	return out

# The host EventRunner talks to: records instead of showing.
func say(lines: Array, who: String) -> void:
	for line in lines:
		said.append("%s: %s" % [who, line] if who != "" else str(line))

func choose(question: String, options: Array) -> int:
	var index := int(choices.pop_front()) if not choices.is_empty() else 0
	asked.append({"question": question, "options": options, "picked": index})
	return index

func refresh() -> void:
	pass

func wait(_seconds: float) -> void:
	pass

func face(_who: String, _direction: String) -> void:
	pass

func move(who: String, path: Array) -> void:
	said.append("(%s moves %s)" % [who, " ".join(path)])

func shop(stock: Array) -> void:
	said.append("(shop: %s)" % ", ".join(stock))

func inn(price: int) -> void:
	said.append("(inn for %d gold)" % price)
	Game.heal_all()

func battle(command: Dictionary) -> void:
	stopped_by = {"battle": command.get("battle", []), "flag": command.get("flag", ""), "ending": command.get("ending", false)}

func warp(map_id: String, x: int, y: int) -> void:
	said.append("(warp to %s %d,%d)" % [map_id, x, y])

func ending() -> void:
	stopped_by = {"ending": true}

func _args() -> Dictionary:
	var out := {}
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		if args[i].begins_with("--") and i + 1 < args.size() and not args[i + 1].begins_with("--"):
			out[args[i].substr(2)] = args[i + 1]
			i += 2
		else:
			i += 1
	return out
