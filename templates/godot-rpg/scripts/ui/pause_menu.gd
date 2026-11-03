extends CanvasLayer
## Esc on the map opens this: items, equipment, skills that work outside battle (healing, curing), each member's
## status, the party line-up (members in reserve), quests, saving into one of three slots, and back to the title.
## Lists show details of the highlighted entry on the right.

signal closed
signal chosen(index: int)

var _panel: PanelContainer
var _info: Label
var _buttons: VBoxContainer
var _title: Label
var open := false

func _ready() -> void:
	layer = 20
	_panel = PanelContainer.new()
	_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	_panel.offset_left = 6
	_panel.offset_top = 6
	_panel.offset_right = -6
	_panel.offset_bottom = -6
	add_child(_panel)
	var column := VBoxContainer.new()
	_panel.add_child(column)
	_title = Label.new()
	column.add_child(_title)
	var row := HBoxContainer.new()
	row.size_flags_vertical = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("separation", 8)
	column.add_child(row)
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(118, 0)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	row.add_child(scroll)
	_buttons = VBoxContainer.new()
	_buttons.add_theme_constant_override("separation", 0)
	_buttons.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_buttons)
	_info = Label.new()
	_info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_info.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	row.add_child(_info)
	_panel.visible = false

func show_menu() -> void:
	open = true
	_panel.visible = true
	Sound.play("select")
	_main()

func close() -> void:
	open = false
	_panel.visible = false
	chosen.emit(-1)
	closed.emit()

## Offers a list; answers the index, or -1 for Esc. describe(i) fills the right side while option i is highlighted.
func _choose(title: String, options: Array, describe: Callable = Callable()) -> int:
	_title.text = title
	for child in _buttons.get_children():
		_buttons.remove_child(child)
		child.queue_free()
	for i in options.size():
		var button := Button.new()
		button.text = str(options[i])
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.pressed.connect(func(): chosen.emit(i))
		if describe.is_valid():
			button.focus_entered.connect(func(): _info.text = str(describe.call(i)))
		_buttons.add_child(button)
	await get_tree().process_frame
	if _buttons.get_child_count() > 0:
		(_buttons.get_child(0) as Button).grab_focus()
	var index: int = await chosen
	if index >= options.size():
		index = -1
	Sound.play("select" if index >= 0 else "cancel")
	return index

## Shows a message with a single OK, so nothing else can be pressed while it is up.
func _notice(text: String) -> void:
	await _choose(_title.text, ["OK"], func(_i): return text)

func _main() -> void:
	while open:
		var options := ["Items", "Equip", "Skills", "Status", "Party", "Quests", "Save", "Title", "Close"]
		var index := await _choose("Gold %d   Time %s" % [Game.gold, Game.time_text(Game.play_time)], options, func(_i): return _party_text())
		if not open:
			return
		match index:
			0: await _items()
			1: await _equip()
			2: await _skills()
			3: await _status()
			4: await _line_up()
			5: await _quests()
			6: await _save()
			7:
				close()
				Router.title()
				return
			_:
				close()
				return

func _party_text() -> String:
	var lines: Array = []
	for member in Game.party:
		lines.append("%s  Lv %d%s" % [Game.member_name(member), int(member["level"]), "  (down)" if int(member["hp"]) <= 0 else ""])
		lines.append("  HP %d/%d  MP %d/%d%s" % [int(member["hp"]), Game.stat(member, "hp"), int(member["mp"]), Game.stat(member, "mp"), _statuses(member)])
	if not Game.reserve.is_empty():
		lines.append("Reserve: " + ", ".join(Game.reserve.map(func(m): return Game.member_name(m))))
	return "\n".join(lines)

func _statuses(member: Dictionary) -> String:
	var names: Array = member.get("status", []).map(func(s): return Data.statuses.get(s, {}).get("name", s))
	return "  " + ", ".join(names) if not names.is_empty() else ""

## Picks a member of the active party; -1 for Esc.
func _pick_member(title: String, describe: Callable = Callable()) -> int:
	var names: Array = Game.party.map(func(m): return "%s %d/%d" % [Game.member_name(m), int(m["hp"]), Game.stat(m, "hp")])
	return await _choose(title, names, describe if describe.is_valid() else func(_i): return _party_text())

