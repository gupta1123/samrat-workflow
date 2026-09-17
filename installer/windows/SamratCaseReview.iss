#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName "Samrat Case Review"
#define Publisher "Samrat Group"
#define InstallerRevision "5"

[Setup]
AppId={{77E7DEB8-7B84-42E5-9D8D-77A14562271D}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion} (Installer {#InstallerRevision})
AppPublisher={#Publisher}
DefaultDirName={commonappdata}\Samrat Case Review
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=Samrat-Case-Review-Setup-{#AppVersion}-Installer{#InstallerRevision}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}.{#InstallerRevision}

[Files]
; Keep prerequisite scripts before the large solid-compressed image payload.
Source: "scripts\DockerEnvironment.ps1"; Flags: dontcopy
Source: "scripts\Test-DockerSetup.ps1"; Flags: dontcopy
Source: "runtime\*"; DestDir: "{app}\runtime"; Excludes: "supabase\.env,supabase\volumes\db\data\*,supabase\volumes\storage\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "database\*"; DestDir: "{app}\database"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "payload\*"; DestDir: "{app}\payload"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Open Samrat Case Review"; Filename: "http://localhost:8888"
Name: "{group}\Start Samrat"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Start-Samrat.ps1"""
Name: "{group}\Stop Samrat"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Stop-Samrat.ps1"""
Name: "{group}\Samrat Status"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Status-Samrat.ps1"""
Name: "{group}\Backup Samrat"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Backup-Samrat.ps1"""
Name: "{group}\Add Samrat User"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Add-SamratUser.ps1"""
Name: "{group}\Repair OpenRouter Key"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Repair-OpenRouterKey.ps1"""
Name: "{group}\Samrat Installation Guide"; Filename: "{app}\README.md"
Name: "{commondesktop}\Samrat Case Review"; Filename: "http://localhost:8888"

[Run]
; Keep the result visible on failure. Close this window after setup finishes.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Install-Samrat.ps1"""; Description: "Configure and start Samrat Case Review"; Flags: postinstall waituntilterminated skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Uninstall-Samrat.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopSamratContainers"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Details: AnsiString;
  DetailsPath: String;
begin
  Result := '';
  ExtractTemporaryFile('DockerEnvironment.ps1');
  ExtractTemporaryFile('Test-DockerSetup.ps1');
  DetailsPath := ExpandConstant('{tmp}\samrat-docker-check.txt');
  DeleteFile(DetailsPath);
  Log('Checking Docker engine and Compose (supports all-users and per-user Docker Desktop).');
  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Test-DockerSetup.ps1') + '" -OutputPath "' + DetailsPath + '"',
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Result := 'Windows could not start the Docker prerequisite check. Check that PowerShell is available and permitted by your organisation.';
    exit;
  end;
  if ResultCode <> 0 then
  begin
    if LoadStringFromFile(DetailsPath, Details) then
      Result := UTF8Decode(Details)
    else
      Result := 'The Docker check failed. Open Docker Desktop, wait for Engine running, and retry. You can run scripts\Test-DockerSetup.ps1 from the build kit to see more details.';
    if Trim(Result) = '' then
      Result := 'The Docker prerequisite check failed without diagnostic details. Run 02-CHECK-DOCKER.cmd from the build kit and share its output.';
    Log(Result);
  end;
end;
