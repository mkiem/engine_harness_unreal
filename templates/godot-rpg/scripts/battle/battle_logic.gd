class_name BattleLogic
extends RefCounted
## The rules of a turn-based battle, with no screens: the battle scene shows it, tools/sim_battle.gd runs it thousands
## of times to balance it. Every number comes from data/: stats and equipment, skills, items, statuses, elements, enemy
## AI, and the formulas in formulas.json and constants in rules.json.
##
## A round: start_round() decides what every enemy will do (its intent, which the screen can show), then everyone
## standing acts in order of speed. Each turn: begin_turn() (poison, regen; sleeping, stunned or broken fighters lose
## the turn), an action (a fighter gathering power releases it), then end_turn() (statuses count down).
## From the Gameplay Atlas (loopyhop): enemy intent, charged attacks and interrupts, taunts, and break shields.

signal message(text: String)
## Something for the screen to show: {kind: "damage"|"heal"|"mp"|"miss"|"status"|"cure"|"revive"|"ko"|"phase",
## target: combatant, amount, crit, effect: "weak"|"resist"|"absorb"|"", status}
signal shown(info: Dictionary)

var party: Array = []
var enemies: Array = []
var rng := RandomNumberGenerator.new()
var turn := 0
var outcome := ""        # "", "won", "lost", "fled"
var _releasing := false

const SCOPES := ["enemy", "all_enemies", "ally", "all_allies", "self", "ko_ally"]

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
		var enemy := {
			"name": name, "side": "enemy", "id": id, "hp": int(stats.get("hp", 10)), "max_hp": int(stats.get("hp", 10)),
			"mp": int(stats.get("mp", 0)), "max_mp": int(stats.get("mp", 0)),
			"base": {"atk": float(stats.get("atk", 5)), "def": float(stats.get("def", 2)), "mag": float(stats.get("mag", 2)), "spd": float(stats.get("spd", 4))},
			"skills": info.get("skills", []), "level": int(info.get("level", 1)), "defending": false, "statuses": {},
			"element": str(info.get("element", "")), "weak": info.get("weak", []), "resist": info.get("resist", []),
			"absorb": info.get("absorb", []), "immune": info.get("immune", []), "crit": float(stats.get("crit", 0.0)),
			"evade": float(stats.get("evade", 0.0)), "on_hit": info.get("on_hit", {}), "ai": info.get("ai", []),
			"phases": info.get("phases", []), "phase": 0, "used": {}, "intent": {}, "charging": {}, "acted": -1,
			"shield": int(info.get("shield", 0)), "max_shield": int(info.get("shield", 0)), "uninterruptible": bool(info.get("uninterruptible", false)),
		}
		enemies.append(enemy)
		for status_id in info.get("statuses", []):
			inflict(enemy, status_id, 1.0, true)
	turn = 0
	outcome = ""

func _from_member(member: Dictionary) -> Dictionary:
	var traits := Game.gear_traits(member)
	var weapon: Dictionary = Data.items.get(member.get("equipment", {}).get("weapon", ""), {})
	var c := {
		"name": Game.member_name(member), "side": "party", "ref": member, "id": member["id"],
		"hp": int(member["hp"]), "max_hp": Game.stat(member, "hp"), "mp": int(member["mp"]), "max_mp": Game.stat(member, "mp"),
		"base": {"atk": float(Game.stat(member, "atk")), "def": float(Game.stat(member, "def")), "mag": float(Game.stat(member, "mag")), "spd": float(Game.stat(member, "spd"))},
		"skills": Game.skills_for(member), "level": int(member["level"]), "defending": false, "statuses": {},
		"element": traits["element"], "weak": Data.characters.get(member["id"], {}).get("weak", []), "resist": traits["resist"],
		"absorb": [], "immune": traits["immune"], "crit": float(traits["crit"]), "evade": 0.0, "on_hit": weapon.get("status", {}),
		"intent": {}, "charging": {}, "acted": -1, "shield": 0, "max_shield": 0, "uninterruptible": false,
	}
	for status_id in member.get("status", []):
		c["statuses"][status_id] = -1 if int(Data.statuses.get(status_id, {}).get("turns", 0)) <= 0 else int(Data.statuses[status_id]["turns"])
	return c

func alive(list: Array) -> Array:
	return list.filter(func(c): return int(c["hp"]) > 0)

func fallen(list: Array) -> Array:
	return list.filter(func(c): return int(c["hp"]) <= 0)

func allies_of(c: Dictionary) -> Array:
	return party if c["side"] == "party" else enemies

func foes_of(c: Dictionary) -> Array:
	return enemies if c["side"] == "party" else party

## A fighter's stat now: equipment included, times every status's multiplier (Attack Up, Defence Down...).
func stat(c: Dictionary, name: String) -> int:
	var value := float(c["base"].get(name, 0))
	for status_id in c["statuses"].keys():
		value *= float(Data.statuses.get(status_id, {}).get("stats", {}).get(name, 1.0))
	return int(round(value))

