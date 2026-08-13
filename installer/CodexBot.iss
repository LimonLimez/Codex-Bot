#define AppName "Codex Bot"
#define AppVersion "0.1.1"
#define AppPublisher "Codex Bot contributors"
#define AppURL "https://github.com/LimonLimez/Codex-Bot"

[Setup]
AppId={{E76F3A8B-12D0-4F6C-9C73-C11881446E1B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL=https://github.com/LimonLimez/Codex-Bot/issues
AppUpdatesURL=https://github.com/LimonLimez/Codex-Bot/releases
DefaultDirName={localappdata}\Programs\Codex Bot
DefaultGroupName=Codex Bot
DisableProgramGroupPage=yes
OutputDir=..\artifacts
OutputBaseFilename=CodexBot-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
RedirectionGuard=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Codex Bot
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Codex Bot installer
VersionInfoProductName=Codex Bot
SetupIconFile=..\assets\codex-bot.ico
UninstallDisplayIcon={app}\app\Codex Bot.exe

[Files]
Source: "..\src\bridge.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\codex-connection.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\browser-seat-bridge.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-seat-manager.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\public-web-proxy.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-action-approval.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-control-lease.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-page-hardening.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\renderer\codex-ui.js"; DestDir: "{app}\tools\src\renderer"; Flags: ignoreversion
Source: "..\src\renderer\live-seat-component.jsfrag"; DestDir: "{app}\tools\src\renderer"; Flags: ignoreversion
Source: "..\src\runtime\Launch-Codex-Bot.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\CodexBot-Watchdog.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\CodexBot-Hidden-Runner.vbs"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\Local-Service-Identity.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\Enable-Always-On.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\Disable-Always-On.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\scripts\patch-app.cjs"; DestDir: "{app}\tools\scripts"; Flags: ignoreversion
Source: "..\scripts\brand-executable.cjs"; DestDir: "{app}\tools\scripts"; Flags: ignoreversion
Source: "..\scripts\Install-CodexBot.ps1"; DestDir: "{app}\tools\scripts"; Flags: ignoreversion
Source: "..\scripts\Verify-GrokBotRuntime.ps1"; DestDir: "{app}\tools\integrity"; Flags: ignoreversion
Source: "..\scripts\Verify-GrokBotRuntime.ps1"; Flags: dontcopy
Source: "..\assets\grok-bot-0.16.0-windows-x64.manifest.json"; DestDir: "{app}\tools\integrity"; Flags: ignoreversion
Source: "..\assets\grok-bot-0.16.0-windows-x64.manifest.json"; Flags: dontcopy
Source: "..\assets\codex-bot.ico"; DestDir: "{app}\tools\assets"; Flags: ignoreversion
Source: "..\node_modules\*"; DestDir: "{app}\tools\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\vendor\cliproxyapi\cli-proxy-api.exe"; DestDir: "{app}\tools\cliproxyapi"; Flags: ignoreversion
Source: "..\build\vendor\cliproxyapi\LICENSE"; DestDir: "{app}\licenses"; DestName: "CLIProxyAPI-LICENSE.txt"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}\licenses"; DestName: "CodexBotBridge-LICENSE.txt"; Flags: ignoreversion
Source: "..\NOTICE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{code:GetVendorRoot}\*"; DestDir: "{app}\app"; Flags: external ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\app\Codex Bot.exe"
Type: files; Name: "{app}\app\resources\app.codex.asar"
Type: filesandordirs; Name: "{app}\app\resources\app.codex.asar.unpacked"

[Icons]
Name: "{autoprograms}\Codex Bot"; Filename: "{sys}\wscript.exe"; Parameters: "//B //NoLogo ""{app}\tools\runtime\CodexBot-Hidden-Runner.vbs"" launcher"; WorkingDir: "{app}"
Name: "{autodesktop}\Codex Bot"; Filename: "{sys}\wscript.exe"; Parameters: "//B //NoLogo ""{app}\tools\runtime\CodexBot-Hidden-Runner.vbs"" launcher"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce

[Run]
Filename: "{sys}\wscript.exe"; Parameters: "//B //NoLogo ""{app}\tools\runtime\CodexBot-Hidden-Runner.vbs"" launcher"; Description: "Launch Codex Bot"; Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\tools\runtime\Disable-Always-On.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "DisableCodexBotBridge"

[UninstallDelete]
Type: files; Name: "{app}\app\Codex Bot.exe"

[Code]
var
  VendorPage: TInputDirWizardPage;
  InstallExitCode: Integer;
  RemoveUserDataOnUninstall: Boolean;

function GetVendorRoot(Param: String): String;
begin
  Result := VendorPage.Values[0];
end;

procedure InitializeWizard;
var
  RequestedVendorRoot: String;
begin
  InstallExitCode := 0;
  VendorPage := CreateInputDirPage(
    wpSelectDir,
    'Locate your installed Grok Bot',
    'Codex Bot uses your own local Grok Bot 0.16.0 frontend.',
    'Select the folder containing Grok Bot.exe. The original installation is not modified and is not included in this installer.',
    False,
    ''
  );
  VendorPage.Add('');
  RequestedVendorRoot := ExpandConstant('{param:GROKBOTDIR|}');
  if RequestedVendorRoot = '' then
    RequestedVendorRoot := ExpandConstant('{commonpf}\Grok Bot');
  VendorPage.Values[0] := RequestedVendorRoot;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := InstallExitCode;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Parameters: String;
  VerifierPath: String;
  ManifestPath: String;
begin
  Result := '';
  ExtractTemporaryFile('Verify-GrokBotRuntime.ps1');
  ExtractTemporaryFile('grok-bot-0.16.0-windows-x64.manifest.json');
  VerifierPath := ExpandConstant('{tmp}\Verify-GrokBotRuntime.ps1');
  ManifestPath := ExpandConstant('{tmp}\grok-bot-0.16.0-windows-x64.manifest.json');
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    VerifierPath + '" -InstallRoot "' + VendorPage.Values[0] +
    '" -ManifestPath "' + ManifestPath + '"';
  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Parameters,
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then
  begin
    InstallExitCode := 1;
    Result := 'Could not start the supported Grok Bot integrity check.';
  end
  else if ResultCode <> 0 then
  begin
    InstallExitCode := ResultCode;
    Result := 'The selected folder is not the exact supported, signed Grok Bot 0.16.0 Windows x64 installation. No files were installed and the original installation was not changed.';
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  VendorExe: String;
  VendorAsar: String;
begin
  Result := True;
  if CurPageID = VendorPage.ID then
  begin
    VendorExe := AddBackslash(VendorPage.Values[0]) + 'Grok Bot.exe';
    VendorAsar := AddBackslash(VendorPage.Values[0]) + 'resources\app.asar';
    if not FileExists(VendorExe) or not FileExists(VendorAsar) then
    begin
      MsgBox('That folder does not contain a complete Grok Bot installation.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Parameters: String;
begin
  if CurStep = ssPostInstall then
  begin
    Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\tools\scripts\Install-CodexBot.ps1') +
      '" -InstallRoot "' + ExpandConstant('{app}') + '"';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      InstallExitCode := 1;
      RaiseException('Could not start the Codex Bot installation step.');
    end;
    if ResultCode <> 0 then
    begin
      InstallExitCode := ResultCode;
      RaiseException(Format('Codex Bot patching failed (exit code %d). The original Grok Bot installation was not changed.', [ResultCode]));
    end;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  RemoveUserDataOnUninstall := False;
  if not UninstallSilent then
    RemoveUserDataOnUninstall := MsgBox(
      'Also permanently delete Codex Bot conversations, account sign-ins, browser profiles, downloads, and local settings?' + #13#10 + #13#10 +
      'Choose No to keep that data for a future reinstall.',
      mbConfirmation,
      MB_YESNO
    ) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  StateRoot: String;
  LocalAppDataRoot: String;
begin
  if (CurUninstallStep = usPostUninstall) and RemoveUserDataOnUninstall then
  begin
    StateRoot := AddBackslash(ExpandConstant('{localappdata}\Codex Bot Bridge'));
    LocalAppDataRoot := AddBackslash(ExpandConstant('{localappdata}'));
    if Pos(Uppercase(LocalAppDataRoot), Uppercase(StateRoot)) = 1 then
      DelTree(StateRoot, True, True, True);
  end;
end;
