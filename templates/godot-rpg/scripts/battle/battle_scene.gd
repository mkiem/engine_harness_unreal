extends Node2D
## The battle screen. All rules are in BattleLogic; this shows the enemies, the party's HP and MP, a message log and the
## command menu (Attack, Skill, Item, Defend, Run), and hands out rewards. Arrow keys and Enter choose; Esc goes back.

signal chosen(value)

var logic := BattleLogic.new()
var autoplay := false
var _can_cancel := false
var _log: Label
var _status: Label
var _menu: VBoxContainer
var _enemy_sprites: Array = []
var _screen: Vector2

func _ready() -> void:
	autoplay = OS.get_cmdline_user_args().has("--autotest") or OS.get_cmdline_user_args().has("--autoplay")
	_screen = get_viewport_rect().size
	if Game.party.is_empty():
		Game.new_game()
	var enemy_ids: Array = Game.pending_battle if not Game.pending_battle.is_empty() else _first_group()
	logic.setup(Game.party, enemy_ids)
	logic.message.connect(_say)
	_build_ui()
	Sound.music(Data.game.get("battle_music", ""))
	_say("Enemies appear: %s!" % ", ".join(logic.enemies.map(func(e): return e["name"])))
	await get_tree().create_timer(0.4).timeout
	_run()

func _first_group() -> Array:
	for zone in Data.encounters.values():
		var groups: Array = zone.get("groups", [])
		if not groups.is_empty():
			return groups[0]
	return ["slime"]

func _build_ui() -> void:
	var background := ColorRect.new()
	background.color = Color(Data.game.get("battle_background", "#1d2b53"))
	background.size = _screen
	add_child(background)
	var sheet := Data.texture(Data.game.get("enemy_sprites", "res://art/enemies.png"))
	var frames := int(Data.game.get("enemy_frames", 4))
	for i in logic.enemies.size():
		var enemy: Dictionary = logic.enemies[i]
		var sprite := Sprite2D.new()
		sprite.texture = sheet
		sprite.hframes = frames
		sprite.frame = int(Data.enemies.get(enemy["id"], {}).get("frame", 0)) % frames
		sprite.position = Vector2(_screen.x * (i + 1) / (logic.enemies.size() + 1), _screen.y * 0.3)
		add_child(sprite)
		_enemy_sprites.append(sprite)
	var layer := CanvasLayer.new()
	add_child(layer)
	_log = Label.new()
	_log.add_theme_font_size_override("font_size", 8)
	_log.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_log.position = Vector2(4, _screen.y * 0.48)
	_log.size = Vector2(_screen.x - 8, 30)
	layer.add_child(_log)
	_status = Label.new()
	_status.add_theme_font_size_override("font_size", 8)
	_status.position = Vector2(_screen.x * 0.45, _screen.y * 0.66)
	layer.add_child(_status)
	_menu = VBoxContainer.new()
	_menu.position = Vector2(4, _screen.y * 0.66)
	layer.add_child(_menu)
	_refresh()

func _say(text: String) -> void:
	_log.text = text
	if autoplay:
		print("BATTLE ", text)

func _refresh() -> void:
	var lines: Array = []
	for c in logic.party:
		lines.append("%s  HP %d/%d  MP %d" % [c["name"], int(c["hp"]), int(c["max_hp"]), int(c["mp"])])
	_status.text = "\n".join(lines)
	for i in _enemy_sprites.size():
		_enemy_sprites[i].visible = int(logic.enemies[i]["hp"]) > 0

func _pause() -> void:
	_refresh()
	await get_tree().create_timer(0.05 if autoplay else 0.6).timeout

func _run() -> void:
	while logic.outcome == "":
		logic.turn += 1
		for actor in logic.turn_order():
			if logic.outcome != "":
				break
			if int(actor["hp"]) <= 0:
				continue
			if actor["side"] == "enemy":
				logic.enemy_turn(actor)
				Sound.play("hit")
			elif autoplay:
				logic.auto_turn(actor)
			else:
				await _player_turn(actor)
			await _pause()
	await _finish()

