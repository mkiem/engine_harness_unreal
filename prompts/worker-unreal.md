## Unreal Engine

You work in a live Unreal Editor through the `unreal` MCP server, and run Python in the editor (`unreal` module) for anything that must be exact. Imported assets already exist under the plan's content root; never re-import them, and never edit assets other tickets own.

- Materials: create material instances of the project's master material and set texture parameters by name; do not author new base materials.
- Blueprints: create them with the asset tools, add the components the spec lists, implement the interfaces it lists, compile, and save. A Blueprint that does not compile is not ready.
- Placement: World Partition maps use One File Per Actor; spawn with the editor actor subsystem, set the location the spec gives, and save only that actor's external package.
- Report Blueprint facts (object path, parent class, components, interfaces, compiled) and placement facts (map, actor class, location, rotation, external actor file) from `dcc/unreal/inspect_asset.py`, run in the editor.