func has_status(c: Dictionary, status_id: String) -> bool:
	return c["statuses"].has(status_id)

func _status_flag(c: Dictionary, key: String) -> String:
	for status_id in c["statuses"].keys():
		if bool(Data.statuses.get(status_id, {}).get(key, false)):
			return status_id
	return ""

func can_use_skills(c: Dictionary) -> bool:
	return _status_flag(c, "no_skills") == ""

## Everyone still standing, fastest first; ties go to the party.
func turn_order() -> Array:
	var everyone := alive(party) + alive(enemies)
	everyone.sort_custom(func(a, b):
		if stat(a, "spd") == stat(b, "spd"):
			return a["side"] == "party" and b["side"] != "party"
		return stat(a, "spd") > stat(b, "spd"))
	return everyone

# ---- turns ----------------------------------------------------------------------------------------------------------

## Start of a fighter's turn: damage and healing over time, then whether they can act (asleep or stunned: no).
func begin_turn(c: Dictionary) -> bool:
	if outcome != "" or int(c["hp"]) <= 0:
		return false
	c["defending"] = false
	for status_id in c["statuses"].keys():
		var info: Dictionary = Data.statuses.get(status_id, {})
		if float(info.get("damage_percent", 0)) > 0:
			var amount := maxi(1, int(c["max_hp"] * float(info["damage_percent"])))
			_say("%s takes %d damage from %s." % [c["name"], amount, info.get("name", status_id)])
			_hurt(c, amount, {"kind": "damage", "status": status_id})
			if int(c["hp"]) <= 0:
				_check_end()
				return false
		if float(info.get("heal_percent", 0)) > 0 and int(c["hp"]) < int(c["max_hp"]):
			var healed := _restore_hp(c, maxi(1, int(c["max_hp"] * float(info["heal_percent"]))))
			_say("%s recovers %d HP." % [c["name"], healed])
	var stopped := _status_flag(c, "skip_turn")
	if stopped != "":
		var info: Dictionary = Data.statuses.get(stopped, {})
		_say(str(info.get("skip_text", "%s can't move!")) % c["name"])
		return false
	return true

## End of a fighter's turn: statuses with a duration count down and wear off.
func end_turn(c: Dictionary) -> void:
	for status_id in c["statuses"].keys():
		var left := int(c["statuses"][status_id])
		if left < 0:
			continue
		left -= 1
		if left <= 0:
			c["statuses"].erase(status_id)
			if int(c["hp"]) > 0:
				_say("%s's %s wore off." % [c["name"], Data.statuses.get(status_id, {}).get("name", status_id)])
				if bool(Data.statuses.get(status_id, {}).get("restores_shield", false)) and int(c.get("max_shield", 0)) > 0:
					c["shield"] = int(c["max_shield"])
		else:
			c["statuses"][status_id] = left
	c["acted"] = turn
	_check_end()

# ---- actions --------------------------------------------------------------------------------------------------------

## The targets a scope reaches. `chosen` is the picked fighter for single-target scopes.
func targets_for(actor: Dictionary, scope: String, chosen: Dictionary = {}) -> Array:
	match scope:
		"all_enemies":
			return alive(foes_of(actor))
		"all_allies":
			return alive(allies_of(actor))
		"self":
			return [actor]
		"ko_ally":
			return [chosen] if not chosen.is_empty() and int(chosen["hp"]) <= 0 else fallen(allies_of(actor)).slice(0, 1)
		"ally":
			return [chosen] if not chosen.is_empty() else alive(allies_of(actor)).slice(0, 1)
		_:
			if not chosen.is_empty() and int(chosen["hp"]) > 0 and foes_of(actor).has(chosen):
				return [chosen]
			var foes := alive(foes_of(actor))
			return [foes[rng.randi() % foes.size()]] if not foes.is_empty() else []

## The scope of a skill or item: its "target", else what its type implies.
static func scope_of(entry: Dictionary) -> String:
	if entry.has("target"):
		return str(entry["target"])
	if bool(entry.get("revive", false)) or entry.get("effect", "") == "revive":
		return "ko_ally"
	if entry.get("type", "") in ["heal", "support"] or entry.get("effect", "") in ["heal", "mp", "cure", "buff"]:
		return "ally"
	return "enemy"