func _player_turn(actor: Dictionary) -> void:
	while true:
		_say("%s's turn." % actor["name"])
		var command = await _choose(["Attack", "Skill", "Item", "Defend", "Run"])
		match command:
			"Attack":
				var target = await _choose_target(logic.alive(logic.enemies))
				if target != null:
					logic.act(actor, "attack", target)
					Sound.play("hit")
					return
			"Skill":
				var names: Array = []
				for id in actor["skills"]:
					var skill: Dictionary = Data.skills.get(id, {})
					names.append("%s (%d MP)" % [skill.get("name", id), int(skill.get("mp", 0))])
				var picked = await _choose(names, true)
				if picked == null:
					continue
				var skill_id: String = actor["skills"][names.find(picked)]
				var skill: Dictionary = Data.skills.get(skill_id, {})
				if int(actor["mp"]) < int(skill.get("mp", 0)):
					_say("Not enough MP.")
					await _pause()
					continue
				var pool := logic.alive(logic.party) if skill.get("type") == "heal" else logic.alive(logic.enemies)
				var target = await _choose_target(pool)
				if target != null:
					logic.act(actor, "skill", target, skill_id)
					Sound.play("heal" if skill.get("type") == "heal" else "hit")
					return
			"Item":
				var ids: Array = Game.inventory.keys()
				if ids.is_empty():
					_say("No items.")
					await _pause()
					continue
				var labels := ids.map(func(id): return "%s x%d" % [Data.items.get(id, {}).get("name", id), int(Game.inventory[id])])
				var picked = await _choose(labels, true)
				if picked == null:
					continue
				var target = await _choose_target(logic.alive(logic.party))
				if target != null:
					logic.act(actor, "item", target, ids[labels.find(picked)])
					Sound.play("heal")
					return
			"Defend":
				logic.act(actor, "defend")
				return
			"Run":
				logic.act(actor, "run")
				return

func _choose_target(pool: Array):
	if pool.size() == 1:
		return pool[0]
	var picked = await _choose(pool.map(func(c): return c["name"]), true)
	if picked == null:
		return null
	for c in pool:
		if c["name"] == picked:
			return c
	return null

## Shows options as buttons and waits for one; null when the player backs out with Esc.
func _choose(options: Array, can_cancel := false):
	for child in _menu.get_children():
		child.queue_free()
	for option in options:
		var button := Button.new()
		button.text = str(option)
		button.add_theme_font_size_override("font_size", 8)
		button.pressed.connect(func(): chosen.emit(option))
		_menu.add_child(button)
	await get_tree().process_frame
	if _menu.get_child_count() > 0:
		(_menu.get_child(0) as Button).grab_focus()
	_can_cancel = can_cancel
	var value = await chosen
	for child in _menu.get_children():
		child.queue_free()
	return value

func _unhandled_input(event: InputEvent) -> void:
	if _can_cancel and event.is_action_pressed("ui_cancel"):
		get_viewport().set_input_as_handled()
		_can_cancel = false
		chosen.emit(null)

func _finish() -> void:
	var rewards := logic.finish()
	match logic.outcome:
		"won":
			Sound.play("victory")
			Game.gold += int(rewards.get("gold", 0))
			for item in rewards.get("drops", []):
				Game.add_item(item)
			var raised := Game.gain_xp(int(rewards.get("xp", 0)))
			_say("Victory! %d XP, %d gold." % [int(rewards.get("xp", 0)), int(rewards.get("gold", 0))])
			await _pause()
			for name in raised:
				_say("%s reached a new level!" % name)
				await _pause()
		"fled":
			await _pause()
		_:
			_say("The party has fallen...")
			await _pause()
	Game.pending_battle = []
	if autoplay:
		print("AUTOTEST battle: %s" % logic.outcome)
		get_tree().quit(0)
		return
	if logic.outcome == "lost":
		Game.heal_all()
		Router.title()
	else:
		Router.overworld()
