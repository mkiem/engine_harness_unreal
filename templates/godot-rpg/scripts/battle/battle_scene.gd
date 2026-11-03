extends Node2D
## The battle screen. All rules are in BattleLogic; this shows the enemies, the party's HP, MP and statuses, a message
## log, damage numbers and the command menu (Attack, Skill, Item, Defend, Run), and hands out rewards. Arrow keys and
## Enter choose; Esc goes back.

signal chosen(value)

var logic := BattleLogic.new()
var autoplay := false
var _can_cancel := false
var _log: Label
var _rows: VBoxContainer
var _row_labels: Array = []
var _menu: VBoxContainer
var _enemy_sprites: Array = []
var _screen: Vector2
var _layer: CanvasLayer

func _ready() -> void:
	autoplay = OS.get_cmdline_user_args().has("--autotest") or OS.get_cmdline_user_args().has("--autoplay")
	_screen = get_viewport_rect().size
	if Game.party.is_empty():
		Game.new_game()
	var enemy_ids: Array = Game.pending_battle if not Game.pending_battle.is_empty() else _first_group()
	logic.setup(Game.party, enemy_ids)
	logic.message.connect(_say)
	logic.shown.connect(_show)
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
	var look := Game.battle_background if Game.battle_background != "" else str(Data.game.get("battle_background", "#1d2b53"))
	if look.ends_with(".png"):
		var picture := TextureRect.new()
		picture.texture = Data.texture(look)
		picture.size = _screen
		picture.stretch_mode = TextureRect.STRETCH_SCALE
		add_child(picture)
	else:
		var background := ColorRect.new()
		background.color = Color(look)
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
		sprite.position = Vector2(_screen.x * (i + 1) / (logic.enemies.size() + 1), _screen.y * 0.27)
		if Data.enemies.get(enemy["id"], {}).has("scale"):
			sprite.scale = Vector2.ONE * float(Data.enemies[enemy["id"]]["scale"])
		add_child(sprite)
		_enemy_sprites.append(sprite)
	_layer = CanvasLayer.new()
	add_child(_layer)
	_log = Label.new()
	_log.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_log.position = Vector2(4, _screen.y * 0.47)
	_log.size = Vector2(_screen.x - 8, 30)
	_layer.add_child(_log)
	_rows = VBoxContainer.new()
	_rows.position = Vector2(_screen.x * 0.38, _screen.y * 0.66)
	_rows.add_theme_constant_override("separation", 0)
	_layer.add_child(_rows)
	for c in logic.party:
		var label := Label.new()
		_rows.add_child(label)
		_row_labels.append(label)
	_menu = VBoxContainer.new()
	_menu.position = Vector2(4, _screen.y * 0.66)
	_menu.add_theme_constant_override("separation", 0)
	_layer.add_child(_menu)
	_refresh()

func _say(text: String) -> void:
	_log.text = text
	if autoplay:
		print("BATTLE ", text)

static func status_tags(c: Dictionary) -> String:
	var tags: Array = []
	for status_id in c["statuses"].keys():
		tags.append(str(Data.statuses.get(status_id, {}).get("name", status_id)).substr(0, 3).to_upper())
	return " [%s]" % " ".join(tags) if not tags.is_empty() else ""

func _refresh() -> void:
	for i in logic.party.size():
		var c: Dictionary = logic.party[i]
		var label: Label = _row_labels[i]
		label.text = "%s  %d/%d  MP %d%s" % [c["name"], int(c["hp"]), int(c["max_hp"]), int(c["mp"]), status_tags(c)]
		label.modulate = Color(1, 0.4, 0.4) if int(c["hp"]) <= 0 else (Color(1, 0.85, 0.4) if int(c["hp"]) * 4 < int(c["max_hp"]) else Color.WHITE)
	for i in _enemy_sprites.size():
		var sprite: Sprite2D = _enemy_sprites[i]
		if int(logic.enemies[i]["hp"]) <= 0 and sprite.visible and sprite.modulate.a > 0.99:
			var fade := create_tween()
			fade.tween_property(sprite, "modulate:a", 0.0, 0.3)
			fade.tween_callback(func(): sprite.visible = false)