func _items() -> void:
	while open:
		var ids: Array = Game.inventory.keys()
		ids.sort_custom(func(a, b): return _item_order(a) < _item_order(b))
		if ids.is_empty():
			await _notice("No items.")
			return
		var labels: Array = ids.map(func(id): return "%s x%d" % [Data.items.get(id, {}).get("name", id), int(Game.inventory[id])])
		var index := await _choose("Items", labels, func(i): return _item_text(ids[i]))
		if index < 0:
			return
		var item: Dictionary = Data.items.get(ids[index], {})
		if not Game.field_usable(item):
			await _notice("That can't be used here." if not item.has("slot") else "Equip it from the Equip menu.")
			continue
		var who := await _pick_member("Use %s on?" % item.get("name", ids[index]))
		if who < 0:
			continue
		var text := Game.use_item(ids[index], Game.party[who])
		Sound.play("heal" if text != "" else "cancel")
		await _notice(text if text != "" else "It has no effect.")

func _item_order(id: String) -> String:
	var item: Dictionary = Data.items.get(id, {})
	return ("2" if item.get("kind", "") == "key" else "1" if item.has("slot") else "0") + str(item.get("name", id))

func _item_text(id: String) -> String:
	var item: Dictionary = Data.items.get(id, {})
	var kind := "Key item" if item.get("kind", "") == "key" else ("%s" % str(item.get("slot", "")).capitalize() if item.has("slot") else "Item")
	return "%s\n%s\n%s" % [item.get("name", id), kind, item.get("about", "")]

func _equip() -> void:
	while open:
		var who := await _pick_member("Equip whom?", func(i): return _member_text(Game.party[i]))
		if who < 0:
			return
		var member: Dictionary = Game.party[who]
		while open:
			var slots: Array = Game.EQUIP_SLOTS.map(func(s): return "%s: %s" % [s.capitalize(), Data.items.get(member["equipment"].get(s, ""), {}).get("name", "-")])
			var index := await _choose("%s's equipment" % Game.member_name(member), slots + ["Optimize"], func(_i): return _member_text(member))
			if index < 0:
				break
			if index == slots.size():
				Game.best_equipment(member)
				Sound.play("select")
				continue
			var slot_name: String = Game.EQUIP_SLOTS[index]
			var choices: Array = Game.inventory.keys().filter(func(id): return Data.items.get(id, {}).get("slot", "") == slot_name and Game.can_equip(member, id))
			var labels: Array = choices.map(func(id): return Data.items[id].get("name", id)) + ["(Remove)"]
			var pick := await _choose("%s: %s" % [Game.member_name(member), slot_name.capitalize()], labels, func(i): return _compare(member, slot_name, choices[i] if i < choices.size() else ""))
			if pick < 0:
				continue
			Game.equip(member, slot_name, choices[pick] if pick < choices.size() else "")

func _member_text(member: Dictionary) -> String:
	var lines: Array = ["%s  Lv %d  (%s)" % [Game.member_name(member), int(member["level"]), Data.characters.get(member["id"], {}).get("role", "")],
		"HP %d/%d  MP %d/%d" % [int(member["hp"]), Game.stat(member, "hp"), int(member["mp"]), Game.stat(member, "mp")],
		"ATK %d  DEF %d  MAG %d  SPD %d" % [Game.stat(member, "atk"), Game.stat(member, "def"), Game.stat(member, "mag"), Game.stat(member, "spd")]]
	var traits := Game.gear_traits(member)
	if str(traits["element"]) != "":
		lines.append("Weapon element: %s" % traits["element"])
	if not traits["resist"].is_empty():
		lines.append("Resists: %s" % ", ".join(traits["resist"]))
	if not traits["immune"].is_empty():
		lines.append("Immune: %s" % ", ".join(traits["immune"].map(func(s): return Data.statuses.get(s, {}).get("name", s))))
	return "\n".join(lines)

## What equipping `item_id` (or removing, with "") in a slot would change.
func _compare(member: Dictionary, slot_name: String, item_id: String) -> String:
	var current := str(member["equipment"].get(slot_name, ""))
	var lines: Array = [str(Data.items.get(item_id, {}).get("about", "Take it off."))]
	for stat_name in ["hp", "mp", "atk", "def", "mag", "spd"]:
		var now := Game.stat(member, stat_name)
		var delta := int(Data.items.get(item_id, {}).get("stats", {}).get(stat_name, 0)) - int(Data.items.get(current, {}).get("stats", {}).get(stat_name, 0))
		if delta != 0:
			lines.append("%s %d -> %d" % [stat_name.to_upper(), now, now + delta])
	return "\n".join(lines)

