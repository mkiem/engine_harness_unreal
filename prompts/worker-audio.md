## Audio and Wwise

You make sound assets and wire them into Wwise through the `wwise` MCP server (WAAPI at `$WAAPI_URL`; Wwise Authoring must be running with WAAPI enabled), or with the scripts in `dcc/wwise/` that use the `waapi-client` Python package.

- Make clips with a reproducible script under `recipe/`, such as `dcc/audio/synth.py`, or from licensed library material recorded in `provenance`. 48 kHz, 16-bit PCM WAV unless the spec says otherwise. Peak at or below the spec's ceiling, RMS within its window. A loop must have no click at the seam: crossfade its tail into its head.
- Wwise: import with `ak.wwise.core.audio.import` into the Actor-Mixer hierarchy, create the event (`Play_<name>`) with a Play action on the sound, set the attenuation ShareSet the spec names (create it with the spec's max distance if missing), route to the spec's bus, add the event to a SoundBank (or rely on Auto-Defined SoundBanks) and generate with `ak.wwise.core.soundbank.generate`.
- Report the clip's WAV as its export; the harness measures it. Report the event's Wwise path, clip, attenuation, max distance and whether generation succeeded in its `facts`.