## Carries out one action. kind: "attack", "skill", "item", "defend", "run". Answers what happened.
func act(actor: Dictionary, kind: String, target: Dictionary = {}, id := "") -> String:
	if outcome != "" or int(actor["hp"]) <= 0:
		return ""
	var text := ""
	match kind:
		"attack":
			var targets := targets_for(actor, "enemy", target)
			if targets.is_empty():
				return ""
			var hit := _strike(actor, targets[0], "physical", 1.0, str(actor.get("element", "")), actor.get("on_hit", {}))
			text = "%s attacks %s%s" % [actor["name"], targets[0]["name"], hit]
		"skill":
			var skill: Dictionary = Data.skills.get(id, {})
			if not can_use_skills(actor):
				return act(actor, "attack", target)
			var cost := int(skill.get("mp", 0))
			if int(actor["mp"]) < cost:
				return act(actor, "attack", target)
			if int(skill.get("charge", 0)) > 0 and actor["charging"].is_empty() and not _releasing:
				# A charged skill: gathering power now, released on a later turn unless interrupted.
				actor["mp"] = int(actor["mp"]) - cost
				actor["charging"] = {"skill": id, "target": target, "left": int(skill["charge"])}
				shown.emit({"kind": "charge", "target": actor})
				text = "%s is gathering power for %s!" % [actor["name"], skill.get("name", id)]
			else:
				if not _releasing:
					actor["mp"] = int(actor["mp"]) - cost
				text = "%s uses %s%s" % [actor["name"], skill.get("name", id), _use(actor, skill, target, false)]
		"item":
			var item: Dictionary = Data.items.get(id, {})
			if actor["side"] == "party":
				Game.add_item(id, -1)
			text = "%s uses %s%s" % [actor["name"], item.get("name", id), _use(actor, item, target, true)]
		"defend":
			actor["defending"] = true
			text = "%s defends." % actor["name"]
		"run":
			var chance := Data.formula("run_chance", {"spd": stat(actor, "spd")})
			if rng.randf() < chance:
				outcome = "fled"
				text = "The party got away!"
			else:
				text = "Couldn't escape!"
	if text != "":
		message.emit(text)
	_check_end()
	return text

## A skill or item on its targets; answers the rest of the sentence (": Slime 12 (weak!)").
func _use(actor: Dictionary, entry: Dictionary, chosen: Dictionary, is_item: bool) -> String:
	var targets := targets_for(actor, scope_of(entry), chosen)
	if targets.is_empty():
		return ", but nothing happens."
	var spread := float(Game.rule("spread_power", 0.75)) if targets.size() > 1 and entry.get("type", "") in ["physical", "magic"] else 1.0
	var parts: Array = []
	for t in targets:
		parts.append(_apply(actor, t, entry, is_item, spread))
	parts = parts.filter(func(p): return p != "")
	return ": " + "; ".join(parts) + "." if not parts.is_empty() else "."

func _apply(actor: Dictionary, t: Dictionary, entry: Dictionary, is_item: bool, spread: float) -> String:
	var kind := str(entry.get("type", "")) if not is_item else str(entry.get("effect", "heal"))
	var power := float(entry.get("power", 1.0)) * spread
	var revive := bool(entry.get("revive", false)) or kind == "revive"
	var out: Array = []
	if int(t["hp"]) <= 0:
		if not revive:
			return ""
		var amount := maxi(1, int(t["max_hp"] * float(entry.get("revive_percent", 0.25))))
		if kind == "heal" and not is_item:
			amount = maxi(amount, _heal_amount(actor, power))
		t["hp"] = mini(int(t["max_hp"]), amount)
		t["statuses"] = {}
		shown.emit({"kind": "revive", "target": t, "amount": amount})
		return "%s revives (%d HP)" % [t["name"], amount]
	match kind:
		"physical", "magic", "damage":
			var element := str(entry.get("element", ""))
			if kind == "damage":
				out.append(_fixed_damage(t, int(entry.get("amount", 10)), element))
			else:
				var struck := _strike(actor, t, kind, power, element, entry.get("status", {}), int(entry.get("breaks", 0)))
				out.append(t["name"] + struck.trim_suffix("."))
				if bool(entry.get("interrupts", false)) and not struck.contains("misses") and int(t["hp"]) > 0 and not t["charging"].is_empty():
					out.append(interrupt(t))
		"heal":
			var amount := int(entry.get("amount", 0)) if is_item else _heal_amount(actor, power)
			var healed := _restore_hp(t, maxi(1, amount))
			shown.emit({"kind": "heal", "target": t, "amount": healed})
			out.append("%s +%d HP" % [t["name"], healed])
		"mp":
			var before := int(t["mp"])
			t["mp"] = mini(int(t["max_mp"]), before + int(entry.get("amount", 5)))
			shown.emit({"kind": "mp", "target": t, "amount": int(t["mp"]) - before})
			out.append("%s +%d MP" % [t["name"], int(t["mp"]) - before])
	var cured: Array = []
	for status_id in entry.get("cures", []):
		if t["statuses"].has(status_id):
			t["statuses"].erase(status_id)
			cured.append(Data.statuses.get(status_id, {}).get("name", status_id))
	if not cured.is_empty():
		shown.emit({"kind": "cure", "target": t})
		out.append("%s is cured of %s" % [t["name"], ", ".join(cured)])
	# A support skill or buff item puts its status on the target; damaging ones did it in _strike.
	var status: Dictionary = entry.get("status", {})
	if not status.is_empty() and not kind in ["physical", "magic"] and int(t["hp"]) > 0:
		var landed := inflict(t, str(status.get("id", "")), float(status.get("chance", 1.0)))
		out.append(landed if landed != "" else "%s is unaffected" % t["name"])
	return ", ".join(out.filter(func(p): return p != ""))

