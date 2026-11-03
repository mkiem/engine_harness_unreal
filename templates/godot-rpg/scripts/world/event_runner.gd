class_name EventRunner
extends RefCounted
## Runs story events: lists of commands from data/events.json (or inline in maps.json), one after another. Commands
## that change the game (flags, items, gold, the party, quests) act on Game directly; the rest (talking, choices,
## moving people, battles, warps, shops) are asked of the host, normally the overworld. With no host (tests, or after
## a battle that ends the game) only the changes to the game are made.
##
## Each command is a dictionary whose main key names it:
##   {"say": [lines], "who": "Name"}            {"choice": "Question?", "options": [{"text", "then": [...]}, ...]}
##   {"if": {conditions}, "then": [...], "else": [...]}   conditions: flag, not_flag, item (+count), gold, member,
##                                                          quest (+stage, or "not_stage"), all must hold
##   {"set": "flag"} {"unset": "flag"} {"give": "item", "count": 1} {"take": "item", "count": 1} {"gold": 50}
##   {"join": "character", "level": 3} {"leave": "character"} {"heal": true} {"quest": "id", "stage": "start"}
##   {"move": "npc id" or "player", "path": ["up", "up", "left"]} {"face": "npc id" or "player", "dir": "left"}
##   {"hide": "npc id"} {"show": "npc id"} {"wait": 0.5} {"music": "res://audio/x.wav"} {"sound": "name"}
##   {"shop": ["item", ...]} {"inn": 10} {"battle": ["enemy", ...], "flag", "no_run", "ending", "background",
##   "can_lose", "then": [...], "lose": [...]} {"warp": "map", "x": 1, "y": 2} {"ending": true}
##   {"event": "other event id"} {"end": true}

const COMMANDS := ["say", "choice", "if", "set", "unset", "give", "take", "gold", "join", "leave", "heal", "quest", "move",
	"face", "hide", "show", "wait", "music", "sound", "shop", "inn", "battle", "warp", "ending", "event", "end"]

var host = null
var stopped := false
## Everything that happened, as text, for tests and the event tester.
var history: Array = []
## For tests: the option index to pick at each choice, in order (default: the first).
var choices: Array = []

func _init(event_host = null) -> void:
	host = event_host

static func command_name(command: Dictionary) -> String:
	for name in COMMANDS:
		if command.has(name):
			return name
	return ""

## Runs an event by id from data/events.json.
func run_event(id: String) -> void:
	if not Data.events.has(id):
		push_error("No event %s in data/events.json" % id)
		return
	await run(Data.events[id])

func run(commands: Array) -> void:
	for command in commands:
		if stopped:
			return
		if typeof(command) != TYPE_DICTIONARY:
			continue
		await _do(command)

func _do(c: Dictionary) -> void:
	var name := command_name(c)
	history.append(name)
	match name:
		"say":
			var lines: Array = c["say"] if typeof(c["say"]) == TYPE_ARRAY else [str(c["say"])]
			history.append_array(lines)
			if host:
				await host.say(lines, str(c.get("who", "")))
		"choice":
			var options: Array = c.get("options", [])
			var labels: Array = options.map(func(o): return str(o.get("text", "?")))
			var index := 0
			if not choices.is_empty():
				index = int(choices.pop_front())
			elif host:
				index = await host.choose(str(c["choice"]), labels)
			history.append("chose %d" % index)
			if index >= 0 and index < options.size():
				await run(options[index].get("then", []))
		"if":
			await run(c.get("then", []) if test(c["if"]) else c.get("else", []))
		"set":
			Game.set_flag(str(c["set"]))
		"unset":
			Game.set_flag(str(c["unset"]), false)
		"give":
			var count := int(c.get("count", 1))
			Game.add_item(str(c["give"]), count)
			await _notice("Received %s%s." % [Data.items.get(c["give"], {}).get("name", c["give"]), " x%d" % count if count > 1 else ""], "item")
		"take":
			Game.add_item(str(c["take"]), -int(c.get("count", 1)))
		"gold":
			Game.gold = maxi(0, Game.gold + int(c["gold"]))
			if int(c["gold"]) > 0:
				await _notice("Received %d gold." % int(c["gold"]), "coin")
		"join":
			Game.join(str(c["join"]), int(c.get("level", 0)))
			if host:
				host.refresh()
		"leave":
			Game.leave(str(c["leave"]))
			if host:
				host.refresh()
		"heal":
			Game.heal_all()
		"quest":
			Game.set_quest(str(c["quest"]), str(c.get("stage", "start")))
			var quest: Dictionary = Data.quests.get(c["quest"], {})
			var stage := str(c.get("stage", "start"))
			if stage == "start":
				await _notice("New quest: %s" % quest.get("name", c["quest"]), "item")
			elif stage == "done":
				await _notice("Quest complete: %s" % quest.get("name", c["quest"]), "levelup")
		"hide":
			Game.set_flag(hidden_flag(str(c["hide"])))
			if host:
				host.refresh()
		"show":
			Game.set_flag(hidden_flag(str(c["show"])), false)
			if host:
				host.refresh()
		"move":
			if host:
				await host.move(str(c["move"]), c.get("path", []))
		"face":
			if host:
				host.face(str(c["face"]), str(c.get("dir", "down")))
		"wait":
			if host:
				await host.wait(float(c["wait"]))
		"music":
			if host:
				Sound.music(str(c["music"]))
		"sound":
			if host:
				Sound.play(str(c["sound"]))
		"shop":
			if host:
				await host.shop(c["shop"])
		"inn":
			if host:
				await host.inn(int(c["inn"]))
			else:
				Game.heal_all()
		"battle":
			stopped = true
			if host:
				host.battle(c)
		"warp":
			if host:
				host.warp(str(c["warp"]), int(c.get("x", 1)), int(c.get("y", 1)))
		"ending":
			stopped = true
			if host:
				host.ending()
		"event":
			await run_event(str(c["event"]))
		"end":
			stopped = true

func _notice(text: String, sound: String) -> void:
	history.append(text)
	if host:
		Sound.play(sound)
		await host.say([text], "")

## The flag that hides an NPC on the current map ({"hide": id}).
static func hidden_flag(npc_id: String) -> String:
	return "hidden_%s_%s" % [Game.map_id, npc_id]

## Whether every condition holds.
static func test(conditions: Dictionary) -> bool:
	if conditions.has("flag") and not Game.has(str(conditions["flag"])):
		return false
	if conditions.has("not_flag") and Game.has(str(conditions["not_flag"])):
		return false
	if conditions.has("item") and Game.item_count(str(conditions["item"])) < int(conditions.get("count", 1)):
		return false
	if conditions.has("gold") and Game.gold < int(conditions["gold"]):
		return false
	if conditions.has("member") and not Game.has_member(str(conditions["member"])):
		return false
	if conditions.has("quest"):
		var stage := Game.quest_stage(str(conditions["quest"]))
		if conditions.has("stage") and stage != str(conditions["stage"]):
			return false
		if conditions.has("not_stage") and stage == str(conditions["not_stage"]):
			return false
		if not conditions.has("stage") and not conditions.has("not_stage") and stage == "":
			return false
	return true
