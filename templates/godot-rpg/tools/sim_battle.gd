extends Node
## Balance check: fights the same battle many times with the real rules (BattleLogic) and prints the results as one
## JSON line starting with SIM_RESULT. Run headless:
##   godot --headless --path . res://tools/sim_battle.tscn -- --enemies slime,slime --runs 200 --level 1

func _ready() -> void:
	var args := _args()
	var enemy_ids: Array = str(args.get("enemies", "")).split(",", false)
	if enemy_ids.is_empty():
		for zone in Data.encounters.values():
			var groups: Array = zone.get("groups", [])
			if not groups.is_empty():
				enemy_ids = groups[0]
				break
	var runs := int(args.get("runs", 200))
	var level := int(args.get("level", Data.party.get("level", 1)))
	var members: Array = str(args.get("party", "")).split(",", false)
	if members.is_empty():
		members = Data.party.get("members", [])
	var tally := {"won": 0, "lost": 0, "fled": 0, "timeout": 0}
	var turns := 0
	var hp_left := 0.0
	var mp_used := 0.0
	for i in runs:
		var party: Array = []
		for id in members:
			party.append(Game.make_member(id, level))
		var logic := BattleLogic.new()
		logic.setup(party, enemy_ids, int(args.get("seed", 1)) + i)
		var outcome := logic.run_auto()
		tally[outcome] = int(tally.get(outcome, 0)) + 1
		turns += logic.turn
		var total := 0.0
		var spent := 0.0
		for c in logic.party:
			total += float(c["hp"]) / max(1, int(c["max_hp"]))
			spent += float(int(c["max_mp"]) - int(c["mp"]))
		hp_left += total / max(1, logic.party.size())
		mp_used += spent / max(1, logic.party.size())
	var result := {
		"enemies": enemy_ids, "party": members, "level": level, "runs": runs,
		"win_rate": float(tally["won"]) / runs, "loss_rate": float(tally["lost"]) / runs,
		"timeouts": tally["timeout"], "avg_turns": float(turns) / runs,
		"avg_hp_left": hp_left / runs, "avg_mp_used": mp_used / runs,
	}
	print("SIM_RESULT " + JSON.stringify(result))
	get_tree().quit(0)

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
