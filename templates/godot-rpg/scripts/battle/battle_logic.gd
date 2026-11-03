class_name BattleLogic
extends RefCounted
## The rules of a turn-based battle, with no screens: the battle scene shows it, tools/sim_battle.gd runs it thousands
## of times to balance it. Every number comes from data/: stats, skills, items, and the formulas in formulas.json.

signal message(text: String)

var party: Array = []    # combatants: {name, side, ref, hp, max_hp, mp, max_mp, atk, def, mag, spd, skills, level, defending}
var enemies: Array = []
var rng := RandomNumberGenerator.new()
var turn := 0
var outcome := ""        # "", "won", "lost", "fled"

func setup(members: Array, enemy_ids: Array, seed := -1) -> void:
	if seed >= 0:
		rng.seed = seed
	else:
		rng.randomize()
	party = []
	for member in members:
		party.append(_from_member(member))
	enemies = []
	var counts := {}
	for id in enemy_ids:
		counts[id] = int(counts.get(id, 0)) + 1
	var seen := {}
	for id in enemy_ids:
		var info: Dictionary = Data.enemies.get(id, {})
		var name: String = info.get("name", id)
		if int(counts[id]) > 1:
			seen[id] = int(seen.get(id, 0)) + 1
			name += " " + "ABCDEFGH"[int(seen[id]) - 1]
		var stats: Dictionary = info.get("stats", {})
		enemies.append({
			"name": name, "side": "enemy", "id": id, "hp": int(stats.get("hp", 10)), "max_hp": int(stats.get("hp", 10)),
			"mp": int(stats.get("mp", 0)), "max_mp": int(stats.get("mp", 0)), "atk": int(stats.get("atk", 5)),
			"def": int(stats.get("def", 2)), "mag": int(stats.get("mag", 2)), "spd": int(stats.get("spd", 4)),
			"skills": info.get("skills", []), "level": int(info.get("level", 1)), "defending": false,
		})
	turn = 0
	outcome = ""

func _from_member(member: Dictionary) -> Dictionary:
	var info: Dictionary = Data.characters.get(member["id"], {})
	return {
		"name": info.get("name", member["id"]), "side": "party", "ref": member, "id": member["id"],
		"hp": int(member["hp"]), "max_hp": Game.stat(member, "hp"), "mp": int(member["mp"]), "max_mp": Game.stat(member, "mp"),
		"atk": Game.stat(member, "atk"), "def": Game.stat(member, "def"), "mag": Game.stat(member, "mag"), "spd": Game.stat(member, "spd"),
		"skills": Game.skills_for(member), "level": int(member["level"]), "defending": false,
	}

func alive(list: Array) -> Array:
	return list.filter(func(c): return int(c["hp"]) > 0)

## Everyone still standing, fastest first; ties go to the party.
func turn_order() -> Array:
	var everyone := alive(party) + alive(enemies)
	everyone.sort_custom(func(a, b):
		if int(a["spd"]) == int(b["spd"]):
			return a["side"] == "party" and b["side"] != "party"
		return int(a["spd"]) > int(b["spd"]))
	return everyone

## Carries out one action. kind: "attack", "skill", "item", "defend", "run". Answers what happened.
func act(actor: Dictionary, kind: String, target: Dictionary = {}, id := "") -> String:
	if outcome != "" or int(actor["hp"]) <= 0:
		return ""
	actor["defending"] = false
	var text := ""
	match kind:
		"attack":
			var damage := _damage("physical", actor, target, 1.0)
			text = "%s attacks %s for %d." % [actor["name"], target["name"], damage]
		"skill":
			var skill: Dictionary = Data.skills.get(id, {})
			var cost := int(skill.get("mp", 0))
			if int(actor["mp"]) < cost:
				return act(actor, "attack", target)
			actor["mp"] = int(actor["mp"]) - cost
			var power := float(skill.get("power", 1.0))
			if skill.get("type", "physical") == "heal":
				var amount := int(Data.formula("heal", _values(actor, target, power)))
				target["hp"] = min(int(target["max_hp"]), int(target["hp"]) + max(1, amount))
				text = "%s casts %s on %s: +%d HP." % [actor["name"], skill.get("name", id), target["name"], max(1, amount)]
			else:
				var damage := _damage(skill.get("type", "physical"), actor, target, power)
				text = "%s uses %s on %s for %d." % [actor["name"], skill.get("name", id), target["name"], damage]
		"item":
			var item: Dictionary = Data.items.get(id, {})
			Game.add_item(id, -1)
			if item.get("effect", "heal") == "heal":
				target["hp"] = min(int(target["max_hp"]), int(target["hp"]) + int(item.get("amount", 10)))
				text = "%s uses %s on %s: +%d HP." % [actor["name"], item.get("name", id), target["name"], int(item.get("amount", 10))]
			elif item.get("effect") == "mp":
				target["mp"] = min(int(target["max_mp"]), int(target["mp"]) + int(item.get("amount", 5)))
				text = "%s uses %s on %s: +%d MP." % [actor["name"], item.get("name", id), target["name"], int(item.get("amount", 5))]
		"defend":
			actor["defending"] = true
			text = "%s defends." % actor["name"]
		"run":
			var chance := Data.formula("run_chance", {"spd": int(actor["spd"])})
			if rng.randf() < chance:
				outcome = "fled"
				text = "The party got away!"
			else:
				text = "Couldn't escape!"
	if text != "":
		message.emit(text)
	_check_end()
	return text