## Damage numbers, flashes and status marks for what BattleLogic reports.
func _show(info: Dictionary) -> void:
	if autoplay:
		return
	var target: Dictionary = info.get("target", {})
	var at := _position_of(target)
	var kind := str(info.get("kind", ""))
	var text := ""
	var color := Color.WHITE
	match kind:
		"damage":
			text = str(int(info.get("amount", 0)))
			color = Color(1, 0.9, 0.3) if bool(info.get("crit", false)) else (Color(1, 0.55, 0.3) if info.get("effect", "") == "weak" else Color.WHITE)
			_flash(target)
		"heal", "revive":
			text = "+%d" % int(info.get("amount", 0))
			color = Color(0.4, 1, 0.5)
		"mp":
			text = "+%d MP" % int(info.get("amount", 0))
			color = Color(0.5, 0.7, 1)
		"miss":
			text = "Miss"
			color = Color(0.7, 0.7, 0.7)
		"status":
			var status: Dictionary = Data.statuses.get(str(info.get("status", "")), {})
			text = str(status.get("name", ""))
			color = Color(str(status.get("color", "#ffffff")))
		"phase":
			_flash(target, Color(1, 0.2, 0.2), 0.4)
	if text == "":
		return
	var label := Label.new()
	label.text = text
	label.modulate = color
	label.position = at + Vector2(-8, -10)
	_layer.add_child(label)
	var tween := create_tween()
	tween.tween_property(label, "position:y", label.position.y - 12, 0.6)
	tween.parallel().tween_property(label, "modulate:a", 0.0, 0.6).set_delay(0.3)
	tween.tween_callback(label.queue_free)

func _position_of(target: Dictionary) -> Vector2:
	var index := logic.enemies.find(target)
	if index >= 0:
		return _enemy_sprites[index].position
	index = logic.party.find(target)
	if index >= 0:
		return _rows.position + Vector2(90, 10 * index)
	return _screen / 2

func _flash(target: Dictionary, color := Color(1, 1, 1, 0.3), seconds := 0.15) -> void:
	var index := logic.enemies.find(target)
	if index < 0:
		return
	var sprite: Sprite2D = _enemy_sprites[index]
	var tween := create_tween()
	tween.tween_property(sprite, "modulate", color, seconds / 2)
	tween.tween_property(sprite, "modulate", Color.WHITE, seconds / 2)

func _pause() -> void:
	_refresh()
	await get_tree().create_timer(0.03 if autoplay else 0.7).timeout

func _run() -> void:
	while logic.outcome == "":
		logic.turn += 1
		for actor in logic.turn_order():
			if logic.outcome != "":
				break
			var acts := logic.begin_turn(actor)
			if acts:
				if actor["side"] == "enemy":
					logic.enemy_turn(actor)
					Sound.play("hit")
				elif autoplay:
					logic.auto_turn(actor)
				else:
					await _player_turn(actor)
			logic.end_turn(actor)
			await _pause()
	await _finish()

func _player_turn(actor: Dictionary) -> void:
	while true:
		_say("%s's turn." % actor["name"])
		_refresh()
		var commands := ["Attack", "Skill", "Item", "Defend", "Run"]
		if bool(Game.pending_event.get("no_run", false)):
			commands.erase("Run")
		var command = await _choose(commands)
		match command:
			"Attack":
				var target = await _choose_target(actor, "enemy")
				if target != null:
					logic.act(actor, "attack", target)
					Sound.play("hit")
					return
			"Skill":
				if not logic.can_use_skills(actor):
					_say("%s can't use skills right now!" % actor["name"])
					await _pause()
					continue
				var ids: Array = actor["skills"]
				if ids.is_empty():
					_say("%s has no skills yet." % actor["name"])
					await _pause()
					continue
				var names: Array = ids.map(func(id): return "%s %d" % [Data.skills.get(id, {}).get("name", id), int(Data.skills.get(id, {}).get("mp", 0))])
				var picked = await _choose(names, true, func(i): return str(Data.skills.get(ids[i], {}).get("about", "")))
				if picked == null:
					continue
				var skill_id: String = ids[names.find(picked)]
				var skill: Dictionary = Data.skills.get(skill_id, {})
				if int(actor["mp"]) < int(skill.get("mp", 0)):
					_say("Not enough MP.")
					await _pause()
					continue
				var target = await _choose_target(actor, BattleLogic.scope_of(skill))
				if target != null:
					logic.act(actor, "skill", target, skill_id)
					var kind := str(skill.get("type", ""))
					Sound.play(skill_id, "heal" if kind == "heal" else ("magic" if kind == "magic" or kind == "support" else "hit"))
					return
			"Item":
				var ids: Array = Game.inventory.keys().filter(func(id): return _battle_item(Data.items.get(id, {})))
				if ids.is_empty():
					_say("No items to use.")
					await _pause()
					continue
				var labels: Array = ids.map(func(id): return "%s x%d" % [Data.items.get(id, {}).get("name", id), int(Game.inventory[id])])
				var picked = await _choose(labels, true, func(i): return str(Data.items.get(ids[i], {}).get("about", "")))
				if picked == null:
					continue
				var item_id: String = ids[labels.find(picked)]
				var target = await _choose_target(actor, BattleLogic.scope_of(Data.items[item_id]))
				if target != null:
					logic.act(actor, "item", target, item_id)
					Sound.play("hit" if Data.items[item_id].get("effect") == "damage" else "heal")
					return
			"Defend":
				logic.act(actor, "defend")
				return
			"Run":
				logic.act(actor, "run")
				return

