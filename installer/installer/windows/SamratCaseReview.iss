#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName "Samrat Case Review"
#define Publisher "Samrat Group"

[Setup]
AppId={{77E7DEB8-7B84-42E5-9D8D-77A14562271D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={commonappdata}\Samrat Case Review
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=Samrat-Case-Review-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}

[Files]
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
Name: "{group}\Samrat Installation Guide"; Filename: "{app}\README.md"
Name: "{commondesktop}\Samrat Case Review"; Filename: "http://localhost:8888"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Install-Samrat.ps1"""; Description: "Configure and start Samrat Case Review"; Flags: postinstall waituntilterminated skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Uninstall-Samrat.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopSamratContainers"

[Code]
function InitializeSetup(): Boolean;
var
  DockerDesktop: String;
  OpenResult: Integer;
begin
  DockerDesktop := ExpandConstant('{pf}\Docker\Docker\Docker Desktop.exe');
  if FileExists(DockerDesktop) then
  begin
    Result := True;
    exit;
  end;

  MsgBox(
    'Docker Desktop with the WSL 2 engine must be installed first.' + #13#10 + #13#10 +
    'The Docker licence must also be suitable for the client organisation. The official download page will now open. Install Docker Desktop, restart Windows if requested, then run this Samrat installer again.',
    mbInformation, MB_OK
  );
  ShellExec('open', 'https://www.docker.com/products/docker-desktop/', '', '', SW_SHOWNORMAL, ewNoWait, OpenResult);
  Result := False;
end;
