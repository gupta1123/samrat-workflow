# Samrat Case Review — Windows local-server installer

This package installs Samrat Case Review and its private Supabase backend on a
dedicated Windows 10/11 x64 office computer. PostgreSQL data, user accounts,
and uploaded documents stay on that computer.

AI review is not offline: uploaded document content is sent through OpenRouter
to the configured Gemini model. An internet connection and an active
OpenRouter account are required for analysis.

## Client computer requirements

- Windows 10 or Windows 11, 64-bit, with virtualisation enabled
- Docker Desktop using the WSL 2 Linux engine
- 16 GB RAM recommended (8 GB minimum for light use)
- 20 GB free disk space initially, plus room for cases and backups
- Internet access during first installation and for Gemini analysis
- A private office network profile if other office computers will connect

Docker Desktop has separate commercial licensing terms. Confirm that the
client organisation qualifies for free use or purchase the required licence.

## Installation

1. Install and start Docker Desktop. Wait until it reports that the engine is running.
2. Run `Samrat-Case-Review-Setup-<version>.exe` as an administrator.
3. Keep **Configure and start Samrat Case Review** checked at the end.
4. Paste the OpenRouter API key when requested.
5. Enter the email and password for the first Samrat administrator.
6. Sign in at `http://localhost:8888`.

From other computers on the same private office network, use
`http://WINDOWS-PC-NAME:8888`. Windows Firewall access is limited to the local
subnet and private network profile.

## Operations

The Start menu folder contains actions to start, stop, inspect, and back up
Samrat. Backups are written to `Documents\Samrat Backups` by default. Each
backup contains a consistent PostgreSQL dump and all uploaded documents.

To restore, run PowerShell as administrator:

```powershell
& "C:\ProgramData\Samrat Case Review\scripts\Restore-Samrat.ps1" -BackupFolder "C:\path\to\samrat-YYYYMMDD-HHMMSS"
```

Uninstalling removes the containers and shortcuts but preserves database and
document files. Full data deletion is available only through
`Uninstall-Samrat.ps1 -RemoveData` and requires typing a destructive-action
confirmation.

## Release build

On a Windows release machine with Docker Desktop and Inno Setup 6:

```powershell
cd installer\windows
.\Build-Installer.ps1 -Version 1.0.0
```

The build creates Linux/AMD64 web and worker images, saves them into the
installer payload, records a SHA-256 checksum that is verified before install
or update, and compiles the setup EXE into `output`.

If the verified image payload is already present (as it is in the prepared
release kit), the Windows machine only needs Inno Setup for the final compile:

```powershell
.\Build-Installer.ps1 -Version 1.0.0 -SkipImages
```

For client distribution, sign the generated EXE with the organisation's
Windows code-signing certificate. Windows SmartScreen can warn users about an
unsigned installer even when its contents are valid.

The Supabase runtime is pinned to `self-hosted/v0.8.0`; see
`runtime\supabase\OFFICIAL_SOURCE.md` for its exact source commit.