func _heal_amount(actor: Dictionary, power: float) -> int:
	return int(Data.formula("heal", {"mag": stat(actor, "mag"), "atk": stat(actor, "atk"), "def": 0, "level": int(actor["level"]),
		"power": power, "variance": rng.randf_range(0.9, 1.1)}))

func _restore_hp(t: Dictionary, amount: int) -> int:
	var before := int(t["hp"])
	t["hp"] = mini(int(t["max_hp"]), before + amount)
	return int(t["hp"]) - before

## An attack or damaging skill: hit or miss, critical hits (physical only), elements, defending, and a status it may
## cause. Answers the rest of the sentence (" for 12 (critical!)").
func _strike(actor: Dictionary, t: Dictionary, kind: String, power: float, element: String, status: Dictionary, breaks := 0) -> String:
	var physical := kind != "magic"
	if physical and _status_flag(t, "skip_turn") == "":
		var hit := float(Game.rule("hit_chance", 0.97)) * (1.0 - float(t.get("evade", 0.0)))
		for status_id in actor["statuses"].keys():
			hit *= float(Data.statuses.get(status_id, {}).get("hit_chance", 1.0))
		if rng.randf() > hit:
			shown.emit({"kind": "miss", "target": t})
			return ", but misses."
	var values := {"atk": stat(actor, "atk"), "mag": stat(actor, "mag"), "def": stat(t, "def"), "level": int(actor["level"]),
		"power": power, "variance": rng.randf_range(0.9, 1.1)}
	var damage := Data.formula("magic" if kind == "magic" else "physical", values)
	var crit := false
	if physical and rng.randf() < float(Game.rule("crit_chance", 0.05)) + float(actor.get("crit", 0.0)):
		crit = true
		damage *= float(Game.rule("crit_multiplier", 1.5))
	var effect := _element_effect(t, element)
	if effect == "weak":
		damage *= float(Game.rule("weak_multiplier", 1.5))
	elif effect == "resist":
		damage *= float(Game.rule("resist_multiplier", 0.5))
	if bool(t.get("defending", false)):
		damage /= 2.0
	damage *= _damage_taken(t)
	var amount := maxi(1, int(round(damage)))
	var labels := {"weak": "weak spot!", "resist": "resisted", "absorb": "absorbed!", "": ""}
	var notes: String = ("critical! " if crit else "") + str(labels[effect])
	if effect == "absorb":
		var healed := _restore_hp(t, amount)
		shown.emit({"kind": "heal", "target": t, "amount": healed, "effect": "absorb"})
		return " and %s absorbs it (+%d HP)." % [t["name"], healed]
	_hurt(t, amount, {"kind": "damage", "crit": crit, "effect": effect})
	var text := " for %d%s" % [amount, " (" + notes.strip_edges() + ")" if notes.strip_edges() != "" else ""]
	var cracked := _wear_shield(t, (1 if effect == "weak" else 0) + (1 if crit else 0) + breaks)
	if cracked != "":
		text += "; " + cracked
	if not status.is_empty() and int(t["hp"]) > 0:
		var landed := inflict(t, str(status.get("id", "")), float(status.get("chance", 1.0)))
		if landed != "":
			text += "; " + landed
	return text + "."

func _fixed_damage(t: Dictionary, amount: int, element: String) -> String:
	var effect := _element_effect(t, element)
	var value := float(amount) * (float(Game.rule("weak_multiplier", 1.5)) if effect == "weak" else float(Game.rule("resist_multiplier", 0.5)) if effect == "resist" else 1.0)
	value *= _damage_taken(t)
	_hurt(t, maxi(1, int(value)), {"kind": "damage", "effect": effect})
	var cracked := _wear_shield(t, 1 if effect == "weak" else 0)
	return "%s takes %d%s" % [t["name"], maxi(1, int(value)), "; " + cracked if cracked != "" else ""]

## Damage multipliers from statuses on the one hit ("damage_taken", such as Broken's 1.5).
func _damage_taken(t: Dictionary) -> float:
	var factor := 1.0
	for status_id in t["statuses"].keys():
		factor *= float(Data.statuses.get(status_id, {}).get("damage_taken", 1.0))
	return factor

