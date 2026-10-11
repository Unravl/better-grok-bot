# Better Grok Bot installer for Windows.
#
#   irm https://raw.githubusercontent.com/Unravl/better-grok-bot/main/install.ps1 | iex
#
# Downloads the `bgb` release archive for this architecture, verifies it against the release's
# SHA256SUMS and runs `bgb setup`, which installs it into %LOCALAPPDATA%\BetterGrokBot.
#
# Environment:
#   BGB_VERSION         release to install (`1.2.3` or `v1.2.3`); default: latest
#   BGB_SETUP_ARGS      extra arguments for `bgb setup` (e.g. `--no-autostart`)
#   BGB_NONINTERACTIVE  set to run `bgb setup --yes --no-restart` without prompts
#   BGB_LOCAL_ARCHIVE + BGB_LOCAL_SUMS  install a local archive instead of downloading (CI)

# A script block keeps variables out of the caller's session under `irm | iex`, and errors are
# thrown instead of calling `exit`, which would close that session's window.
& {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'
	$repo = 'Unravl/better-grok-bot'

	# 32-bit PowerShell on 64-bit Windows reports the real architecture in PROCESSOR_ARCHITEW6432.
	$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
	$name = "bgb-windows-$arch.zip"
	$version = if ($env:BGB_VERSION) { $env:BGB_VERSION } else { 'latest' }
	if ($version -eq 'latest') {
		$base = "https://github.com/$repo/releases/latest/download"
	} else {
		$tag = if ($version.StartsWith('v')) { $version } else { "v$version" }
		$base = "https://github.com/$repo/releases/download/$tag"
	}

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('bgb-install-' + [Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		$archive = Join-Path $tmp $name
		$sums = Join-Path $tmp 'SHA256SUMS'
		if ($env:BGB_LOCAL_ARCHIVE -and $env:BGB_LOCAL_SUMS) {
			Copy-Item -LiteralPath $env:BGB_LOCAL_ARCHIVE -Destination $archive
			Copy-Item -LiteralPath $env:BGB_LOCAL_SUMS -Destination $sums
		} else {
			[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
			Write-Host "Downloading $name ($version)..."
			Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $archive
			Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
		}

		$expected = $null
		foreach ($line in Get-Content -LiteralPath $sums) {
			if ($line -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2].Trim() -eq $name) {
				$expected = $Matches[1].ToLowerInvariant()
				break
			}
		}
		if (-not $expected) { throw "SHA256SUMS has no entry for $name" }
		$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
		if ($actual -ne $expected) { throw "checksum mismatch for $name" }

		Expand-Archive -LiteralPath $archive -DestinationPath $tmp -Force
		$bgb = Join-Path $tmp 'bgb.exe'
		if (-not (Test-Path -LiteralPath $bgb)) { throw "$name does not contain bgb.exe" }

		$nonInteractive = [bool]$env:BGB_NONINTERACTIVE -or [Console]::IsInputRedirected -or -not [Environment]::UserInteractive
		$setupArgs = @()
		if ($nonInteractive) { $setupArgs += '--yes', '--no-restart' }
		$setupArgs += @($env:BGB_SETUP_ARGS -split ' ' | Where-Object { $_ })
		& $bgb setup @setupArgs
		if ($LASTEXITCODE -ne 0) { throw "bgb setup failed (exit code $LASTEXITCODE)" }
	} finally {
		Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
	}
}
