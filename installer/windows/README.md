# Samrat Case Review — Windows local-server installer

> **Release builder notice:** this folder contains the installer source and
> prepared application payload. It is not itself the client installer. Files
> ending in `.iss` and `.ps1` are expected to open as text/source files. On a
> Windows release machine, install Inno Setup 6 and double-click
> `01-BUILD-INSTALLER.cmd`. Give the client only the generated
> `output\Samrat-Case-Review-Setup-1.0.0-Installer5.exe` file.

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
2. Run `Samrat-Case-Review-Setup-<version>-Installer5.exe` as an administrator.
3. Keep **Configure and start Samrat Case Review** checked at the end.
4. Paste the OpenRouter API key when requested.
5. Enter the email and password for the first Samrat administrator.
6. Sign in at `http://localhost:8888`.
7. Close the PowerShell configuration window once it says Samrat is ready.
   The window stays open if setup fails, so the error remains visible.

From other computers on the same private office network, use
`http://WINDOWS-PC-NAME:8888`. Windows Firewall access is limited to the local
subnet and private network profile.

Installer 5 supports Docker Desktop's all-users and per-user installations,
registered custom folders, and discovery through its running app or CLI. Before
copying application files it checks the actual Linux engine and Docker Compose.
Run `02-CHECK-DOCKER.cmd` in the build kit to see the same read-only checks.
Docker installed but stopped, Windows container mode, and missing Compose are
reported separately. If UAC uses a different administrator account, that account
also needs access to Docker; test under the same account as setup.

Installer 5 normalizes and validates the pasted OpenRouter API key before it is
written to Docker's environment. Hidden clipboard characters are rejected with
an actionable prompt. Existing installations can use the **Repair OpenRouter
Key** Start-menu action; it replaces only that key, recreates the app containers,
and verifies the key through OpenRouter's authenticated key endpoint.

Installer 5 also fixes PostgreSQL filename substitution in both migration-history
queries. The installer now checks and records applied migrations through psql's
standard input, which supports its quoted variables. Existing data and recorded
migrations are kept. See `MIGRATION-FIX.txt` to repair an Installer 2 installation
without rebuilding application images or resetting the database.

The Supabase Auth readiness check now supplies the local anonymous API key
required by the default Envoy gateway. The key is read from the private `.env`
file and is never printed. Without that header, a healthy gateway returns 401
and older setup scripts incorrectly wait until timeout. See
`HEALTH-CHECK-FIX.txt` to repair an existing test installation.

An older EXE that says Docker is missing while Docker shows **Engine running**
needs rebuilding with this revision. Do not reset WSL or delete Docker data.
See `DOCKER-DETECTION-FIX.txt` for the small-patch instructions.

## Operations

The Start menu folder contains actions to start, stop, inspect, and back up
Samrat. Use **Add Samrat User** whenever another employee needs a login.
Backups are written to `Documents\Samrat Backups` by default. Each backup
contains a consistent PostgreSQL dump and all uploaded documents.

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

For the prepared release kit, extract the full ZIP and double-click
`01-BUILD-INSTALLER.cmd`. It verifies the bundled application image, compiles
the setup program, and opens the output folder automatically.

The equivalent PowerShell command is:

```powershell
cd installer\windows
.\Build-Installer.ps1 -Version 1.0.0 -SkipImages
```

To rebuild the Linux application images as well as the setup program:

```powershell
cd installer\windows
.\Build-Installer.ps1 -Version 1.0.0
```

The build creates Linux/AMD64 web and worker images, saves them into the
installer payload, records a SHA-256 checksum that is verified before install
or update, and compiles the setup EXE into `output`.

The prepared release kit already contains the verified image payload, so its
normal one-click build does not rebuild Docker images.

For client distribution, sign the generated EXE with the organisation's
Windows code-signing certificate. Windows SmartScreen can warn users about an
unsigned installer even when its contents are valid.

The Supabase runtime is pinned to `self-hosted/v0.8.0`; see
`runtime\supabase\OFFICIAL_SOURCE.md` for its exact source commit.

## Migration regression checks

`tests/test_migrations.py` exercises first install, rerun with preserved rows,
quoted filenames, failure/retry, missing payload, and the shipped SQL against
PostgreSQL 17. Use a disposable `samrat-migration-regression-*` container with
`--network none`, no published ports, and a tmpfs PostgreSQL data directory.
It refuses containers with persistent or host-mounted storage. Example:

```sh
docker run -d --name samrat-migration-regression-test --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6-alpine
# Wait for pg_isready to succeed before running the tests.
docker exec samrat-migration-regression-test pg_isready -U postgres
python3 installer/windows/tests/test_migrations.py samrat-migration-regression-test
docker rm -f samrat-migration-regression-test
```

The shipped-SQL test provides minimal Auth/Storage schema dependencies; it does
not replace an end-to-end Windows install, login, upload, and review test.