## Break: an enemy with a "shield" loses a point for each weakness hit, critical hit or breaking skill; at zero it is
## broken: it loses its next turn (and the rest of this round if it has not acted yet), its charge is cancelled, and it
## takes extra damage until it recovers its full shield.
func _wear_shield(t: Dictionary, points: int) -> String:
	if points <= 0 or int(t.get("max_shield", 0)) <= 0 or int(t["hp"]) <= 0 or t["statuses"].has("broken"):
		return ""
	t["shield"] = maxi(0, int(t["shield"]) - points)
	shown.emit({"kind": "shield", "target": t, "amount": int(t["shield"])})
	if int(t["shield"]) > 0:
		return "shield %d left" % int(t["shield"])
	t["statuses"]["broken"] = 1 if int(t.get("acted", -1)) == turn else 2
	t["charging"] = {}
	t["intent"] = {}
	shown.emit({"kind": "break", "target": t})
	return str(Data.statuses.get("broken", {}).get("text", "%s is broken!")) % t["name"]

## A hit that interrupts stops a gathering attack, unless the fighter can't be interrupted (said differently).
func interrupt(t: Dictionary) -> String:
	if bool(t.get("uninterruptible", false)):
		shown.emit({"kind": "miss", "target": t})
		return "%s can't be interrupted" % t["name"]
	var skill_name := str(Data.skills.get(t["charging"].get("skill", ""), {}).get("name", "attack"))
	t["charging"] = {}
	t["intent"] = {}
	shown.emit({"kind": "interrupt", "target": t})
	return "%s's %s is interrupted!" % [t["name"], skill_name]

func _element_effect(t: Dictionary, element: String) -> String:
	if element == "":
		return ""
	if t.get("absorb", []).has(element):
		return "absorb"
	if t.get("weak", []).has(element):
		return "weak"
	if t.get("resist", []).has(element):
		return "resist"
	return ""

func _hurt(t: Dictionary, amount: int, info: Dictionary) -> void:
	t["hp"] = maxi(0, int(t["hp"]) - amount)
	info["target"] = t
	info["amount"] = amount
	shown.emit(info)
	if int(t["hp"]) <= 0:
		t["statuses"] = {}
		t["defending"] = false
		t["charging"] = {}
		t["intent"] = {}
		shown.emit({"kind": "ko", "target": t})
		_say("%s %s" % [t["name"], "falls!" if t["side"] == "party" else "is defeated!"])
		return
	for status_id in t["statuses"].keys():
		if bool(Data.statuses.get(status_id, {}).get("wake_on_hit", false)) and info.get("kind") == "damage" and not info.has("status"):
			t["statuses"].erase(status_id)
			_say("%s wakes up!" % t["name"])
	if t["side"] == "enemy":
		_check_phase(t)

## Puts a status on a fighter (chance 0-1). Answers what to say, or "" when it did not land.
func inflict(t: Dictionary, status_id: String, chance: float, quiet := false) -> String:
	var info: Dictionary = Data.statuses.get(status_id, {})
	if info.is_empty() or int(t["hp"]) <= 0:
		return ""
	if t.get("immune", []).has(status_id) or rng.randf() > chance:
		return ""
	for other in info.get("cancels", []):
		if t["statuses"].has(other):
			t["statuses"].erase(other)
			if not quiet:
				shown.emit({"kind": "cure", "target": t})
			return "%s's %s is cancelled" % [t["name"], Data.statuses.get(other, {}).get("name", other)]
	var turns := int(info.get("turns", 0))
	t["statuses"][status_id] = turns if turns > 0 else -1
	if not quiet:
		shown.emit({"kind": "status", "target": t, "status": status_id})
	if bool(info.get("draw_attacks", false)):
		_redirect_to(t)
	if bool(info.get("skip_turn", false)) and not t["charging"].is_empty() and not bool(t.get("uninterruptible", false)):
		t["charging"] = {}
		shown.emit({"kind": "interrupt", "target": t})
	var text := str(info.get("text", "%s is affected by " + str(info.get("name", status_id))))
	return text % t["name"] if "%s" in text else text

func _say(text: String) -> void:
	message.emit(text)

## A taunt: enemies aiming a single-target action at one of the taunter's allies turn toward the taunter.
func _redirect_to(taunter: Dictionary) -> void:
	for e in alive(foes_of(taunter)):
		for plan in [e["intent"], e["charging"]]:
			var aimed: Dictionary = plan.get("target", {})
			if not aimed.is_empty() and aimed["side"] == taunter["side"] and not is_same(aimed, taunter) and _single_target(plan):
				plan["target"] = taunter
				shown.emit({"kind": "redirect", "target": e})

func _single_target(plan: Dictionary) -> bool:
	if plan.get("kind", "skill") == "attack":
		return true
	return scope_of(Data.skills.get(str(plan.get("skill", "")), {})) == "enemy"

## Fighters on a side drawing attacks (taunting), if any are standing.
func _taunting(list: Array) -> Array:
	return alive(list).filter(func(c): return _status_flag(c, "draw_attacks") != "")

# ---- rounds, intent and charging ----------------------------------------------------------------------------------

