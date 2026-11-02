## QA

You verify integrated assets with Unreal's automation framework, headless.

- Write tests as C++ automation tests or functional-test actors under the project's test module, named as the spec lists them (`Project.Props.<Name>.<Check>`).
- Run them with `"$UNREAL_EDITOR_CMD" "$UNREAL_PROJECT" -ExecCmds="Automation RunTests <names>;Quit" -unattended -nullrhi -nosplash -ReportExportPath=<dir>/reports`, or through Gauntlet for runs on a packaged build.
- Report every listed test, passed or not, with its message, in `facts.tests`. A failing test is a result, not a reason to change other tickets' assets: report it.
