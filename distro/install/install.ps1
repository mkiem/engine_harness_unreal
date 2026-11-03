# Sets up the Game Harness on this Windows machine for goose (stock goose today, the studio build later):
#   - installs the harness's dependencies,
#   - puts a `harness-mcp` launcher on your PATH, which the bundled Game Harness extension and the recipes run,
#   - points goose at the game-dev recipes, and installs the game studio's skills in ~\.agents\skills,
#   - checks for uv (Blender extension) and Blender.
# Run from the repository:  powershell -ExecutionPolicy Bypass -File distro\install\install.ps1
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Need-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js 22.18 or later is required: winget install OpenJS.NodeJS.LTS, then open a new terminal.' }
  $version = [version]((& node --version).TrimStart('v'))
  if ($version -lt [version]'22.18.0') { throw "Node.js $version is too old; 22.18 or later runs the harness's TypeScript directly." }
}

Need-Node
Write-Host "Installing harness dependencies in $root"
Push-Location $root
try { & npm ci --omit=dev --no-audit --no-fund | Out-Host } finally { Pop-Location }

$bin = Join-Path $env:LOCALAPPDATA 'GameHarness\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$launcher = Join-Path $bin 'harness-mcp.cmd'
Set-Content -Path $launcher -Encoding ASCII -Value "@echo off`r`nnode `"$root\src\mcp\main.ts`" %*"
$cli = Join-Path $bin 'harness.cmd'
Set-Content -Path $cli -Encoding ASCII -Value "@echo off`r`nnode `"$root\src\cli.ts`" %*"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $bin })) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$bin"), 'User')
  Write-Host "Added $bin to your PATH (open a new terminal, and restart goose, to pick it up)"
}

$recipes = Join-Path $root 'distro\recipes'
$recipePath = [Environment]::GetEnvironmentVariable('GOOSE_RECIPE_PATH', 'User')
if (-not $recipePath) { $recipePath = $recipes }
elseif (-not ($recipePath -split ';' | Where-Object { $_ -eq $recipes })) { $recipePath = "$recipePath;$recipes" }
[Environment]::SetEnvironmentVariable('GOOSE_RECIPE_PATH', $recipePath, 'User')

# The game studio's skills, where goose (and other agents) read skills: ~/.agents/skills.
$skills = Join-Path $HOME '.agents\skills'
New-Item -ItemType Directory -Force -Path $skills | Out-Null
foreach ($dir in Get-ChildItem (Join-Path $root 'skills') -Directory) {
  $target = Join-Path $skills $dir.Name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse $dir.FullName $target
}
Write-Host "Game studio skills installed in $skills"

Write-Host ''
Write-Host 'Checks:'
if (Get-Command uvx -ErrorAction SilentlyContinue) { Write-Host '  ok   uvx (runs the Blender extension)' }
else { Write-Host '  todo uvx not found: winget install astral-sh.uv  (the Blender extension runs through it)' }
$blender = Get-ChildItem 'C:\Program Files\Blender Foundation' -Filter blender.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($blender) { Write-Host "  ok   Blender at $($blender.FullName)" }
else { Write-Host '  todo Blender not found under C:\Program Files\Blender Foundation' }
Write-Host '  todo In Blender, install the blender-mcp addon (addon.py from https://github.com/ahujasid/blender-mcp),'
Write-Host '       then in the 3D view sidebar (N) open the BlenderMCP tab and click Connect.'
Write-Host '  todo For Unreal, install an MCP plugin in your project and enable the "Unreal Editor" extension in goose.'
Write-Host ''
Write-Host "Done. Launcher: $launcher. Recipes: $recipes"