## The start of a round: each enemy decides its action now (its intent), so the screen can show it and the party can
## answer it. The enemy then does exactly that on its turn, unless it was interrupted, broken or its target fell.
func start_round() -> void:
	turn += 1
	for e in alive(enemies):
		e["intent"] = {} if not e["charging"].is_empty() else choose_action(e)

## What an enemy is about to do, in a few words ("Bite -> Aria", "Maul (gathering) -> Pip").
func intent_text(e: Dictionary) -> String:
	if int(e["hp"]) <= 0:
		return ""
	var plan: Dictionary = e["charging"] if not e["charging"].is_empty() else e["intent"]
	if plan.is_empty():
		return ""
	if plan.get("kind", "skill") == "defend":
		return "Defend"
	var label := "Attack" if plan.get("kind", "skill") == "attack" else str(Data.skills.get(str(plan.get("skill", "")), {}).get("name", "?"))
	if not e["charging"].is_empty():
		label += " (gathering)"
	var scope := "enemy" if plan.get("kind", "skill") == "attack" else scope_of(Data.skills.get(str(plan.get("skill", "")), {}))
	var target: Dictionary = plan.get("target", {})
	match scope:
		"all_enemies":
			return label + " -> everyone"
		"self", "all_allies", "ally", "ko_ally":
			return label
	return label + (" -> " + str(target["name"]) if not target.is_empty() else "")

## A fighter gathering power continues; when ready, the charged skill is released at its target (or another, if that
## target fell).
func release_charge(actor: Dictionary) -> String:
	var plan: Dictionary = actor["charging"]
	plan["left"] = int(plan.get("left", 1)) - 1
	if int(plan["left"]) > 0:
		var still := "%s keeps gathering power." % actor["name"]
		_say(still)
		return still
	actor["charging"] = {}
	_releasing = true
	var text := act(actor, "skill", _valid_target(actor, plan), str(plan["skill"]))
	_releasing = false
	return text

func _valid_target(actor: Dictionary, plan: Dictionary) -> Dictionary:
	var target: Dictionary = plan.get("target", {})
	if _single_target(plan) and (target.is_empty() or int(target["hp"]) <= 0 or not foes_of(actor).has(target)):
		var taunting := _taunting(foes_of(actor))
		var foes := alive(foes_of(actor))
		return taunting[0] if not taunting.is_empty() else (foes[rng.randi() % foes.size()] if not foes.is_empty() else {})
	return target

# ---- enemies --------------------------------------------------------------------------------------------------------

## Boss phases: when HP falls to a phase's threshold, its line is said and its changes apply, once each.
func _check_phase(enemy: Dictionary) -> void:
	var phases: Array = enemy.get("phases", [])
	while int(enemy["phase"]) < phases.size():
		var phase: Dictionary = phases[int(enemy["phase"])]
		if float(enemy["hp"]) / maxi(1, int(enemy["max_hp"])) > float(phase.get("below", 0.5)):
			return
		enemy["phase"] = int(enemy["phase"]) + 1
		if phase.has("say"):
			_say(str(phase["say"]))
		for stat_name in phase.get("stats", {}).keys():
			enemy["base"][stat_name] = float(enemy["base"].get(stat_name, 0)) * float(phase["stats"][stat_name])
		if phase.has("ai"):
			enemy["ai"] = phase["ai"]
		if phase.has("skills"):
			enemy["skills"] = phase["skills"]
		for status_id in phase.get("statuses", []):
			inflict(enemy, status_id, 1.0, true)
		if int(phase.get("heal", 0)) > 0:
			_restore_hp(enemy, int(phase["heal"]))
		shown.emit({"kind": "phase", "target": enemy})

## The enemy's turn: it releases a gathered attack, or does what it planned at the start of the round (its intent).
func enemy_turn(enemy: Dictionary) -> String:
	if alive(party).is_empty():
		return ""
	if not enemy["charging"].is_empty():
		return release_charge(enemy)
	var plan: Dictionary = enemy["intent"] if not enemy["intent"].is_empty() else choose_action(enemy)
	enemy["intent"] = {}
	match str(plan.get("kind", "attack")):
		"defend":
			return act(enemy, "defend")
		"skill":
			return act(enemy, "skill", _valid_target(enemy, plan), str(plan["skill"]))
	return act(enemy, "attack", _valid_target(enemy, plan))