func _values(actor: Dictionary, target: Dictionary, power: float) -> Dictionary:
	return {"atk": int(actor["atk"]), "mag": int(actor["mag"]), "def": int(target.get("def", 0)), "level": int(actor["level"]),
		"power": power, "variance": rng.randf_range(0.9, 1.1)}

func _damage(type: String, actor: Dictionary, target: Dictionary, power: float) -> int:
	var formula_name := "magic" if type == "magic" else "physical"
	var damage := int(round(Data.formula(formula_name, _values(actor, target, power))))
	if bool(target.get("defending", false)):
		damage = int(damage / 2)
	damage = max(1, damage)
	target["hp"] = max(0, int(target["hp"]) - damage)
	return damage

## The enemy's choice: a skill it can afford some of the time, otherwise an attack, on a random living party member.
func enemy_turn(enemy: Dictionary) -> String:
	var targets := alive(party)
	if targets.is_empty():
		return ""
	var target: Dictionary = targets[rng.randi() % targets.size()]
	var usable: Array = enemy["skills"].filter(func(s): return int(Data.skills.get(s, {}).get("mp", 0)) <= int(enemy["mp"]))
	if not usable.is_empty() and rng.randf() < 0.35:
		var skill_id: String = usable[rng.randi() % usable.size()]
		if Data.skills.get(skill_id, {}).get("type") == "heal":
			return act(enemy, "skill", enemy, skill_id)
		return act(enemy, "skill", target, skill_id)
	return act(enemy, "attack", target)

## A simple party choice for autoplay and simulation: heal a hurt ally if possible, else the strongest affordable attack.
func auto_turn(member: Dictionary) -> String:
	var foes := alive(enemies)
	if foes.is_empty():
		return ""
	var target: Dictionary = foes[0]
	for skill_id in member["skills"]:
		var skill: Dictionary = Data.skills.get(skill_id, {})
		if skill.get("type") == "heal" and int(member["mp"]) >= int(skill.get("mp", 0)):
			for ally in alive(party):
				if int(ally["hp"]) * 3 < int(ally["max_hp"]):
					return act(member, "skill", ally, skill_id)
	var best := ""
	var best_power := 1.0
	for skill_id in member["skills"]:
		var skill: Dictionary = Data.skills.get(skill_id, {})
		if skill.get("type") != "heal" and int(member["mp"]) >= int(skill.get("mp", 0)) and float(skill.get("power", 1)) > best_power:
			best = skill_id
			best_power = float(skill.get("power", 1))
	if best != "":
		return act(member, "skill", target, best)
	return act(member, "attack", target)

func _check_end() -> void:
	if outcome != "":
		return
	if alive(enemies).is_empty():
		outcome = "won"
	elif alive(party).is_empty():
		outcome = "lost"

## Writes HP and MP back to the party and answers the rewards for a win.
func finish() -> Dictionary:
	for c in party:
		c["ref"]["hp"] = max(0, int(c["hp"]))
		c["ref"]["mp"] = int(c["mp"])
	if outcome != "won":
		return {}
	var xp := 0
	var gold := 0
	var drops: Array = []
	for e in enemies:
		var info: Dictionary = Data.enemies.get(e["id"], {})
		xp += int(info.get("xp", 0))
		gold += int(info.get("gold", 0))
		var drop: Dictionary = info.get("drop", {})
		if drop.has("item") and rng.randf() < float(drop.get("chance", 0.0)):
			drops.append(drop["item"])
	return {"xp": xp, "gold": gold, "drops": drops}

## Runs a whole battle with auto_turn for the party; for the simulator and autoplay tests.
func run_auto(max_turns := 200) -> String:
	while outcome == "" and turn < max_turns:
		turn += 1
		for actor in turn_order():
			if outcome != "":
				break
			if int(actor["hp"]) <= 0:
				continue
			if actor["side"] == "party":
				auto_turn(actor)
			else:
				enemy_turn(actor)
	if outcome == "":
		outcome = "timeout"
	return outcome
