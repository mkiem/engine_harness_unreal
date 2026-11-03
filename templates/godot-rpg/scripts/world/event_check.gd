class_name EventCheck
extends RefCounted
## Checks a list of event commands against the data: every command known, and every item, enemy, character, quest,
## map, dialogue and event it names exists; lines short enough for the text box. Used by the self-test.

const MAX_LINE := 90

static func problems(commands, where := "") -> Array:
	var out: Array = []
	if typeof(commands) != TYPE_ARRAY:
		return ["%sis not a list of commands" % where]
	for i in commands.size():
		var c = commands[i]
		var at := "%scommand %d" % [where, i + 1]
		if typeof(c) != TYPE_DICTIONARY:
			out.append("%s is not an object" % at)
			continue
		var name := EventRunner.command_name(c)
		if name == "":
			out.append("%s (%s) is not a known command; commands are %s" % [at, ", ".join(c.keys()), ", ".join(EventRunner.COMMANDS)])
			continue
		at += " (%s)" % name
		match name:
			"say":
				var lines: Array = c["say"] if typeof(c["say"]) == TYPE_ARRAY else [c["say"]]
				for line in lines:
					if str(line).length() + str(c.get("who", "")).length() > MAX_LINE:
						out.append("%s has a line longer than %d characters, which will not fit the text box: \"%s\"" % [at, MAX_LINE, str(line).left(40)])
			"choice":
				var options: Array = c.get("options", [])
				if options.is_empty():
					out.append("%s has no options" % at)
				for j in options.size():
					out += problems(options[j].get("then", []), "%s option %d, " % [at, j + 1])
			"if":
				out += _conditions(c["if"], at)
				out += problems(c.get("then", []), "%s then, " % at)
				out += problems(c.get("else", []), "%s else, " % at)
			"give", "take":
				if not Data.items.has(str(c[name])):
					out.append("%s names item %s, which is not in items.json" % [at, c[name]])
			"join", "leave":
				if not Data.characters.has(str(c[name])):
					out.append("%s names %s, who is not in characters.json" % [at, c[name]])
			"quest":
				var quest: Dictionary = Data.quests.get(str(c["quest"]), {})
				if quest.is_empty():
					out.append("%s names quest %s, which is not in quests.json" % [at, c["quest"]])
				elif not quest.get("stages", {}).has(str(c.get("stage", "start"))):
					out.append("%s sets quest %s to stage %s, which it does not have" % [at, c["quest"], c.get("stage", "start")])
			"battle":
				if typeof(c["battle"]) != TYPE_ARRAY or c["battle"].is_empty():
					out.append("%s lists no enemies" % at)
				else:
					for enemy in c["battle"]:
						if not Data.enemies.has(str(enemy)):
							out.append("%s fights %s, which is not in enemies.json" % [at, enemy])
				out += problems(c.get("then", []), "%s then, " % at)
				out += problems(c.get("lose", []), "%s lose, " % at)
				if bool(c.get("ending", false)) and not Data.dialogue.has("ending"):
					out.append("%s ends the game, but dialogue.json has no \"ending\" lines" % at)
			"shop":
				for item in c["shop"]:
					if not Data.items.has(str(item)):
						out.append("%s sells %s, which is not in items.json" % [at, item])
			"warp":
				if not Data.maps.has(str(c["warp"])):
					out.append("%s warps to map %s, which is not in maps.json" % [at, c["warp"]])
			"event":
				if not Data.events.has(str(c["event"])):
					out.append("%s runs event %s, which is not in events.json" % [at, c["event"]])
	return out

static func _conditions(conditions, at: String) -> Array:
	var out: Array = []
	if typeof(conditions) != TYPE_DICTIONARY:
		return ["%s: the condition is not an object" % at]
	for key in conditions.keys():
		if not key in ["flag", "not_flag", "item", "count", "gold", "member", "quest", "stage", "not_stage"]:
			out.append("%s has an unknown condition %s" % [at, key])
	if conditions.has("item") and not Data.items.has(str(conditions["item"])):
		out.append("%s checks for item %s, which is not in items.json" % [at, conditions["item"]])
	if conditions.has("member") and not Data.characters.has(str(conditions["member"])):
		out.append("%s checks for %s, who is not in characters.json" % [at, conditions["member"]])
	if conditions.has("quest") and not Data.quests.has(str(conditions["quest"])):
		out.append("%s checks quest %s, which is not in quests.json" % [at, conditions["quest"]])
	return out