## What an enemy will do: with "ai" rules, the first rule whose conditions hold (and whose chance roll passes);
## otherwise a skill it can afford some of the time and an attack the rest. Answers {kind, skill, target}.
func choose_action(enemy: Dictionary) -> Dictionary:
	var foes := alive(party)
	if foes.is_empty():
		return {}
	for rule in enemy.get("ai", []):
		var skill_id := str(rule.get("skill", "attack"))
		if not _rule_holds(enemy, rule):
			continue
		if skill_id == "defend":
			return {"kind": "defend"}
		if skill_id != "attack":
			var skill: Dictionary = Data.skills.get(skill_id, {})
			if skill.is_empty() or int(enemy["mp"]) < int(skill.get("mp", 0)) or not can_use_skills(enemy):
				continue
		if rng.randf() > float(rule.get("chance", 1.0)):
			continue
		if bool(rule.get("once", false)):
			enemy["used"][str(rule)] = true
		var target := _pick_target(enemy, rule, skill_id)
		return {"kind": "attack", "target": target} if skill_id == "attack" else {"kind": "skill", "skill": skill_id, "target": target}
	var taunting := _taunting(party)
	var target: Dictionary = taunting[0] if not taunting.is_empty() else foes[rng.randi() % foes.size()]
	if enemy.get("ai", []).is_empty():
		var usable: Array = enemy["skills"].filter(func(s): return int(Data.skills.get(s, {}).get("mp", 0)) <= int(enemy["mp"]))
		if not usable.is_empty() and can_use_skills(enemy) and rng.randf() < 0.35:
			var skill_id: String = usable[rng.randi() % usable.size()]
			var scope := scope_of(Data.skills.get(skill_id, {}))
			return {"kind": "skill", "skill": skill_id, "target": enemy if scope in ["ally", "self", "all_allies"] else target}
	return {"kind": "attack", "target": target}

func _rule_holds(enemy: Dictionary, rule: Dictionary) -> bool:
	if bool(rule.get("once", false)) and enemy["used"].has(str(rule)):
		return false
	var when: Dictionary = rule.get("if", {})
	var hp := float(enemy["hp"]) / maxi(1, int(enemy["max_hp"]))
	if when.has("hp_below") and hp >= float(when["hp_below"]):
		return false
	if when.has("hp_above") and hp <= float(when["hp_above"]):
		return false
	if when.has("turn_every") and turn % maxi(1, int(when["turn_every"])) != 0:
		return false
	if when.has("turn_at_least") and turn < int(when["turn_at_least"]):
		return false
	if when.has("ally_hurt"):
		var hurt := alive(enemies).filter(func(e): return float(e["hp"]) / maxi(1, int(e["max_hp"])) < float(when["ally_hurt"]))
		if hurt.is_empty():
			return false
	if when.has("ally_down") and fallen(enemies).is_empty():
		return false
	if when.has("target_without"):
		var missing := alive(party).filter(func(c): return not c["statuses"].has(str(when["target_without"])))
		if missing.is_empty():
			return false
	if when.has("self_without") and enemy["statuses"].has(str(when["self_without"])):
		return false
	return true

func _pick_target(enemy: Dictionary, rule: Dictionary, skill_id: String) -> Dictionary:
	var scope := "enemy" if skill_id == "attack" else scope_of(Data.skills.get(skill_id, {}))
	if scope in ["self", "all_enemies", "all_allies"]:
		return enemy
	if scope == "ko_ally":
		var down := fallen(enemies)
		return down[0] if not down.is_empty() else {}
	if scope == "ally":
		var hurt := alive(enemies)
		hurt.sort_custom(func(a, b): return float(a["hp"]) / maxi(1, int(a["max_hp"])) < float(b["hp"]) / maxi(1, int(b["max_hp"])))
		return hurt[0]
	var foes := alive(party)
	var taunting := _taunting(party)
	if not taunting.is_empty():
		return taunting[0]
	var when: Dictionary = rule.get("if", {})
	if when.has("target_without"):
		foes = foes.filter(func(c): return not c["statuses"].has(str(when["target_without"])))
	match str(rule.get("target", "random")):
		"weakest":
			foes.sort_custom(func(a, b): return int(a["hp"]) < int(b["hp"]))
			return foes[0]
		"strongest":
			foes.sort_custom(func(a, b): return stat(a, "atk") + stat(a, "mag") > stat(b, "atk") + stat(b, "mag"))
			return foes[0]
		"caster":
			foes.sort_custom(func(a, b): return stat(a, "mag") > stat(b, "mag"))
			return foes[0]
	return foes[rng.randi() % foes.size()]

# ---- the party's autopilot (simulation and autoplay) ------------------------------------------------------------