static func _battle_item(item: Dictionary) -> bool:
	return not item.has("slot") and item.get("kind", "") != "key" and item.get("effect", "") in ["heal", "mp", "revive", "cure", "damage", "buff"]

## Picks the target for a scope: one enemy, one ally, a fallen ally; everyone and self need no choice.
func _choose_target(actor: Dictionary, scope: String):
	var pool: Array = []
	match scope:
		"all_enemies", "all_allies", "self":
			return actor
		"ko_ally":
			pool = logic.fallen(logic.party)
			if pool.is_empty():
				_say("No one needs reviving.")
				await _pause()
				return null
		"ally":
			pool = logic.alive(logic.party)
		_:
			pool = logic.alive(logic.enemies)
	if pool.size() == 1:
		return pool[0]
	var names: Array = pool.map(func(c): return "%s%s" % [c["name"], status_tags(c)] if c["side"] == "enemy" else "%s %d/%d" % [c["name"], int(c["hp"]), int(c["max_hp"])])
	var picked = await _choose(names, true)
	if picked == null:
		return null
	return pool[names.find(picked)]

## Shows options as buttons and waits for one; null when the player backs out with Esc. describe(i) is shown in the
## message line while option i is highlighted.
func _choose(options: Array, can_cancel := false, describe: Callable = Callable()):
	for child in _menu.get_children():
		child.queue_free()
	for i in options.size():
		var option = options[i]
		var button := Button.new()
		button.text = str(option)
		button.pressed.connect(func(): chosen.emit(option))
		if describe.is_valid():
			button.focus_entered.connect(func(): _log.text = str(describe.call(i)))
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
		Sound.play("cancel")
		chosen.emit(null)

func _finish() -> void:
	var rewards := logic.finish()
	var event := Game.pending_event
	match logic.outcome:
		"won":
			Sound.play("victory")
			Game.gold += int(rewards.get("gold", 0))
			_say("Victory! %d XP, %d gold." % [int(rewards.get("xp", 0)), int(rewards.get("gold", 0))])
			await _pause()
			for item in rewards.get("drops", []):
				Game.add_item(item)
				_say("Found %s!" % Data.items.get(item, {}).get("name", item))
				await _pause()
			for raised in Game.gain_xp(int(rewards.get("xp", 0))):
				Sound.play("levelup")
				var gains: Array = []
				for stat_name in ["hp", "mp", "atk", "def", "mag", "spd"]:
					if int(raised["gains"].get(stat_name, 0)) > 0:
						gains.append("%s+%d" % [stat_name.to_upper(), int(raised["gains"][stat_name])])
				_say("%s reached level %d! %s" % [raised["name"], int(raised["level"]), " ".join(gains)])
				await _pause()
				for skill_name in raised["learned"]:
					_say("%s learned %s!" % [raised["name"], skill_name])
					await _pause()
			Game.set_flag(str(event.get("flag", "")))
		"fled":
			await _pause()
		_:
			if bool(event.get("can_lose", false)):
				_say("The party is beaten back...")
			else:
				Sound.play("defeat")
				_say("The party has fallen...")
			await _pause()
	Game.pending_battle = []
	if autoplay:
		print("AUTOTEST battle: %s" % logic.outcome)
		get_tree().quit(0)
		return
	if logic.outcome == "lost":
		Game.heal_all()
		if bool(event.get("can_lose", false)):
			event["lost"] = true
			Router.overworld()
		else:
			Game.pending_event = {}
			Router.title()
	elif logic.outcome == "won" and bool(event.get("ending", false)):
		Game.pending_event = {}
		await EventRunner.new().run(event.get("then", []))
		Router.go("res://scenes/ending.tscn")
	else:
		if logic.outcome != "won":
			Game.pending_event = {}
		Router.overworld()