func _skills() -> void:
	while open:
		var who := await _pick_member("Whose skills?", func(i): return _skill_list(Game.party[i]))
		if who < 0:
			return
		var caster: Dictionary = Game.party[who]
		var ids: Array = Game.skills_for(caster)
		var labels: Array = ids.map(func(id): return "%s %d" % [Data.skills.get(id, {}).get("name", id), int(Data.skills.get(id, {}).get("mp", 0))])
		var index := await _choose("%s's skills (MP %d)" % [Game.member_name(caster), int(caster["mp"])], labels, func(i): return str(Data.skills.get(ids[i], {}).get("about", "")))
		if index < 0:
			continue
		var skill: Dictionary = Data.skills.get(ids[index], {})
		if not Game.field_usable(skill) or int(caster["hp"]) <= 0:
			await _notice("That only works in battle." if int(caster["hp"]) > 0 else "%s is down." % Game.member_name(caster))
			continue
		var target := await _pick_member("Use %s on?" % skill.get("name", ids[index]))
		if target < 0:
			continue
		var text := Game.use_skill(caster, ids[index], Game.party[target])
		Sound.play("heal" if text != "" else "cancel")
		await _notice(text if text != "" else "It has no effect (or not enough MP).")

func _skill_list(member: Dictionary) -> String:
	return "\n".join(Game.skills_for(member).map(func(id): return "%s (%d MP): %s" % [Data.skills.get(id, {}).get("name", id), int(Data.skills.get(id, {}).get("mp", 0)), Data.skills.get(id, {}).get("about", "")]))

func _status() -> void:
	while open:
		var everyone: Array = Game.party + Game.reserve
		var labels: Array = everyone.map(func(m): return Game.member_name(m) + ("" if Game.party.has(m) else " (reserve)"))
		var index := await _choose("Status", labels, func(i): return _member_text(everyone[i]) + "\nXP to next level: %d" % (Game.xp_for_level(int(everyone[i]["level"])) - int(everyone[i]["xp"])) + "\n" + _statuses(everyone[i]))
		if index < 0:
			return

func _line_up() -> void:
	while open:
		if Game.reserve.is_empty():
			await _notice("No one is waiting in reserve. Party members join through the story; up to %d travel together." % int(Game.rule("max_party", 4)))
			return
		var labels: Array = Game.party.map(func(m): return Game.member_name(m))
		if Game.party.size() < int(Game.rule("max_party", 4)):
			labels.append("(empty)")
		var out := await _choose("Swap out whom?", labels, func(_i): return _party_text())
		if out < 0:
			return
		var incoming: Array = Game.reserve.map(func(m): return "%s Lv %d" % [Game.member_name(m), int(m["level"])])
		var into := await _choose("Bring in whom?", incoming, func(i): return _member_text(Game.reserve[i]))
		if into >= 0:
			Game.swap(out, into)

func _quests() -> void:
	var ids: Array = Game.quests.keys()
	if ids.is_empty():
		await _notice("No quests yet. People in need will ask for your help.")
		return
	ids.sort_custom(func(a, b): return Game.quest_stage(a) != "done" and Game.quest_stage(b) == "done")
	var labels: Array = ids.map(func(id): return ("[done] " if Game.quest_stage(id) == "done" else "") + str(Data.quests.get(id, {}).get("name", id)))
	await _choose("Quests", labels, func(i): return str(Data.quests.get(ids[i], {}).get("stages", {}).get(Game.quest_stage(ids[i]), "")))

func _save() -> void:
	var labels: Array = []
	for number in range(1, Game.SLOTS + 1):
		labels.append("Slot %d: %s" % [number, Game.slot_summary(number)])
	var index := await _choose("Save to which slot?", labels)
	if index < 0:
		return
	Sound.play("select")
	await _notice("Saved to slot %d." % (index + 1) if Game.save_game(index + 1) else "Could not save.")

func _unhandled_input(event: InputEvent) -> void:
	if open and event.is_action_pressed("ui_cancel"):
		get_viewport().set_input_as_handled()
		chosen.emit(-1)