## A sensible party choice: revive the fallen, heal the badly hurt, cure what stops a turn, else the action with the
## most expected damage (weaknesses and hitting everyone counted).
func auto_turn(member: Dictionary) -> String:
	var foes := alive(enemies)
	if foes.is_empty():
		return ""
	var skills: Array = member["skills"].filter(func(s): return can_use_skills(member) and int(Data.skills.get(s, {}).get("mp", 0)) <= int(member["mp"]))
	for e in foes:
		if not e["charging"].is_empty() and not bool(e.get("uninterruptible", false)):
			for skill_id in skills:
				if bool(Data.skills[skill_id].get("interrupts", false)):
					return act(member, "skill", e, skill_id)
	for e in foes:
		if not e["charging"].is_empty() and is_same(e["charging"].get("target", {}), member) and int(member["hp"]) * 2 < int(member["max_hp"]):
			return act(member, "defend")
	var down := fallen(party)
	if not down.is_empty():
		for skill_id in skills:
			if scope_of(Data.skills[skill_id]) == "ko_ally":
				return act(member, "skill", down[0], skill_id)
	var hurt := alive(party).filter(func(c): return int(c["hp"]) * 3 < int(c["max_hp"]))
	if not hurt.is_empty():
		for skill_id in skills:
			var skill: Dictionary = Data.skills[skill_id]
			if skill.get("type") == "heal" and scope_of(skill) in ["ally", "all_allies"]:
				return act(member, "skill", hurt[0], skill_id)
	for ally in alive(party):
		var stopped := _status_flag(ally, "skip_turn")
		var stuck := stopped if stopped != "" else _status_flag(ally, "no_skills")
		if stuck == "":
			continue
		for skill_id in skills:
			if Data.skills[skill_id].get("cures", []).has(stuck):
				return act(member, "skill", ally, skill_id)
	var best_score := _expected(member, {"type": "physical", "power": 1.0, "element": member.get("element", "")}, foes)
	var best := ""
	for skill_id in skills:
		var skill: Dictionary = Data.skills[skill_id]
		if not skill.get("type", "") in ["physical", "magic"]:
			continue
		var score := _expected(member, skill, foes)
		if score > best_score * 1.05:
			best = skill_id
			best_score = score
	var target := _best_target(member, Data.skills.get(best, {"element": member.get("element", "")}), foes)
	if best != "":
		return act(member, "skill", target, best)
	return act(member, "attack", target)

func _expected(member: Dictionary, entry: Dictionary, foes: Array) -> float:
	var attack := float(stat(member, "mag")) * 1.2 if entry.get("type") == "magic" else float(stat(member, "atk"))
	var power := float(entry.get("power", 1.0))
	var count := float(foes.size()) * float(Game.rule("spread_power", 0.75)) if scope_of(entry) == "all_enemies" and foes.size() > 1 else 1.0
	var best_mult := 0.0
	for foe in foes:
		var mult: float = {"weak": float(Game.rule("weak_multiplier", 1.5)), "resist": float(Game.rule("resist_multiplier", 0.5)), "absorb": -1.0, "": 1.0}[_element_effect(foe, str(entry.get("element", "")))]
		best_mult = maxf(best_mult, mult)
	return attack * power * count * best_mult

func _best_target(member: Dictionary, entry: Dictionary, foes: Array) -> Dictionary:
	var sorted := foes.duplicate()
	var element := str(entry.get("element", ""))
	sorted.sort_custom(func(a, b):
		var ea := _element_effect(a, element)
		var eb := _element_effect(b, element)
		if (ea == "weak") != (eb == "weak"):
			return ea == "weak"
		if (ea == "absorb") != (eb == "absorb"):
			return eb == "absorb"
		return int(a["hp"]) < int(b["hp"]))
	return sorted[0]

func _check_end() -> void:
	if outcome != "":
		return
	if alive(enemies).is_empty():
		outcome = "won"
	elif alive(party).is_empty():
		outcome = "lost"

## Writes HP, MP and lasting statuses back to the party and answers the rewards for a win: {xp, gold, drops}.
func finish() -> Dictionary:
	for c in party:
		c["ref"]["hp"] = maxi(0, int(c["hp"]))
		c["ref"]["mp"] = int(c["mp"])
		var lasting: Array = []
		for status_id in c["statuses"].keys():
			if bool(Data.statuses.get(status_id, {}).get("lasting", false)):
				lasting.append(status_id)
		c["ref"]["status"] = lasting
	if outcome != "won":
		return {}
	var xp := 0
	var gold := 0
	var drops: Array = []
	for e in enemies:
		var info: Dictionary = Data.enemies.get(e["id"], {})
		xp += int(info.get("xp", 0))
		gold += int(info.get("gold", 0))
		var table: Array = info.get("drops", [])
		if info.has("drop"):
			table = table + [info["drop"]]
		for drop in table:
			if drop.has("item") and rng.randf() < float(drop.get("chance", 0.0)):
				drops.append(drop["item"])
	return {"xp": xp, "gold": gold, "drops": drops}

## One whole round with the autopilot for the party; answers false once the battle is over.
func auto_round() -> bool:
	start_round()
	for actor in turn_order():
		if outcome != "":
			break
		if begin_turn(actor):
			if not actor["charging"].is_empty() and actor["side"] == "party":
				release_charge(actor)
			elif actor["side"] == "party":
				auto_turn(actor)
			else:
				enemy_turn(actor)
		end_turn(actor)
	return outcome == ""

## Runs a whole battle with the autopilot; for the simulator and autoplay tests.
func run_auto(max_turns := 200) -> String:
	while outcome == "" and turn < max_turns:
		auto_round()
	if outcome == "":
		outcome = "timeout"
	return outcome
